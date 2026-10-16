#!/usr/bin/env node
// opencode-provider.mjs — make "Heimdall By The Fold" selectable in opencode.
//
// It emits (or installs) an opencode provider block that points at this bridge's
// OpenAI-compatible wire, where the model id `heimdall-by-the-fold` runs the void
// loop (src/void.js / src/compose.js). No API key: the baseURL ends in /v1.
//
//   node scripts/opencode-provider.mjs                 # print the JSON block
//   node scripts/opencode-provider.mjs --write         # merge into ~/.config/opencode/opencode.json
//   node scripts/opencode-provider.mjs --port 8790      # set the bridge port (default HEIMDALL_PORT or 8790)
//
// The bridge must be running (`heimdall up`). After --write, restart opencode and
// pick "Heimdall By The Fold" (provider `heimdall`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name, d) => {
  const i = argv.indexOf(name);
  return i < 0 ? d : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
};
const port = Number(flag("--port", process.env.HEIMDALL_PORT || 8790));
const baseURL = String(flag("--url", `http://127.0.0.1:${port}/v1`)).replace(/\/+$/, "");
const MODEL = "heimdall-by-the-fold";

const provider = {
  heimdall: {
    name: "Heimdall By The Fold",
    package: "@ai-sdk/openai-compatible",
    settings: { baseURL },
    models: { [MODEL]: { name: "Heimdall By The Fold" } },
  },
};
const block = { provider };

console.log(JSON.stringify(block, null, 2));

if (flag("--write", false) !== false) {
  const file = flag("--config", path.join(os.homedir(), ".config", "opencode", "opencode.json"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* first write */
  }
  if (current.provider && current.provider.heimdall) {
    console.error(`\n${file} already declares provider.heimdall — leaving it untouched (edit by hand).`);
    process.exit(1);
  }
  const next = { ...current, provider: { ...(current.provider || {}), ...block.provider } };
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  console.error(`\nwrote provider.heimdall (${MODEL} → ${baseURL}) into ${file}${fs.existsSync(`${file}.bak`) ? " (backup: .bak)" : ""}`);
  console.error("restart opencode, then select \"Heimdall By The Fold\".");
}
