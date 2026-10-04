// auth-class.js — the keyless-lane classification (2026-10).
//
// Three very different things get called "no API key." This module is the one
// place they are told apart, so Heimdall can treat "requires no developer API
// key" as a first-class capability instead of a rumor.
//
//   in_process       WebLLM, Transformers.js            local     inference
//   local_open       Ollama, llama.cpp, LM Studio       local/LAN inference
//   user_pays        Puter.js                           external  inference (user session)
//   optional_auth    self-hosted LocalAI/llama.cpp      configured inference
//   api_key          OpenAI, Anthropic, Groq, Together  external  inference
//   discovery_only   public /models endpoints           external  NOT inference
//
// The one trap this module exists to prevent: a keyless DISCOVERY endpoint
// does not make INFERENCE keyless. Pollinations' GET /v1/models is anonymous;
// generation is not. LocalAI's /.well-known is anonymous by design even when
// its inference endpoints are protected. So an endpoint carries TWO assays —
// discoveryAuth and inferenceAuth — and Heimdall never infers one from the
// other. discovery_only means "discovery worked, inference did not," and that
// endpoint is not an executor.
//
// Pure and node-testable.

export const AUTH_CLASSES = Object.freeze([
  "in_process",
  "local_open",
  "user_pays",
  "optional_auth",
  "api_key",
  "discovery_only",
]);

/** The six classes, with the properties that matter to routing. */
export const AUTH_CLASS = Object.freeze({
  in_process: { developerKey: false, identity: "none", trust: "local", inference: true },
  local_open: { developerKey: false, identity: "none", trust: "local/LAN", inference: true },
  user_pays: { developerKey: false, identity: "user-session", trust: "external/sealed", inference: true },
  optional_auth: { developerKey: "maybe", identity: "deployment-dependent", trust: "configured", inference: true },
  api_key: { developerKey: true, identity: "provider", trust: "external/sealed", inference: true },
  discovery_only: { developerKey: false, identity: "none", trust: "none", inference: false },
});

/** A full auth observation for one endpoint. `kind` is the classifier's
 *  verdict; discoveryAuth and inferenceAuth are the two raw assays. */
export function authObservation({ kind, developerKey = false, userSession = false, discoveryKeyless = false, inferenceKeyless = null, tested = false, note = null }) {
  return {
    kind,
    developerKey,
    userSession,
    discoveryKeyless,
    inferenceKeyless,
    tested,
    note,
  };
}

/** Classify an endpoint from its two assays. The order matters:
 *  an endpoint whose inference probe was never run cannot be called keyless. */
export function classifyAuth({ developerKey = false, userSession = false, discoveryKeyless = false, inferenceKeyless = null }) {
  if (userSession) return "user_pays";
  if (developerKey) return "api_key";
  // No developer key from here on.
  if (inferenceKeyless === true) return "local_open";
  if (inferenceKeyless === false) {
    // Inference asked for a credential we do not carry.
    return discoveryKeyless ? "discovery_only" : "optional_auth";
  }
  if (inferenceKeyless === null) {
    // Never probed. Discovery alone proves nothing about inference.
    return discoveryKeyless ? "discovery_only" : "optional_auth";
  }
  return "optional_auth";
}

/** A provider/executor is inference-usable when its class has inference:true. */
export function canInfer(authClass) {
  return AUTH_CLASS[authClass]?.inference === true;
}

/** The shortest human label for a class, for the registry UI. */
export const AUTH_LABEL = Object.freeze({
  in_process: "local, no auth",
  local_open: "local, no auth",
  user_pays: "external, user-pays",
  optional_auth: "configured",
  api_key: "API key",
  discovery_only: "not inference",
});

export function authLabel(authClass) {
  return AUTH_LABEL[authClass] ?? authClass ?? "unknown";
}