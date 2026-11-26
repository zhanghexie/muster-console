// 点击 window.__benchClick 坐标并 dump 计数+触发栈: node clickdump.mjs <port>
const port = process.argv[2] || '9333';
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && /localhost/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evl = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description?.slice(0, 300)); return r.result.result?.value; };
await new Promise((r) => { ws.onopen = r; });
await cdp('Runtime.enable');
const t = JSON.parse(await evl('JSON.stringify(window.__benchClick)'));
console.log('click at', t);
for (const type of ['mousePressed', 'mouseReleased']) { await cdp('Input.dispatchMouseEvent', { type, x: t.x, y: t.y, button: 'left', clickCount: 1 }); }
await new Promise((r) => setTimeout(r, 1200));
const dump = await evl('JSON.stringify({counts: window.__perf.counts, stacks: window.__perf.stacks.slice(0, 10)})');
const d = JSON.parse(dump);
console.log('counts:', d.counts);
console.log('\n触发栈（前 10 个 ChatTranscript 渲染）:');
for (const s of d.stacks) console.log(`\n-- ${s.name} --\n${s.stack}`);
ws.close(); process.exit(0);
