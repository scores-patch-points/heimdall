#!/usr/bin/env bash
# floor.sh - supervise the local "floor" of The Fold stack with launchd.
#
#   channel  khora/proxy.mjs              11434 (+11436 +11437)
#   mouth    penelope/mouth/server.mjs    11439
#   bridge   heimdall/bin/heimdall.mjs up 8790
#   (Ollama.app on 11435 is NOT managed here; it is only health-checked.)
#
# Usage: floor.sh install [--dry-run] | up | down | status | restart <name>
#                        | logs <name> [-f] | adopt
#
# install writes ~/Library/LaunchAgents/com.fold.<name>.plist and never loads
# anything. `up` is the only thing that bootstraps. Secrets are never baked
# into a plist: each service sources ~/.heimdall/floor.env (0600) at start.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# 3.0/heimdall/scripts -> 3.0
ROOT="${FLOOR_ROOT:-$(cd "$SELF_DIR/../.." && pwd -P)}"
LA_DIR="$HOME/Library/LaunchAgents"
STATE_DIR="$HOME/.heimdall"
LOG_DIR="$STATE_DIR/logs"
ENV_FILE="$STATE_DIR/floor.env"
OLLAMA_URL="http://127.0.0.1:11435/api/tags"
UID_N="$(id -u)"
DOMAIN="gui/$UID_N"
SELF="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"

usage() {
  cat <<EOF
usage: floor.sh <command>

  install [--dry-run] [--without-transitional] [--with-optional]
                        write one launchd plist per service (never loads);
                        --dry-run prints them to stdout instead;
                        --without-transitional skips the bridge (heimdall is
                        moving into the servers); --with-optional adds fold-web
  up                    bootstrap installed services in table order
                        (channel, mouth, bridge, fold-web), then health-check
  down                  bootout in reverse order
  status                port, pid, start time, loaded?, repo/source freshness,
                        whether the service already embeds heimdall
  restart <name>        launchctl kickstart -k   (see the service table)
  logs <name> [-f]      show (or follow) ~/.heimdall/logs/<name>.log
  adopt                 print (never run) the cutover from hand-started node
                        processes to launchd
EOF
}

die() { echo "floor: $*" >&2; exit 2; }

# ---- service table (DATA: add or remove a row, nothing else changes) ---------
# Fields, pipe-separated:
#  name|repo dir under ROOT|runtime|args|probes (port:healthpath ...)|env (a=b;c=d)
#     |transitional(1/0)|optional(1/0)|entry file ("-" none)|stale-watch dirs ("-" none)
# runtime is resolved with `command -v` at install time (absolute path baked in).
# env is plain configuration only (measured from the running processes
# 2026-10-05); secrets belong in ~/.heimdall/floor.env, never in a plist.
# transitional=1: supervised today, but heimdall is to be embedded into the
#   servers above it (every server carries its own heimdall; peers coordinate).
# optional=1: only installed with `install --with-optional`.
# The first probe's port is the service's primary port.
SERVICE_TABLE='
channel|khora|node|proxy.mjs|11434:/api/tags 11436:/health 11437:/health|ER7_OLLAMA_HOSTS=local=http://127.0.0.1:11435;ER7_OPENCODE_URL=http://127.0.0.1:4096;ER7_EXTERNAL_HEIMDALL=1;ER7_FLEET_URL=;NODE_USE_SYSTEM_CA=1|0|0|proxy.mjs|src
mouth|penelope|node|mouth/server.mjs|11439:/v1/mouth/status|PENELOPE_MOUTH_PORT=11439;ER7_CHANNEL_URL=http://127.0.0.1:11434;PENELOPE_FRONTIER_MODEL=claude-sonnet-4-6;NODE_USE_SYSTEM_CA=1|0|0|mouth/server.mjs|src mouth organs
bridge|heimdall|node|bin/heimdall.mjs up --no-open|8790:/health|HEIMDALL_PORT=8790;HEIMDALL_NO_OPEN=1;OLLAMA_HOST=http://127.0.0.1:11434;NODE_USE_SYSTEM_CA=1|1|0|bin/heimdall.mjs|src bin
fold-web|the-fold|python3|-m http.server 8814 --bind 127.0.0.1|8814:/||0|1|-|-
'

names() { printf '%s\n' "$SERVICE_TABLE" | awk -F'|' 'NF>3 {print $1}'; }
rnames() { names | tail -r; }
svc_field() { # name field-number
  printf '%s\n' "$SERVICE_TABLE" | awk -F'|' -v n="$1" -v f="$2" '$1==n {print $f; exit}'
}
valid_name() { [ -n "$1" ] && names | grep -qx "$1"; }
label() { echo "com.fold.$1"; }
plist_path() { echo "$LA_DIR/com.fold.$1.plist"; }
svc_dir() { echo "$ROOT/$(svc_field "$1" 2)"; }
svc_runtime() { svc_field "$1" 3; }
svc_args() { svc_field "$1" 4; }
svc_probes() { svc_field "$1" 5; }
svc_ports() { svc_probes "$1" | tr ' ' '\n' | cut -d: -f1 | tr '\n' ' ' | sed 's/ $//'; }
svc_env() { svc_field "$1" 6 | tr ';' '\n'; }
is_transitional() { [ "$(svc_field "$1" 7)" = 1 ]; }
is_optional() { [ "$(svc_field "$1" 8)" = 1 ]; }
svc_entry() { svc_field "$1" 9; }
svc_watch() { svc_field "$1" 10; }
port_health_path() { # name port
  svc_probes "$1" | tr ' ' '\n' | awk -F: -v p="$2" '$1==p {print $2; exit}'
}
installed_names() { local n; for n in $(names); do [ -f "$(plist_path "$n")" ] && echo "$n"; done; return 0; }
rinstalled_names() { installed_names | tail -r; }

# ---- helpers ----------------------------------------------------------------
xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
http_code() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
fmt_epoch() { if [ -n "${1:-}" ] && [ "$1" != 0 ]; then date -r "$1" '+%Y-%m-%d %H:%M:%S'; else echo "unknown"; fi; }
is_loaded() { launchctl print "$DOMAIN/$(label "$1")" >/dev/null 2>&1; }
listener_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
need_name() { [ -n "${1:-}" ] || die "name required ($(names | tr '\n' ' '))"; valid_name "$1" || die "unknown service '$1' ($(names | tr '\n' ' '))"; }
primary_port() { svc_ports "$1" | awk '{print $1}'; }

runtime_bin() { # runtime name -> absolute path
  local n
  n="$(command -v "$1" || true)"
  [ -n "$n" ] || die "$1 not found on PATH; cannot write an absolute path into plists"
  case "$n" in /*) echo "$n" ;; *) die "$1 resolved to non-absolute '$n'" ;; esac
}

proc_start_epoch() { # pid -> epoch seconds ("" if unknown)
  local ls
  ls="$(ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//')" || true
  [ -n "$ls" ] || return 0
  date -j -f "%a %b %e %T %Y" "$ls" +%s 2>/dev/null || true
}

newest_mtime() { # svc -> newest mtime epoch over watch dirs + entry (0 if none)
  local name="$1" dir best=0 m d entry
  dir="$(svc_dir "$name")"
  entry="$(svc_entry "$name")"
  if [ "$entry" != "-" ] && [ -f "$dir/$entry" ]; then
    best="$(stat -f %m "$dir/$entry")"
  fi
  if [ "$(svc_watch "$name")" != "-" ]; then
    for d in $(svc_watch "$name"); do
      [ -d "$dir/$d" ] || continue
      m="$(find "$dir/$d" -type f \( -name '*.mjs' -o -name '*.js' -o -name '*.json' \) \
          -not -path '*/node_modules/*' -exec stat -f %m {} + 2>/dev/null | sort -n | tail -1 || true)"
      if [ -n "$m" ] && [ "$m" -gt "$best" ]; then best="$m"; fi
    done
  fi
  echo "$best"
}

# Does this service already embed heimdall? GET <port>/heimdall/status.
embed_state() { # name
  local name="$1" p url code body
  if is_transitional "$name"; then echo "transitional: to be embedded into the servers above"; return 0; fi
  p="$(primary_port "$name")"
  url="http://127.0.0.1:$p/heimdall/status"
  body="$(mktemp "${TMPDIR:-/tmp}/floor.XXXXXX")"
  code="$(curl -s -m 5 -o "$body" -w '%{http_code}' "$url" 2>/dev/null || true)"
  if [ "$code" = 200 ] && head -c 1 "$body" | grep -q '{'; then echo "embedded (GET /heimdall/status -> JSON)"
  elif [ "$code" = 404 ]; then echo "not embedded yet"
  elif [ "$code" = 000 ] || [ -z "$code" ]; then echo "unknown (service not answering)"
  else echo "not embedded yet (http $code)"; fi
  rm -f "$body"
}

# ---- plist generation ---------------------------------------------------------
emit_plist() { # name
  local name="$1" dir bin cmd shcmd line k v path_env logf
  dir="$(svc_dir "$name")"
  bin="$(runtime_bin "$(svc_runtime "$name")")"
  cmd="$(svc_args "$name")"
  # launchd has no env-file support, so a tiny shell wrapper sources the 0600
  # secrets file (if present) and then execs the runtime, which launchd tracks.
  shcmd="set -a; if [ -f '$ENV_FILE' ]; then . '$ENV_FILE'; fi; set +a; exec '$bin' $cmd"
  path_env="$(dirname "$bin"):/usr/bin:/bin:/usr/sbin:/sbin"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(label "$name")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>$(printf '%s' "$shcmd" | xml_escape)</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(printf '%s' "$dir" | xml_escape)</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(printf '%s' "$path_env" | xml_escape)</string>
EOF
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    k="${line%%=*}"
    v="${line#*=}"
    case "$k" in *KEY*|*TOKEN*|*SECRET*|*PASSWORD*) die "refusing to bake secret-looking name $k into a plist" ;; esac
    printf '    <key>%s</key>\n    <string>%s</string>\n' "$k" "$(printf '%s' "$v" | xml_escape)"
  done < <(svc_env "$name")
  logf="$LOG_DIR/$name.log"
  cat <<EOF
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$(printf '%s' "$logf" | xml_escape)</string>
  <key>StandardErrorPath</key>
  <string>$(printf '%s' "$logf" | xml_escape)</string>
</dict>
</plist>
EOF
}

# ---- commands -------------------------------------------------------------------
cmd_install() {
  local dry=0 no_trans=0 with_opt=0 name tmp target chosen=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1 ;;
      --without-transitional) no_trans=1 ;;
      --with-optional) with_opt=1 ;;
      *) die "install: unknown option $1" ;;
    esac
    shift
  done
  for name in $(names); do
    if is_transitional "$name" && [ "$no_trans" = 1 ]; then continue; fi
    if is_optional "$name" && [ "$with_opt" = 0 ]; then continue; fi
    chosen="$chosen $name"
  done
  if [ "$dry" = 1 ]; then
    for name in $chosen; do
      echo "# ---- $(plist_path "$name") ----"
      emit_plist "$name"
    done
    echo "# (dry run: nothing written, nothing loaded; would also create $ENV_FILE 0600 if missing)"
    return 0
  fi
  mkdir -p "$LA_DIR" "$LOG_DIR" "$STATE_DIR"
  if [ ! -f "$ENV_FILE" ]; then
    ( umask 077; : > "$ENV_FILE" )
    echo "created empty $ENV_FILE (0600): put secrets there as NAME=value lines, then restart the service."
  fi
  chmod 600 "$ENV_FILE"
  for name in $chosen; do
    target="$(plist_path "$name")"
    tmp="$(mktemp "${TMPDIR:-/tmp}/floor.XXXXXX")"
    emit_plist "$name" > "$tmp"
    if ! plutil -lint "$tmp" >/dev/null; then
      rm -f "$tmp"
      die "plutil -lint failed for $name"
    fi
    if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
      rm -f "$tmp"
      echo "unchanged  $target"
    else
      mv "$tmp" "$target"
      chmod 644 "$target"
      echo "written    $target"
    fi
  done
  for name in $(names); do
    case " $chosen " in *" $name "*) ;; *) [ -f "$(plist_path "$name")" ] && echo "note: $(plist_path "$name") exists but was not selected; left as is" ;; esac
  done
  echo "not loaded. next: floor.sh adopt (to cut over hand-started processes) or floor.sh up"
}

poll_health() { # name port -> 0 on PASS
  local name="$1" port="$2" url code="" i
  url="http://127.0.0.1:$port$(port_health_path "$name" "$port")"
  for i in $(seq 1 30); do
    code="$(http_code "$url")"
    if [ "$code" = 200 ]; then echo "PASS  $port  $url"; return 0; fi
    sleep 1
  done
  echo "FAIL  $port  $url (last http $code after 30s)"
  return 1
}

cmd_up() {
  local name p bad=0 pid todo
  todo="$(installed_names)"
  [ -n "$todo" ] || die "no plists in $LA_DIR; run: floor.sh install"
  for name in $todo; do
    if is_loaded "$name"; then
      echo "$name: already loaded"
    else
      p="$(primary_port "$name")"
      pid="$(listener_pid "$p")"
      if [ -n "$pid" ]; then
        echo "$name: port $p is held by hand-started pid $pid; refusing to bootstrap (it would crash-loop). Run: floor.sh adopt" >&2
        bad=1
        continue
      fi
      launchctl bootstrap "$DOMAIN" "$(plist_path "$name")"
      echo "$name: bootstrapped"
    fi
    for p in $(svc_ports "$name"); do
      poll_health "$name" "$p" || bad=1
    done
  done
  if [ "$(http_code "$OLLAMA_URL")" = 200 ]; then echo "PASS  11435  $OLLAMA_URL (Ollama.app, unmanaged)"; else echo "FAIL  11435  $OLLAMA_URL (Ollama.app, unmanaged)"; bad=1; fi
  return "$bad"
}

cmd_down() {
  local name
  for name in $(rinstalled_names); do
    if is_loaded "$name"; then
      launchctl bootout "$DOMAIN/$(label "$name")" && echo "$name: stopped"
    else
      echo "$name: not loaded"
    fi
  done
}

cmd_status() {
  local name p pid started newest dir entry commit loaded inst code flags
  for name in $(names); do
    dir="$(svc_dir "$name")"
    entry="$(svc_entry "$name")"
    p="$(primary_port "$name")"
    pid="$(listener_pid "$p")"
    started=""
    [ -n "$pid" ] && started="$(proc_start_epoch "$pid")"
    if [ -f "$(plist_path "$name")" ]; then inst=yes; else inst=no; fi
    if is_loaded "$name"; then loaded=yes; else loaded=no; fi
    flags=""
    is_transitional "$name" && flags="$flags transitional"
    is_optional "$name" && flags="$flags optional"
    echo "$name${flags:+  [${flags# }]}"
    echo "  ports        $(svc_ports "$name")"
    echo "  pid          ${pid:-none}"
    echo "  started      $(if [ -n "$started" ]; then fmt_epoch "$started"; else echo "n/a"; fi)"
    echo "  plist        installed=$inst loaded=$loaded ($(plist_path "$name"))"
    for p in $(svc_ports "$name"); do
      code="$(http_code "http://127.0.0.1:$p$(port_health_path "$name" "$p")")"
      echo "  health       $p $(port_health_path "$name" "$p") -> $code $([ "$code" = 200 ] && echo PASS || echo FAIL)"
    done
    echo "  heimdall     $(embed_state "$name")"
    commit="$(git -C "$dir" log -1 --format=%ct 2>/dev/null || true)"
    echo "  repo commit  $(fmt_epoch "${commit:-0}")  ($dir)"
    if [ "$entry" = "-" ]; then
      echo "  freshness    n/a (static files served from disk)"
    else
      if [ -f "$dir/$entry" ]; then
        echo "  entry mtime  $(fmt_epoch "$(stat -f %m "$dir/$entry")")  ($entry)"
      else
        echo "  entry mtime  MISSING ($dir/$entry)"
      fi
      newest="$(newest_mtime "$name")"
      echo "  newest src   $(fmt_epoch "$newest")  (entry + $(svc_watch "$name"))"
      if [ -n "$started" ] && [ "$newest" -gt "$started" ]; then echo "  STALE: process started before newest source change"; fi
    fi
  done
  code="$(http_code "$OLLAMA_URL")"
  echo "ollama (unmanaged, 11435)"
  echo "  health       $OLLAMA_URL -> $code $([ "$code" = 200 ] && echo PASS || echo FAIL)"
  return 0
}

cmd_restart() {
  need_name "${1:-}"
  is_loaded "$1" || die "$1 is not loaded; run: floor.sh up"
  launchctl kickstart -k "$DOMAIN/$(label "$1")"
  echo "$1: restarted"
}

cmd_logs() {
  need_name "${1:-}"
  local f="$LOG_DIR/$1.log"
  [ -f "$f" ] || die "no log yet: $f"
  if [ "${2:-}" = "-f" ]; then tail -n 100 -f "$f"; else tail -n 100 "$f"; fi
}

cmd_adopt() {
  local name p pid n=0
  echo "# Cutover from hand-started node processes to launchd. PRINTED ONLY; nothing here has been run."
  echo "# Hand-started processes currently listening:"
  for name in $(names); do
    p="$(primary_port "$name")"
    pid="$(listener_pid "$p")"
    echo "#   $name  port $p  pid ${pid:-none}  $(is_loaded "$name" && echo '(already launchd-managed)' || true)$(is_optional "$name" && echo '(optional, off by default)' || true)"
  done
  echo
  n=$((n+1)); echo "# $n. write the plists (does not load); add --without-transitional to leave the bridge out:"
  echo "$SELF install"
  echo "#    then edit $ENV_FILE (0600) with NAME=value lines the services need"
  echo "#    (e.g. OPENCODE_SERVER_PASSWORD, ANTHROPIC_AUTH_TOKEN; the running mouth and bridge inherited these)."
  n=$((n+1)); echo "# $n. stop the hand-started processes, dependents first (SIGTERM; the bridge releases ~/.heimdall/bridge.pid itself):"
  for name in $(names | tail -r); do
    if is_optional "$name" && [ ! -f "$(plist_path "$name")" ]; then continue; fi
    p="$(primary_port "$name")"
    pid="$(listener_pid "$p")"
    if [ -n "$pid" ] && ! is_loaded "$name"; then echo "kill $pid    # $name (port $p)"; fi
  done
  n=$((n+1)); echo "# $n. bring the floor up under launchd right away (table order, then health):"
  echo "$SELF up"
  n=$((n+1)); echo "# $n. verify; every installed service should show loaded=yes and no STALE flag:"
  echo "$SELF status"
  echo "# Not touched: Ollama.app (11435), heimdall-fleet (11438), opencode (4096), the vite dev server."
}

main() {
  local c="${1:-}"
  [ -n "$c" ] || { usage; exit 2; }
  shift || true
  case "$c" in
    install) cmd_install "$@" ;;
    up) cmd_up ;;
    down) cmd_down ;;
    status) cmd_status ;;
    restart) cmd_restart "${1:-}" ;;
    logs) cmd_logs "${1:-}" "${2:-}" ;;
    adopt) cmd_adopt ;;
    -h|--help|help) usage ;;
    *) usage; exit 2 ;;
  esac
}
main "$@"
