// CDP CPU Profiler：连主窗口 page target，采样渲染主线程，STOP-PROFILE 文件或超时后落盘 .cpuprofile
// 同时收集 console error/warning 与未捕获异常，带时间戳，用于和长任务对齐
// 用法: node profiler.mjs <port> <outDir> [durationSec]
import fs from 'node:fs';
import path from 'node:path';

const port = process.argv[2] || '54779';
const outDir = process.argv[3] || '.';
const durationSec = Number(process.argv[4] || 720);
const stopFile = path.join(outDir, 'STOP-PROFILE');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && /app\.asar.*index\.html/.test(t.url))
  || targets.find((t) => t.type === 'page' && /localhost/.test(t.url)); // dev 实例 fallback（recorder.mjs 用更宽的谓词，这里只取主窗口）
if (!page) { console.error('[profiler] 未找到主窗口'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 20000);
});
const consoleLog = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg);
  } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(msg.params.type)) {
    consoleLog.push({ wall: new Date().toISOString(), type: msg.params.type, text: msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500) });
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleLog.push({ wall: new Date().toISOString(), type: 'exception', text: (d.exception?.description || d.text || '').slice(0, 500) });
  }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = (e) => reject(new Error('ws: ' + e.message)); });

await cdp('Runtime.enable');
await cdp('Profiler.enable');
await cdp('Profiler.setSamplingInterval', { interval: 10000 }); // 10ms 采样
await cdp('Profiler.start');
const t0 = Date.now();
console.log(`[profiler] ✅ CPU 采样开始（10ms 间隔，最长 ${durationSec}s，放 STOP-PROFILE 文件提前结束）`);

let profile = null;
while (Date.now() - t0 < durationSec * 1000) {
  await sleep(2000);
  if (fs.existsSync(stopFile)) { fs.unlinkSync(stopFile); break; }
  if ((Math.round((Date.now() - t0) / 1000)) % 20 < 2) console.log(`[profiler] … ${Math.round((Date.now() - t0) / 1000)}s | console异常 ${consoleLog.length} 条`);
}
try {
  const r = await cdp('Profiler.stop');
  profile = r.result.profile;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const profPath = path.join(outDir, `cpu-${stamp}.cpuprofile`);
  fs.writeFileSync(profPath, JSON.stringify(profile));
  fs.writeFileSync(profPath.replace('.cpuprofile', '-console.json'), JSON.stringify(consoleLog, null, 2));
  const totalMs = ((profile.endTime - profile.startTime) / 1000).toFixed(0);
  console.log(`[profiler] 🏁 采样 ${totalMs}ms，样本 ${profile.samples.length}，已存 ${profPath}`);
} catch (e) {
  console.error('[profiler] stop 失败:', e.message);
}
try { ws.close(); } catch {}
setTimeout(() => process.exit(0), 300);
