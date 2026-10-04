// opencode-lane.test.mjs — the machine door: session create, prompt, part
// parsing, end-to-end code. Fake opencode server; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { code, createSession, prompt, partsOf, DEFAULT_OPENCODE, modelRef } from "./opencode-lane.js";

function fakeOpenCode({ onCreate = null, onPrompt = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === "POST" && u.pathname === "/session") {
      return json(onCreate ?? { id: "ses_1" });
    }
    if (opts.method === "POST" && /^\/session\/[^/]+\/message$/.test(u.pathname)) {
      return json(onPrompt ?? { info: { id: "msg_1" }, parts: [
        { type: "text", text: "Fixed it." },
        { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "src/util.js" } } },
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" } } },
      ] });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj });
  return { fetchImpl, calls };
}

test("createSession posts to /session and returns the id", async () => {
  const { fetchImpl, calls } = fakeOpenCode();
  const { id } = await createSession(DEFAULT_OPENCODE, { title: "fix", model: modelRef("anthropic", "claude") }, { fetchImpl });
  assert.equal(id, "ses_1");
  assert.equal(calls[0].path, "/session");
  assert.equal(calls[0].method, "POST");
});

test("prompt sends parts and parses text + tool activity", async () => {
  const { fetchImpl, calls } = fakeOpenCode();
  const out = await prompt(DEFAULT_OPENCODE, "ses_1", "fix the failing test", { model: modelRef("groq", "gpt-oss-120b") }, { fetchImpl });
  assert.equal(out.text, "Fixed it.");
  assert.equal(out.activity.length, 2);
  assert.equal(out.activity[0].tool, "edit");
  assert.equal(out.activity[0].title, "src/util.js");
  assert.equal(out.activity[1].title, "npm test");
  const sent = calls.find((c) => /\/message$/.test(c.path));
  assert.deepEqual(sent.body.parts, [{ type: "text", text: "fix the failing test" }]);
  assert.deepEqual(sent.body.model, { providerID: "groq", modelID: "gpt-oss-120b" });
});

test("partsOf tolerates {parts}, bare array, and {info.parts}", () => {
  assert.equal(partsOf({ parts: [{ type: "text", text: "a" }] }).text, "a");
  assert.equal(partsOf([{ type: "text", text: "b" }]).text, "b");
  assert.equal(partsOf({ info: { parts: [{ type: "text", text: "c" }] } }).text, "c");
  assert.equal(partsOf(null).text, "");
});

test("code creates a session then prompts it, end to end", async () => {
  const { fetchImpl, calls } = fakeOpenCode();
  const out = await code(DEFAULT_OPENCODE, { prompt: "add a test", title: "add test" }, { fetchImpl });
  assert.equal(out.sessionId, "ses_1");
  assert.equal(out.text, "Fixed it.");
  assert.equal(out.activity.length, 2);
  assert.ok(out.ms >= 0);
  assert.deepEqual(calls.map((c) => c.method + " " + c.path), ["POST /session", "POST /session/ses_1/message"]);
});

test("code binds a new session to the project folder via directory (the shared project)", async () => {
  const { fetchImpl, calls } = fakeOpenCode();
  await code(DEFAULT_OPENCODE, { prompt: "edit the project", cwd: "/Users/me/proj" }, { fetchImpl });
  const create = calls.find((c) => c.path === "/session");
  assert.equal(create.body.directory, "/Users/me/proj", "the folder rides session create");
  // Continuing an existing session must NOT re-send a directory.
  const { fetchImpl: f2, calls: c2 } = fakeOpenCode();
  await code(DEFAULT_OPENCODE, { prompt: "again", sessionId: "ses_9", cwd: "/Users/me/proj" }, { fetchImpl: f2 });
  assert.ok(!c2.some((c) => c.path === "/session"), "no new session is created when continuing");
});

test("a failing prompt throws with the server message", async () => {
  const fetchImpl = async (url, opts) => {
    if (opts.method === "POST" && String(url).endsWith("/session")) return { ok: true, status: 200, text: async () => JSON.stringify({ id: "s" }) };
    return { ok: false, status: 500, text: async () => "boom" };
  };
  await assert.rejects(() => code(DEFAULT_OPENCODE, { prompt: "x" }, { fetchImpl }), /opencode prompt 500/);
});