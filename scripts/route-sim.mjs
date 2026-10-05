#!/usr/bin/env node
// route-sim.mjs — the routing simulator: prove (and bound) the escalation design's claims.
//   node scripts/route-sim.mjs            all scenarios + sensitivity + non-stationary dynamics
//   node scripts/route-sim.mjs --seeds 60 more seeds for the dynamics table
//
// Every route parameter is an ASSUMED number of a scenario (route-sim.js), not a measurement of any real
// route. What this proves is the router's behaviour given such numbers, and where that behaviour has costs.
import { simulate, rejectionsToFlip, simRoutes, simJob, nonstationary } from "../src/route-sim.js";
import { choose } from "../src/escalation.js";
import { createRouteStats } from "../src/route-stats.js";

const seeds = Number(process.argv[process.argv.indexOf("--seeds") + 1]) || 40;
const first = (t) => t.attempts[0]?.route ?? "(none)";
const show = (name, t, extra = "") => console.log(`${name.padEnd(46)} first=${first(t).padEnd(16)} final=${t.final.state.padEnd(10)} via=${(t.final.route ?? "-").padEnd(14)} attempts=${t.attempts.length} ${extra}`);

console.log("== scenarios (single job, seed 1; assumed route parameters in src/route-sim.js)");
show("1 local idle + adequate", (await simulate({ seed: 1 })).trace);
show("2a local saturated (queue 8, inflight 2)", (await simulate({ seed: 1, routesOver: { "local-idle": { queue: 8, inflight: 2 } } })).trace);
show("2b local lacks capability (needs native-tools)", (await simulate({ seed: 1, jobOver: { requires: ["door:tool"] } })).trace);
const flip = rejectionsToFlip({});
console.log(`3  accept-rate flip: starts on ${flip.startsWith}; after ${flip.flippedAfter} rejected proposals chooses ${flip.flippedTo} (local P = ${flip.P?.toFixed(3)})`);
const dl = await simulate({ seed: 1, jobOver: { deadlineMs: 6000 }, routesOver: { "local-idle": { serviceMs: 900 } } });
show("4a deadline 6000ms, local idle (900ms)", dl.trace);
let acc = 0, esc = 0; const N4 = 200;
for (let sd = 1; sd <= N4; sd++) { const t = (await simulate({ seed: sd, jobOver: { deadlineMs: 6000 }, routesOver: { "local-idle": { serviceMs: 900, sim: { stall: true } } } })).trace; if (t.attempts[0].failureKind === "deadline_risk" && t.attempts[1]) esc++; if (t.final.state === "accepted") acc++; }
console.log(`4b same deadline, but local-idle stalls (${N4} seeds): first attempt abandoned as deadline_risk and escalated in ${esc}/${N4}; job accepted before the deadline in ${acc}/${N4} (the rest: the escalated route's own proposal failed the local checks, which is its ~5% / 20% error rate)`);
const priv = await simulate({ seed: 1, jobOver: { disclosure: "none", privacy: "local-raw" }, routesOver: { "local-idle": { sim: { quality: 0 } }, "local-saturated": { reachable: false } } });
show("5 disclosure none, local always wrong", priv.trace, `remote/device called: ${priv.calls.some((c) => c.route === "remote" || c.route === "device")}  gap=${priv.trace.final.gap?.about ?? "-"}`);

console.log("\n== sensitivity: who is chosen first at the 0.5 prior, by local service time (remote raw = 450+700 = 1150ms)");
console.log("local serviceMs : chosen   (raw local vs remote; at the prior both P=0.5, so the lower raw time wins)");
for (const ms of [500, 900, 1100, 1150, 1300, 2000, 4000]) {
  const c = choose(simJob(), simRoutes({ "local-idle": { serviceMs: ms } }), createRouteStats({}));
  console.log(`${String(ms).padStart(15)} : ${c.route.id}`);
}
console.log("with exposurePenaltyMs (an ASSUMED preference for keeping data home):");
for (const pen of [0, 500, 1700, 3000]) {
  const c = choose(simJob(), simRoutes({ "local-idle": { serviceMs: 2000 } }), createRouteStats({}), { exposurePenaltyMs: pen });
  console.log(`  penalty ${String(pen).padStart(4)}ms/rank, local serviceMs 2000 : ${c.route.id}`);
}

console.log(`\n== non-stationary dynamics: local quality 0.9 (150 jobs) -> 0.1 (150) -> 0.9 (300); remote 0.8; ${seeds} seeds`);
const ci = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); return [m, 1.96 * sd / Math.sqrt(xs.length)]; };
const policies = { "greedy (no decay)": {}, "greedy, halfLife 30": { halfLife: 30 }, "thompson": { explore: "thompson" }, "thompson, halfLife 60": { explore: "thompson", halfLife: 60 } };
console.log("policy".padEnd(24) + "accepted".padEnd(16) + "ms/job".padEnd(18) + "switches".padEnd(16) + "local-first share  A / B(degraded) / C(recovered)");
for (const [name, policy] of Object.entries(policies)) {
  const rs = [];
  for (let s = 1; s <= seeds; s++) rs.push(await nonstationary({ policy, seed: s }));
  const f = (g, d = 3) => { const [m, h] = ci(rs.map(g)); return `${m.toFixed(d)}±${h.toFixed(d)}`; };
  console.log(name.padEnd(24) + f((r) => r.acceptedRate).padEnd(16) + f((r) => r.meanMsPerJob, 0).padEnd(18) + f((r) => r.switches, 1).padEnd(16) + [0, 1, 2].map((i) => f((r) => r.phaseLocalShare[i], 2)).join(" / "));
}
