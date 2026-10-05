// job.js — HeimdallJob@1: the unit of work, not a model name.
//
// Holodeck describes the work (taskClass, objective, privacy, effects,
// requires, output, protocols); Heimdall resolves it to an executor. A model
// field is an explicit pin and exists only when a person named it — ordinary
// Fold work is capability-routed, never model-routed.
//
// Pure and node-testable: nothing here touches the network or the page.

export const SCHEMA = "HeimdallJob@1";

/** Task classes are dotted names; routing evidence is keyed on them. The
 *  initial taxonomy follows the Fold's nine operators (NUL SIG INS SEG CON
 *  SYN DEF EVA REC) folded into formal and mechanical families. */
export const TASK_CLASSES = Object.freeze({
  "formal.counterfactual": {
    family: "formal",
    capability: "reasoning",
    label: "minimal sufficient conditions · minimal falsifiers · decisive variables",
  },
  "formal.classify": {
    family: "formal",
    capability: "classification",
    label: "assign to a declared set, marked off from every adjacent",
  },
  "formal.compare": {
    family: "formal",
    capability: "reasoning",
    label: "relations between declared grounds",
  },
  "formal.summarize": {
    family: "formal",
    capability: "composition",
    label: "the essential shape at a declared grain",
  },
  "formal.extract": {
    family: "formal",
    capability: "extraction",
    label: "declared fields from declared source",
  },
  "formal.synthesize": {
    family: "formal",
    capability: "composition",
    label: "new standing from old edges",
  },
  "formal.check": {
    family: "formal",
    capability: "verification",
    label: "does the declared condition hold",
  },
  "formal.code": {
    family: "formal",
    capability: "composition",
    label: "a program that satisfies a falsifying gate",
  },
  "mechanical.compute": {
    family: "mechanical",
    capability: "compute",
    label: "settled by a deterministic solver, not a model",
  },
  "mechanical.find": {
    family: "mechanical",
    capability: "retrieval",
    label: "locate by declared criteria",
  },
});

/** Door names (The Fold's Doors) → the capabilities they need. A job's
 *  `requires` is a list of door names; this is the map that turns them into
 *  executor capabilities. The executor's advertised set must cover every
 *  required door's capability before it is eligible. */
export const DOOR_CAPABILITIES = Object.freeze({
  "door:find": "retrieval",
  "door:read": "retrieval",
  "door:compare": "reasoning",
  "door:test": "verification",
  "door:check": "verification",
  "door:write": "composition",
  "door:structured": "structured-output",
  "door:tool": "native-tools",
});

/** Every capability an executor can advertise. */
export const CAPABILITIES = Object.freeze([
  "reasoning",
  "classification",
  "composition",
  "extraction",
  "verification",
  "compute",
  "retrieval",
  "structured-output",
  "native-tools",
  "vision",
  "long-context",
]);

/** privacy: the boundary the job may cross. local-raw means the executor sits
 *  inside the trust domain and may see raw witness state; sealed-external
 *  means the provider receives only the permitted projection. */
export const PRIVACY = Object.freeze(["local-raw", "sealed-external"]);

export const OBJECTIVE = Object.freeze(["interactive", "batch"]);

export const EFFECTS = Object.freeze([
  "observe",
  "mutate-local",
  "mutate-external",
  "irreversible",
]);

export const PROTOCOLS = Object.freeze(["native-tools", "door-grammar", "door-text"]);

/** DISCLOSURE — what may leave the machine for this job (2026-10, escalation
 *  design). Ordered from least to most permissive; a route's exposure may never
 *  exceed the job's disclosure, and escalation never raises the job's.
 *    none                   nothing leaves this machine
 *    abstract-capsule-only  only a precompiled sealed capsule (opaque symbols +
 *                           formal relations; src/capsule.js) may leave
 *    sealed-external-text   a sealed text projection may leave (the older
 *                           `privacy: "sealed-external"` meaning) */
export const DISCLOSURE = Object.freeze(["none", "abstract-capsule-only", "sealed-external-text"]);

/** Rank of a disclosure level (0 = none). -1 for an unknown level, which no
 *  comparison ever treats as permissive. */
export const disclosureRank = (d) => DISCLOSURE.indexOf(d);

/** The job's disclosure: explicit when declared, else derived from the older
 *  `privacy` field so every pre-existing job keeps its meaning. */
export function disclosureOf(job) {
  if (job?.disclosure != null) return job.disclosure;
  return job?.privacy === "local-raw" ? "none" : "sealed-external-text";
}

/** The typed acceptance checks the Fold runs LOCALLY on a returned proposal
 *  (src/acceptance.js). A remote result is a proposal until these pass. */
export const CHECK_TYPES = Object.freeze(["schema", "equation", "constraint", "contradiction-free", "citation-resolves", "custom"]);

/** The only observable failure kinds that may trigger an escalation
 *  (src/escalation.js). A model's self-reported confidence is not on this list
 *  and never can be. */
export const FAILURE_KINDS = Object.freeze(["check_failed", "contradiction", "unresolved", "capability_missing", "deadline_risk", "route_error"]);

export function isTaskClass(name) {
  return Object.hasOwn(TASK_CLASSES, name);
}

export function taskClassFor(askShape) {
  const s = String(askShape ?? "").toLowerCase();
  if (s.startsWith("formal.") || s.startsWith("mechanical.")) {
    return isTaskClass(s) ? s : null;
  }
  // Best-effort mechanical mapping from a plain ask; null when not mapped.
  const table = {
    find: "mechanical.find",
    compare: "formal.compare",
    check: "formal.check",
    test: "formal.check",
    classify: "formal.classify",
    extract: "formal.extract",
    summarize: "formal.summarize",
    counterfactual: "formal.counterfactual",
    compute: "mechanical.compute",
    code: "formal.code",
  };
  for (const [key, cls] of Object.entries(table)) {
    if (s.includes(key)) return cls;
  }
  return null;
}

/** Capabilities a task class itself implies (before doors are added). */
export function capabilitiesOfTaskClass(taskClass) {
  return TASK_CLASSES[taskClass] ? [TASK_CLASSES[taskClass].capability] : [];
}

/** The capabilities a job requires: its task class plus every required door. */
export function capabilitiesOf(job) {
  const out = new Set(capabilitiesOfTaskClass(job.taskClass));
  for (const door of job.requires || []) {
    const cap = DOOR_CAPABILITIES[door];
    if (cap) out.add(cap);
  }
  return [...out];
}

/** An executor is eligible for a job only when its advertised capability set
 *  covers every capability the job requires. */
export function satisfies(job, advertised = []) {
  const have = new Set(advertised || []);
  return capabilitiesOf(job).every((c) => have.has(c));
}

/** Whether a job may be sent to an external provider at all. A sealed-external
 *  job may (it carries only the projection); a local-raw job may not. */
export function mayLeave(job) {
  return job.privacy !== "local-raw";
}

/** Build a job from parts, filling defaults. Returns a plain object; call
 *  validateJob to check it. `model` is a pin only when explicitly provided. */
export function makeJob({
  taskClass,
  objective = "interactive",
  privacy = "sealed-external",
  effects = ["observe"],
  requires = [],
  inputs = [],
  output = { kind: "text", maxTokens: 500 },
  protocols = ["door-text"],
  model = null,
  deadlineMs = null,
  qualityFloor = null,
  task = null,
  disclosure = null,
  acceptance = [],
  maxAttempts = 3,
} = {}) {
  return {
    schema: SCHEMA,
    id: `J${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    taskClass,
    objective,
    privacy,
    effects,
    requires,
    inputs,
    output,
    protocols,
    model,
    deadlineMs,
    qualityFloor,
    // escalation design (2026-10): what needs solving, what may leave, and the
    // machine-checkable acceptance the Fold runs locally. `disclosure` defaults
    // from `privacy`, so jobs built before it existed are unchanged.
    task,
    disclosure: disclosure ?? (privacy === "local-raw" ? "none" : "sealed-external-text"),
    acceptance,
    maxAttempts,
  };
}

/** Validate a HeimdallJob@1. Returns { ok: true } or { ok: false, errors }. */
export function validateJob(job) {
  const errors = [];
  if (!job || typeof job !== "object") return { ok: false, errors: ["not an object"] };
  if (job.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  if (!job.id) errors.push("missing id");
  if (!isTaskClass(job.taskClass)) errors.push(`unknown taskClass ${job.taskClass}`);
  if (!OBJECTIVE.includes(job.objective)) errors.push(`objective must be one of ${OBJECTIVE.join("|")}`);
  if (!PRIVACY.includes(job.privacy)) errors.push(`privacy must be one of ${PRIVACY.join("|")}`);
  for (const e of job.effects || []) if (!EFFECTS.includes(e)) errors.push(`unknown effect ${e}`);
  for (const r of job.requires || []) if (!DOOR_CAPABILITIES[r]) errors.push(`unknown door ${r}`);
  if (!job.output?.kind || !["text", "structured"].includes(job.output.kind)) errors.push("output.kind must be text|structured");
  if (job.output.kind === "structured" && !capabilitiesOf(job).includes("structured-output")) {
    errors.push("structured output requires the structured-output capability");
  }
  for (const p of job.protocols || []) if (!PROTOCOLS.includes(p)) errors.push(`unknown protocol ${p}`);
  if (job.disclosure != null) {
    if (!DISCLOSURE.includes(job.disclosure)) errors.push(`disclosure must be one of ${DISCLOSURE.join("|")}`);
    // A local-raw job may be read raw only inside the trust domain, so it can
    // never carry a permission to leave: the two declarations must agree.
    else if (job.privacy === "local-raw" && job.disclosure !== "none") errors.push("a local-raw job cannot declare a disclosure above none");
  }
  if (job.acceptance != null) {
    if (!Array.isArray(job.acceptance)) errors.push("acceptance must be an array of typed checks");
    else job.acceptance.forEach((c, i) => {
      if (!c || typeof c !== "object" || !CHECK_TYPES.includes(c.type)) errors.push(`acceptance[${i}].type must be one of ${CHECK_TYPES.join("|")}`);
      else if (c.type === "custom" && !(typeof c.fn === "string" && c.fn)) errors.push(`acceptance[${i}] custom check needs a fn id`);
      else if (c.type === "schema" && !(c.schema && typeof c.schema === "object")) errors.push(`acceptance[${i}] schema check needs a schema`);
      else if (c.type === "equation" && !(Array.isArray(c.statements) && c.statements.length)) errors.push(`acceptance[${i}] equation check needs statements`);
      else if (c.type === "constraint" && !(Array.isArray(c.constraints) && c.constraints.length)) errors.push(`acceptance[${i}] constraint check needs constraints`);
    });
  }
  if (job.maxAttempts != null && !(Number.isInteger(job.maxAttempts) && job.maxAttempts >= 1 && job.maxAttempts <= 10)) errors.push("maxAttempts must be an integer 1..10");
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}