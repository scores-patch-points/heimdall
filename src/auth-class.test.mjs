// auth-class.test.mjs — the six auth classes and the keyless-discovery trap.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_CLASSES, AUTH_CLASS, classifyAuth, authObservation, canInfer, authLabel,
} from "./auth-class.js";

test("the six classes are the six classes", () => {
  assert.deepEqual([...AUTH_CLASSES], ["in_process", "local_open", "user_pays", "optional_auth", "api_key", "discovery_only"]);
  for (const c of AUTH_CLASSES) assert.ok(AUTH_CLASS[c], c);
});

test("THE TRAP: discovery keyless does NOT make inference keyless", () => {
  // Pollinations: GET /v1/models is anonymous; generation is not.
  const cls = classifyAuth({ developerKey: false, discoveryKeyless: true, inferenceKeyless: false });
  assert.equal(cls, "discovery_only");
  assert.equal(canInfer(cls), false, "a discovery_only endpoint is NOT an executor");
});

test("LocalAI's .well-known is anonymous even when inference is protected", () => {
  const cls = classifyAuth({ developerKey: false, discoveryKeyless: true, inferenceKeyless: false });
  assert.equal(cls, "discovery_only");
});

test("inference keyless + no dev key = local_open", () => {
  assert.equal(classifyAuth({ developerKey: false, discoveryKeyless: true, inferenceKeyless: true }), "local_open");
  assert.equal(canInfer("local_open"), true);
});

test("an unprobed endpoint cannot claim keyless inference", () => {
  // Discovery answered, but the auth probe never ran: not local_open.
  assert.equal(classifyAuth({ developerKey: false, discoveryKeyless: true, inferenceKeyless: null }), "discovery_only");
  assert.equal(classifyAuth({ developerKey: false, discoveryKeyless: false, inferenceKeyless: null }), "optional_auth");
});

test("user session (Puter) is user_pays even without a developer key", () => {
  assert.equal(classifyAuth({ developerKey: false, userSession: true }), "user_pays");
  assert.equal(AUTH_CLASS.user_pays.developerKey, false);
  assert.equal(canInfer("user_pays"), true);
});

test("a developer key is api_key, and its trust is external/sealed", () => {
  assert.equal(classifyAuth({ developerKey: true, inferenceKeyless: false }), "api_key");
  assert.equal(AUTH_CLASS.api_key.trust, "external/sealed");
});

test("auth observation carries both assays and the verdict", () => {
  const o = authObservation({ kind: "discovery_only", discoveryKeyless: true, inferenceKeyless: false, tested: true });
  assert.equal(o.discoveryKeyless, true);
  assert.equal(o.inferenceKeyless, false);
  assert.equal(o.tested, true);
});

test("labels are short and human", () => {
  assert.equal(authLabel("user_pays"), "external, user-pays");
  assert.equal(authLabel("api_key"), "API key");
  assert.equal(authLabel("nope"), "nope");
});