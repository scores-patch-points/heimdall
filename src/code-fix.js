// code-fix.js — the generate→test loop on the fleet (2026-10).
//
// Heimdall owns the lanes; this module is the consumer that closes Lovelace's
// loop: a job is drafted by whichever executor the registry picks (local and
// remote, one inventory), and a FALSIFYING GATE decides — never the model's
// plausibility. A draft that fails the gate is recorded as a failure on that
// lane and retried on the next-best lane (escalation is a different executor,
// never a louder prompt). A draft lands only when the gate passes.
//
// Pure and node-testable: `evaluate` and `infer` are injected, so tests fake
// a lane exactly as remote.test.mjs fakes a fetch. `evaluateWithGateScript`
// is the real falsifier: it writes the candidate to a temp module and runs a
// gate script against it (`node <gate> <candidate>`), the same shape as the
// strict GATE.test.mjs of the improvement-task evals.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { inferOn } from "./remote.js";
import { validateJob } from "./job.js";
import { observe, markSent } from "./executors.js";
import { record } from "./dispatch.js";

const execFileP = promisify(execFile);

export function buildFixPrompt({ brief, target = "" }) {
  const targetBlock = target ? `\nCURRENT SOURCE:\n${target}\n` : "";
  return `${brief}\n${targetBlock}\nReturn ONLY the module as raw code. No prose. No markdown fences. Preserve every exported name and signature exactly.`;
}

export function extractFencedCode(text) {
  const s = String(text ?? "").trim();
  const fence = s.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)(?:```|$)/);
  return fence ? fence[1].trim() : s;
}

export async function runGateScript(gatePath, candidatePath) {
  try {
    const { stdout } = await execFileP(process.execPath, [gatePath, candidatePath], { timeout: 60_000 });
    return { ok: true, why: (stdout ?? "").trim() || "exit 0" };
  } catch (e) {
    return { ok: false, why: String(e?.stderr || e?.stdout || e?.message || e).slice(0, 500) };
  }
}

export function evaluateWithGateScript({ gatePath, ext = ".mjs" }) {
  return async function evaluate(candidate) {
    const dir = await mkdtemp(path.join(tmpdir(), "code-fix-"));
    try {
      const file = path.join(dir, `candidate${ext}`);
      await writeFile(file, candidate, "utf8");
      return await runGateScript(gatePath, file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export async function fixCode({
  registry,
  job,
  brief,
  target = "",
  evaluate,
  infer = inferOn,
  maxAttempts = 3,
  temperature = 0.2,
  maxTokens = 2048,
  prompt = buildFixPrompt,
  extract = extractFencedCode,
} = {}) {
  if (!registry) throw new Error("registry required");
  if (!job || !validateJob(job).ok) throw new Error("a valid HeimdallJob@1 is required");
  if (typeof evaluate !== "function") throw new Error("evaluate (the falsifying gate) is required");

  const ledger = [];
  const attempts = [];
  const tried = new Set();

  for (let n = 0; n < Math.max(1, maxAttempts); n++) {
    const pick = registry.pick(job);
    const candidate = (pick.candidates || []).find((c) => !tried.has(c.executor));
    if (!candidate) {
      const reason = pick.reason === "no_eligible_executor" ? "no_eligible_executor" : "no_untried_executor";
      return { ok: false, reason, attempts, ledger, observations: registry.snapshot() };
    }
    const exec = registry.get(candidate.executor);
    tried.add(candidate.executor);
    registry.put(markSent(exec));

    let draw;
    try {
      draw = await infer(exec, {
        messages: [{ role: "user", content: prompt({ brief, target }) }],
        temperature,
        maxTokens,
      });
    } catch (e) {
      draw = { text: "", ms: null, ttft: null, tokens: 0, status: e?.status ?? null, error: String(e?.message || e) };
    }

    const code = extract(draw.text);
    const verdict = await evaluate(code);
    const ok = !!verdict.ok;

    registry.put(observe(exec, { taskClass: job.taskClass, ok, ms: draw.ms, ttft: draw.ttft, tokens: draw.tokens, status: draw.status }));
    ledger.push(record({ job, selected: candidate.executor, reason: pick.reason, candidates: pick.candidates, actual: { ms: draw.ms, outputTokens: draw.tokens, accepted: ok } }));
    attempts.push({ attempt: n + 1, executor: candidate.executor, ok, why: ok ? null : (verdict.why ?? draw.error ?? "gate failed") });

    if (ok) {
      return { ok: true, code, executor: candidate.executor, attempts, ledger, observations: registry.snapshot() };
    }
  }

  return { ok: false, reason: "gate_unmet", attempts, ledger, observations: registry.snapshot() };
}