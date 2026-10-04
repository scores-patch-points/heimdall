export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled") {
      if (v) node.setAttribute(k, "");
    } else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function statusDot(color, title) {
  const d = el("span", {
    class: `dot dot-${color}`,
    title: title || "",
  });
  return d;
}

export function copyBtn(text, getValue) {
  return el(
    "button",
    {
      class: "ghost small",
      text,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(getValue());
          alert("copied");
        } catch {
          const ta = document.createElement("textarea");
          ta.value = getValue();
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
      },
    },
  );
}

export function toast(msg) {
  let box = document.getElementById("toast");
  if (!box) {
    box = el("div", { id: "toast", class: "toast" });
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.classList.add("show");
  clearTimeout(box._t);
  box._t = setTimeout(() => box.classList.remove("show"), 4000);
}

export function deviceName() {
  const ua = navigator.userAgent;
  const data = navigator.userAgentData;
  if (data && Array.isArray(data.platform)) return `${data.platform[0] ?? ""} ${data.mobile ? "(mobile)" : ""}`.trim() || "device";
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "device";
}

export async function publicIp() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const j = await res.json();
    return j.ip || "unknown";
  } catch {
    return "unavailable";
  }
}

export function countdownText(until) {
  if (!until) return "no expiry";
  const ms = until - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}