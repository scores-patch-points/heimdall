// by-the-fold.test.mjs — "Heimdall By The Fold": a selectable model id that runs the void loop.
// Each test is a falsifying control on the alias, exercised through the real bridge HTTP wire.
import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "./bridge-server.mjs";
import { createCompetence } from "./competence.js";
import { BY_THE_FOLD, proposalText, messagesOf, byTheFoldJob, disclosureOf, isByTheFold } from "./by-the-fold.js";

const CAPS = ["reasoning", "classification", "composition", "extraction", "verification", "compute", "retrieval", "structured-output"];
const local = (id, over = {}) => ({ id, kind: "local-model", trust: "local", model: over.model ?? id, capabilities: CAPS, networkMs: 0, serviceMs: 100, ...over });
const remote = (id, over = {}) => ({ id, kind: "remote", trust: "external", model: over.model ?? id, capabilities: [...CAPS, "native-tools"], exposure: "sealed-external-text", networkMs: 100, serviceMs: 200, ...over });

async function boot(t, routes, extra = {}) {
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: null, autoOpen: false, upstream: "http://127.0.0.1:1", listLocalModels: () => [], competence: createCompetence(), auditFile: null, routeStatsFile: null, jobRoutes: () => routes, ...extra });
  await bridge.listen();
  t.after(() => bridge.close());
  return "http://127.0.0.1:" + bridge.server.address().port;
}
const chat = (base, body) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json() }));
const askBody = (over = {}) => ({ model: BY_THE_FOLD, stream: false, messages: [{ role: "user", content: "summarize this" }], ...over });

test("the alias is a selectable model in /v1/models and via the Ollama tag list", async (t) => {
  const base = await boot(t, [local("gen-a", { run: async () => ({ text: "hi", ms: 5 }) })]);
  const models = await (await fetch(base + "/v1/models")).json();
  assert.ok(models.data.some((m) => m.id === BY_THE_FOLD && m.owned_by === "the-fold"));
  const tags = await (await fetch(base + "/api/tags")).json();
  assert.ok(tags.models.some((m) => m.name === BY_THE_FOLD));
});

test("it really routes: a call to the alias runs the void loop and returns the SERVED model's text", async (t) => {
  const base = await boot(t, [local("gen-a", { run: async () => ({ text: "answered by gen-a", ms: 5 }) })]);
  const { status, j } = await chat(base, askBody());
  assert.equal(status, 200);
  assert.equal(j.choices[0].message.content, "answered by gen-a");
  assert.equal(j.heimdall.served_by, "gen-a"); // not the alias — the model the router chose
  assert.equal(j.heimdall.state, "accepted");
  assert.equal(j.model, BY_THE_FOLD);
});

test("the alias never leaks to a frontier without the sealed label; with it, the frontier is reachable", async (t) => {
  const only = [remote("frontier-x", { run: async () => ({ text: "remote answer", ms: 5 }) })];
  const base = await boot(t, only);
  const unsealed = await chat(base, askBody()); // no heimdall_privacy → local-raw/none → remote ineligible
  assert.notEqual(unsealed.j.heimdall?.served_by, "frontier-x");
  assert.equal(unsealed.status, 502);
  const sealed = await chat(base, askBody({ heimdall_privacy: "sealed-external" }));
  assert.equal(sealed.status, 200);
  assert.equal(sealed.j.heimdall.served_by, "frontier-x");
});

test("the structural gate: an empty completion is refused and the call escalates to a lane that answers", async (t) => {
  const routes = [local("empty-a", { serviceMs: 50, run: async () => ({ text: "", ms: 3 }) }), local("good-b", { serviceMs: 500, run: async () => ({ text: "real", ms: 3 }) })];
  const base = await boot(t, routes);
  const { status, j } = await chat(base, askBody());
  assert.equal(status, 200);
  assert.equal(j.heimdall.served_by, "good-b"); // the empty lane was refuted, not kept
  assert.equal(j.choices[0].message.content, "real");
});

test("if every lane returns an empty completion, the alias reports no accepted answer (never a silent empty)", async (t) => {
  const base = await boot(t, [local("empty-a", { run: async () => ({ text: "   ", ms: 3 }) })]);
  const { status, j } = await chat(base, askBody());
  assert.equal(status, 502);
  assert.match(j.error.message, /no accepted answer/);
});

test("every accepted call teaches the competence table who is good at what", async (t) => {
  const comp = createCompetence();
  const base = await boot(t, [local("gen-a", { run: async () => ({ text: "x", ms: 3 }) })], { competence: comp });
  await chat(base, askBody());
  assert.equal(comp.estimate("gen-a", "formal.summarize", 0).mean, 1);
});

test("cheapest: with heimdall_routing the free local lane wins over a paid remote one", async (t) => {
  const routes = [
    local("free-local", { serviceMs: 4000, run: async () => ({ text: "local", ms: 3 }) }),
    remote("paid-remote", { serviceMs: 100, usd: 0.02, run: async () => ({ text: "paid", ms: 3 }) }),
  ];
  const base = await boot(t, routes);
  const fast = await chat(base, askBody({ heimdall_privacy: "sealed-external" }));
  assert.equal(fast.j.heimdall.served_by, "paid-remote"); // fastest default
  const cheap = await chat(base, askBody({ heimdall_privacy: "sealed-external", heimdall_routing: "cheapest" }));
  assert.equal(cheap.j.heimdall.served_by, "free-local"); // cheapest: free, accepted
});

test("builders: isByTheFold, proposalText, messagesOf, byTheFoldJob, disclosureOf", () => {
  assert.equal(isByTheFold("Heimdall-By-The-Fold"), true);
  assert.equal(isByTheFold("llama3"), false);
  assert.equal(proposalText({ text: "hi" }), "hi");
  assert.equal(proposalText("direct"), "direct");
  const m = messagesOf({ system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.deepEqual(m.map((x) => x.role), ["system", "user"]);
  assert.equal(m[1].content, "hi");
  const job = byTheFoldJob({ messages: [{ role: "user", content: "compare these" }] });
  assert.equal(job.taskClass, "formal.compare");
  assert.equal(job.privacy, "local-raw");
  assert.equal(job.disclosure, "none");
  assert.equal(job.acceptance[0].fn, "by-the-fold-completion");
  const sealed = byTheFoldJob({ messages: [{ role: "user", content: "x" }], privacy: "sealed-external" });
  assert.equal(sealed.disclosure, "sealed-external-text");
  assert.equal(disclosureOf({ state: "accepted", route: "r", attempts: [1, 2] }).served_by, "r");
});
