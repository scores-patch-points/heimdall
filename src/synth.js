// synth.js — no model at all. Bottom-up enumerative program synthesis from input/output examples over a
// small GENERIC library (string, array, arithmetic, counting; no function-specific primitive), with observational
// equivalence pruning and a greedy decision list for conditionals. The same cases the model arms were checked on,
// plus held-out cases to catch overfitting.
const sig = (v) => JSON.stringify(v)
const ok = (v) => v !== undefined && !(typeof v === "number" && !Number.isFinite(v))
const ev = (f, ...a) => { try { const r = f(...a); return ok(r) ? r : undefined } catch { return undefined } }

const BASE = [
  { name: "lower", args: ["S"], ret: "S", fn: (s) => s.toLowerCase(), code: (s) => `${s}.toLowerCase()` },
  { name: "trim", args: ["S"], ret: "S", fn: (s) => s.trim(), code: (s) => `${s}.trim()` },
  { name: "alnum", args: ["S"], ret: "S", fn: (s) => s.replace(/[^a-z0-9]/gi, ""), code: (s) => `${s}.replace(/[^a-z0-9]/gi, "")` },
  { name: "dashruns", args: ["S"], ret: "S", fn: (s) => s.replace(/[^a-z0-9]+/g, "-"), code: (s) => `${s}.replace(/[^a-z0-9]+/g, "-")` },
  { name: "trimdash", args: ["S"], ret: "S", fn: (s) => s.replace(/^-+|-+$/g, ""), code: (s) => `${s}.replace(/^-+|-+$/g, "")` },
  { name: "punct", args: ["S"], ret: "S", fn: (s) => s.replace(/[^\w\s]/g, ""), code: (s) => `${s}.replace(/[^\w\s]/g, "")` },
  { name: "revS", args: ["S"], ret: "S", fn: (s) => [...s].reverse().join(""), code: (s) => `[...${s}].reverse().join("")` },
  { name: "splitws", args: ["S"], ret: "AS", fn: (s) => s.split(/\s+/), code: (s) => `${s}.split(/\\s+/)` },
  { name: "splitnw", args: ["S"], ret: "AS", fn: (s) => s.split(/\W+/), code: (s) => `${s}.split(/\\W+/)` },
  { name: "chars", args: ["S"], ret: "AS", fn: (s) => s.split(""), code: (s) => `${s}.split("")` },
  { name: "nonempty", args: ["AS"], ret: "AS", fn: (a) => a.filter((x) => x.length > 0), code: (a) => `${a}.filter((x) => x.length > 0)` },
  { name: "join", args: ["AS"], ret: "S", fn: (a) => a.join(""), code: (a) => `${a}.join("")` },
  { name: "freq", args: ["AS"], ret: "O", fn: (a) => { const o = {}; for (const x of a) o[x] = (o[x] ?? 0) + 1; return o }, code: (a) => `${a}.reduce((o, x) => ((o[x] = (o[x] ?? 0) + 1), o), {})` },
  { name: "lenS", args: ["S"], ret: "N", fn: (s) => s.length, code: (s) => `${s}.length` },
  { name: "lenA", args: ["A"], ret: "N", fn: (a) => a.length, code: (a) => `${a}.length` },
  { name: "sum", args: ["A"], ret: "N", fn: (a) => a.reduce((x, y) => x + y, 0), code: (a) => `${a}.reduce((x, y) => x + y, 0)` },
  { name: "max", args: ["A"], ret: "N", fn: (a) => Math.max(...a), code: (a) => `Math.max(...${a})` },
  { name: "sortnum", args: ["A"], ret: "A", fn: (a) => [...a].sort((x, y) => x - y), code: (a) => `[...${a}].sort((x, y) => x - y)` },
  { name: "uniq", args: ["A"], ret: "A", fn: (a) => [...new Set(a)], code: (a) => `[...new Set(${a})]` },
  { name: "revA", args: ["A"], ret: "A", fn: (a) => [...a].reverse(), code: (a) => `[...${a}].reverse()` },
  { name: "add", args: ["N", "N"], ret: "N", fn: (a, b) => a + b, code: (a, b) => `(${a} + ${b})` },
  { name: "sub", args: ["N", "N"], ret: "N", fn: (a, b) => a - b, code: (a, b) => `(${a} - ${b})` },
  { name: "mul", args: ["N", "N"], ret: "N", fn: (a, b) => a * b, code: (a, b) => `(${a} * ${b})` },
  { name: "mod", args: ["N", "N"], ret: "N", fn: (a, b) => a % b, code: (a, b) => `(${a} % ${b})` },
  { name: "str", args: ["N"], ret: "S", fn: (n) => String(n), code: (n) => `String(${n})` },
  { name: "eqN", args: ["N", "N"], ret: "B", fn: (a, b) => a === b, code: (a, b) => `(${a} === ${b})` },
  { name: "ltN", args: ["N", "N"], ret: "B", fn: (a, b) => a < b, code: (a, b) => `(${a} < ${b})` },
  { name: "eqS", args: ["S", "S"], ret: "B", fn: (a, b) => a === b, code: (a, b) => `(${a} === ${b})` },
  { name: "not", args: ["B"], ret: "B", fn: (a) => !a, code: (a) => `!${a}` },
]

export const tyOf = (v) => typeof v === "string" ? "S" : typeof v === "number" ? "N" : typeof v === "boolean" ? "B" : Array.isArray(v) ? (v.length && typeof v[0] === "string" ? "AS" : v.length && Array.isArray(v[0]) ? "AA" : "A") : "O"

export const synth = (names, ex, { budgetMs = 20000, maxSize = 8, learned = [] } = {}) => {
  const P = [...BASE, ...learned]
  const t0 = Date.now()
  const outTy = tyOf(ex[0].out)
  const pool = new Map()
  const seen = new Set()
  const add = (t, ty = t.ty) => {
    if (t.vals.some((v) => v === undefined)) return false
    const key = ty + sig(t.vals)
    if (seen.has(key)) return false
    seen.add(key)
    if (!pool.has(ty)) pool.set(ty, [])
    pool.get(ty).push(t)
    return true
  }
  names.forEach((n, i) => add({ code: n, ty: tyOf(ex[0].args[i]), size: 1, vals: ex.map((e) => e.args[i]) }))
  const consts = [[0, "0"], [1, "1"], [2, "2"], [3, "3"], [5, "5"], [15, "15"], ["", '""'], ["-", '"-"']]
  const outs = new Set()
  for (const e of ex) if (typeof e.out === "string" || typeof e.out === "number") outs.add(JSON.stringify(e.out))
  for (const o of outs) consts.push([JSON.parse(o), o])
  for (const [v, code] of consts) add({ code, ty: tyOf(v), size: 1, vals: ex.map(() => v) })
  const bySize = new Map()
  const record = (t) => { if (!bySize.has(t.size)) bySize.set(t.size, []); bySize.get(t.size).push(t) }
  for (const ts of pool.values()) ts.forEach(record)
  const solved = (t) => t.ty === outTy && sig(t.vals) === sig(ex.map((e) => e.out))
  for (const t of bySize.get(1) ?? []) if (solved(t)) return { code: t.code, size: 1 }
  for (let size = 2; size <= maxSize; size++) {
    for (const p of P) {
      const ar = p.args.length
      const comps = (rem, i, chosen) => {
        if (i === ar) return rem === 0 ? [chosen] : []
        const out = []
        for (let s = 1; s <= rem - (ar - i - 1); s++)
          for (const t of (bySize.get(s) ?? []).filter((x) => x.ty === p.args[i])) {
            if (Date.now() - t0 > budgetMs) return out
            out.push(...comps(rem - s, i + 1, [...chosen, t]))
          }
        return out
      }
      for (const args of comps(size - 1, 0, [])) {
        if (Date.now() - t0 > budgetMs) return { timeout: true }
        const vals = ex.map((_, k) => ev(p.fn, ...args.map((a) => a.vals[k])))
        const t = { code: p.code(...args.map((a) => a.code)), ty: p.ret, size, vals }
        if (add(t)) { record(t); if (solved(t)) return { code: t.code, size } }
      }
    }
  }
  // decision list: greedy cover with (condition, value) pairs; first matching condition wins
  const conds = [...pool.get("B") ?? []]
  const values = [...pool.get(outTy) ?? []]
  const target = ex.map((e) => e.out)
  let remaining = ex.map((_, i) => i)
  const chain = []
  while (remaining.length) {
    let best
    for (const v of values) {
      const good = remaining.filter((i) => sig([v.vals[i]]) === sig([target[i]]))
      if (!good.length) continue
      if (good.length === remaining.length) { if (!best || best.c) best = { c: null, v, cover: good } ; continue }
      for (const c of conds) {
        const hit = remaining.filter((i) => c.vals[i] === true)
        if (!hit.length || hit.some((i) => sig([v.vals[i]]) !== sig([target[i]]))) continue
        if (!best || (best.c && hit.length > best.cover.length) || (!best.c && false)) best = { c, v, cover: hit }
      }
    }
    if (!best) return { code: undefined, note: "decision list stuck" }
    chain.push([best.c, best.v])
    remaining = remaining.filter((i) => !best.cover.includes(i))
    if (!best.c) break
  }
  const last = chain.pop()
  let code = last[1].code
  for (const [c, v] of chain.reverse()) code = `(${c.code} ? ${v.code} : ${code})`
  return { code, size: -1 }
}
