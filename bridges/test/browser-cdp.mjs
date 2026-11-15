// Drive a headless Chrome (started with --remote-debugging-port=9333 and a throwaway --user-data-dir)
// through the DevTools protocol: open the browser node page and print window.__result when it is done.
//   node test/browser-cdp.mjs http://127.0.0.1:8790/app/web/index.html 120
const [url, wait] = [process.argv[2], Number(process.argv[3] || 90)];
const tabs = await (await fetch('http://127.0.0.1:${process.env.CDP_PORT || 9333}/json')).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const call = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await call('Page.navigate', { url });
for (let i = 0; i < wait; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await call('Runtime.evaluate', { expression: 'JSON.stringify(window.__result||null)', returnByValue: true });
  const v = r.result?.result?.value && JSON.parse(r.result.result.value);
  if (v?.done) { for (const [k, x] of v.steps) console.log(k + ':', typeof x === 'string' ? x : JSON.stringify(x)); console.log('OK', v.ok); break; }
  if (i === wait - 1) console.log('TIMEOUT', JSON.stringify(v));
}
ws.close();
