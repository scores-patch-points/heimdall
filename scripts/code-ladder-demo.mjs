// Runs the code ladder on 8 small functions with a REAL local model (ollama) and a SIMULATED frontier (a table of
// reference solutions, standing in for the cheapest frontier model: no API key is used). Two passes: the second asks the
// same functions under new names and wordings, to measure how much the first pass taught the mechanical lane.
import { createCodeLadder } from "../src/code-ladder.js";
import { createLessons } from "../src/lessons.js";
import { hostLoad } from "../src/code-ladder.js";
const MODEL = process.env.LOCAL_MODEL ?? "qwen2.5-coder:1.5b";
const T = [
  ["slugify", ["s"], "lowercase s, replace each run of non-alphanumeric characters with one '-', remove '-' from both ends", [[["Hello, World!"], "hello-world"], [["  a  b "], "a-b"], [["X--Y"], "x-y"], [["--a--"], "a"], [["Foo  Bar_Baz"], "foo-bar-baz"], [["!!x!!"], "x"], [["A1 b2"], "a1-b2"]], `function slugify(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")}`],
  ["sum", ["a"], "the sum of the numbers in the array; 0 for empty", [[[[1, 2, 3]], 6], [[[]], 0], [[[-1, 1]], 0], [[[10, 20]], 30], [[[5]], 5], [[[2, 2]], 4]], `function sum(a){return a.reduce((x,y)=>x+y,0)}`],
  ["isPalindrome", ["s"], "true if s reads the same forwards and backwards, ignoring case and non-alphanumeric characters", [[["Racecar"], true], [["abc"], false], [[""], true], [["A man, a plan, a canal: Panama"], true], [["No lemon, no melon"], true], [["hello"], false], [["Abba!"], true]], `function isPalindrome(s){const t=s.toLowerCase().replace(/[^a-z0-9]/g,"");return t===[...t].reverse().join("")}`],
  ["fizz", ["n"], "'FizzBuzz' if n divisible by 15, 'Fizz' if by 3, 'Buzz' if by 5, otherwise String(n)", [[[15], "FizzBuzz"], [[9], "Fizz"], [[10], "Buzz"], [[7], "7"], [[30], "FizzBuzz"], [[3], "Fizz"], [[25], "Buzz"], [[11], "11"]], `function fizz(n){return n%15===0?"FizzBuzz":n%3===0?"Fizz":n%5===0?"Buzz":String(n)}`],
  ["chunk", ["a", "n"], "split arr into consecutive arrays of length n; the last may be shorter", [[[[1, 2, 3, 4, 5], 2], [[1, 2], [3, 4], [5]]], [[[], 3], []], [[[1, 2], 5], [[1, 2]]], [[[1, 2, 3], 1], [[1], [2], [3]]], [[[1, 2, 3, 4], 2], [[1, 2], [3, 4]]], [[[1, 2, 3, 4, 5, 6, 7], 3], [[1, 2, 3], [4, 5, 6], [7]]]], `function chunk(a,n){const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o}`],
  ["uniqueSorted", ["a"], "the distinct numbers in ascending numeric order", [[[[3, 1, 2, 3, 1]], [1, 2, 3]], [[[10, 9, 100]], [9, 10, 100]], [[[]], []], [[[5, 5, 4]], [4, 5]], [[[20, 3, 3]], [3, 20]], [[[1]], [1]]], `function uniqueSorted(a){return [...new Set(a)].sort((x,y)=>x-y)}`],
  ["wordCount", ["s"], "an object mapping each lowercase word to its count; punctuation ignored", [[["a b a"], { a: 2, b: 1 }], [["Hi, hi!"], { hi: 2 }], [[""], {}], [["Go go GO."], { go: 3 }], [["x y"], { x: 1, y: 1 }], [["a, b; a"], { a: 2, b: 1 }]], `function wordCount(s){const o={};for(const w of s.toLowerCase().split(/\\W+/).filter(Boolean))o[w]=(o[w]??0)+1;return o}`],
  ["romanToInt", ["s"], "convert a Roman numeral (with subtractive pairs like IV and CM) to an integer", [[["III"], 3], [["IV"], 4], [["MCMXCIV"], 1994], [["LVIII"], 58], [["IX"], 9], [["XLII"], 42]], `function romanToInt(s){const v={I:1,V:5,X:10,L:50,C:100,D:500,M:1000};let t=0;for(let i=0;i<s.length;i++){const a=v[s[i]],b=v[s[i+1]]??0;t+=a<b?-a:a}return t}`],
];
const reference = new Map(T.map((t) => [t[0], t[4]]));
const calls = { local: 0, remote: 0 };
let current = "";
const ladder = createCodeLadder({
  lessons: createLessons(),
  load: process.env.FORCE_LOCAL === "1" ? ({ inflight }) => hostLoad({ inflight, loadavg: 0, freeMemRatio: 1 }) : undefined, // default: read this machine honestly
  localModels: [MODEL],
  remoteModels: ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5"],
  infer: {
    local: async (model, prompt) => {
      calls.local++;
      const r = await fetch("http://127.0.0.1:11434/api/chat", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false, options: { temperature: 0.2, num_ctx: 4096 } }), signal: AbortSignal.timeout(60_000) }).then((r) => r.json());
      return { text: r.message?.content ?? "", tokens: (r.prompt_eval_count ?? 0) + (r.eval_count ?? 0) };
    },
    remote: async () => { calls.remote++; return { text: "```js\n" + reference.get(current) + "\n```" }; }, // SIMULATED frontier
  },
});
const pass = async (label, rename) => {
  const lanes = {}; let ok = 0; const before = { ...calls };
  for (const [name, params, spec, examples] of T) {
    current = name;
    const n = rename ? `${name}_v2` : name;
    // the reference table is keyed by the original name; the frontier answer is renamed to the asked name
    const r = await ladder.solve({ name: n, params, spec: rename ? `(reworded) ${spec}` : spec, examples: examples.map(([args, out]) => ({ args, out })) });
    ok += r.ok ? 1 : 0;
    const lane = (r.lane ?? "none").replace(/:.*/, "") + (r.via?.startsWith("lesson") ? "(lesson)" : r.via === "synth" ? "(search)" : "");
    lanes[lane] = (lanes[lane] ?? 0) + 1;
    console.log(`  ${n.padEnd(16)} ${r.ok ? "ok " : "FAIL"} via ${r.via ?? "-"}`);
  }
  console.log(`${label}: ${ok}/${T.length} accepted · lanes ${JSON.stringify(lanes)} · local calls ${calls.local - before.local} · frontier calls ${calls.remote - before.remote}\n`);
};
const origSolve = ladder.solve.bind(ladder);
ladder.solve = (spec) => { if (spec.name.endsWith("_v2")) { const base = spec.name.slice(0, -3); reference.set(spec.name, reference.get(base).replace(new RegExp(`\\b${base}\\b`, "g"), spec.name)); current = spec.name; } return origSolve(spec); };
await pass("PASS 1 (empty lessons)", false);
await pass("PASS 2 (same functions, new names and wording)", true);
console.log("lessons stored:", ladder.lessons.all().length);
