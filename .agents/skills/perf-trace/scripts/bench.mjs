// 沙盒基准: node bench.mjs [outDir] [--skip-seed] [--no-reload]
// 步骤: reload → 确认 __perf → (可选)造 pi 会话+markdown 消息 → 依次 B1..B4，每步 reset/动作/wait/dump
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = '9333';
const outDir = process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1] && !a.endsWith('bench.mjs')) || path.join(os.tmpdir(), 'metaagent-perf');
const SKIP_SEED = process.argv.includes('--skip-seed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && /localhost/.test(t.url));
if (!page) { console.error('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
});
const evaluate = async (expression, awaitPromise = true) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.result.exceptionDetails) throw new Error('page-eval: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result.result?.value;
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = (e) => j(new Error('ws ' + e.message)); });
await cdp('Page.enable');
await cdp('Runtime.enable');

// 1) reload 让 TEMP-PERF 埋点生效（--no-reload 跳过：页面已是新模块）
if (!process.argv.includes('--no-reload')) {
  await cdp('Page.reload');
  for (let i = 0; i < 40; i++) { await sleep(500); if (await evaluate('typeof window.__perf', false) === 'object') break; }
  if ((await evaluate('typeof window.__perf', false)) !== 'object') { console.error('window.__perf 未就绪（HMR/埋点未生效）'); process.exit(1); }
}
console.log('[bench] __perf 就绪');

const MD_MSG = `先看这段：装好后用 \`npm run dev\` 启动，注意 5188 端口。

\`\`\`ts
// 示例代码块
export function compute(input: string): number {
  let total = 0;
  for (let i = 0; i < input.length; i++) total += input.charCodeAt(i);
  return total;
}
\`\`\`

| 项目 | 状态 |
|---|---|
| 启动 | ok |
| 构建 | ok |

行内还有 \`METAAGENT_DEVTOOLS_PORT=9333\` 与路径 \`src/renderer/src/store.tsx\`。`;

// 2) 造数
let sessionId = null;
if (!SKIP_SEED) {
  const created = await evaluate(`(async()=>{
    const r = await window.api.sessions.create({ name:'perf-bench', runtime:'pi', guiMode:'default' });
    return JSON.stringify(r && (r.id || r.sessionId) ? { id: r.id || r.sessionId, keys: Object.keys(r).slice(0,12) } : r);
  })()`);
  console.log('[bench] create →', created);
  const c = JSON.parse(created || '{}');
  sessionId = c.id;
  for (let i = 0; i < 4; i++) {
    const sent = await evaluate(`(async()=>{ try { const r = await window.api.agentSession.send(${JSON.stringify(sessionId)}, ${JSON.stringify(MD_MSG + '\n\n第 ' + (i+1) + ' 条。')}); return 'ok:'+JSON.stringify(r).slice(0,120); } catch(e){ return 'ERR:'+e.message; } })()`);
    console.log(`[bench] send#${i+1} →`, sent);
    await sleep(600);
  }
  // 等 DOM
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const n = await evaluate(`document.querySelectorAll('.chat-turn-anchor').length + '/' + document.querySelectorAll('.md-body code').length`, false);
    console.log('[bench] DOM', n);
    if (n && !n.startsWith('0/') && !n.endsWith('/0')) break;
  }
}

// 3) 长任务观察器
await evaluate(`(() => { window.__benchTasks = []; new PerformanceObserver((l)=>{ for (const e of l.getEntries()) window.__benchTasks.push({t:Math.round(e.startTime), dur:Math.round(e.duration)}); }).observe({entryTypes:['longtask']}); return 'ok'; })()`, false);

const reset = () => evaluate(`window.__perf.reset(); window.__benchTasks.length = 0; 'ok'`, false);
const dump = (label) => evaluate(`JSON.stringify({ label: ${JSON.stringify(label)}, counts: {...window.__perf.counts}, tasks: window.__benchTasks.filter(x=>x.dur>=50) })`, false);

const rectOf = async (sel) => evaluate(`(()=>{ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2, w:r.width, h:r.height}); })()`, false);
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(40);
  }
};
const wheel = async (x, y, n) => { for (let i = 0; i < n; i++) { await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -240 }); await sleep(90); } };

const results = [];
const step = async (label, fn) => { await reset(); await sleep(250); const t0 = Date.now(); await fn(); await sleep(Math.max(0, 1100 - (Date.now() - t0))); results.push(JSON.parse(await dump(label))); };

await step('B1-点行内code', async () => { const r = JSON.parse((await rectOf('.md-body code')) || 'null'); if (r) { await click(r.x, r.y); await sleep(300); await click(r.x, r.y); } else console.log('  (无行内 code)'); });
await step('B2-点代码块', async () => { const r = JSON.parse((await rectOf('.md-body pre')) || 'null'); if (r) await click(r.x + Math.min(30, r.w / 2), r.y + 12); else console.log('  (无 pre)'); });
await step('B3-点左栏会话项', async () => { const r = JSON.parse((await rectOf('.session-item')) || 'null'); if (r) await click(r.x, r.y); else console.log('  (无 session-item)'); });
await step('B4-转录滚动', async () => { const r = JSON.parse((await rectOf('.chat-turn-anchor')) || 'null'); if (r) { await wheel(r.x, r.y, 6); await sleep(200); await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: 1200 }); } });

fs.writeFileSync(path.join(outDir, 'bench-result.json'), JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`\n== ${r.label} ==`);
  const cc = Object.entries(r.counts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  console.log('  counts:', cc.map(([k, v]) => `${k}=${v}`).join(' ') || '(无)');
  console.log('  longtasks:', r.tasks.map((t) => t.dur + 'ms').join(' ') || '(无)');
}
ws.close(); process.exit(0);
