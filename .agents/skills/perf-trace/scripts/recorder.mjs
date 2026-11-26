// MetaAgent 工作台 CDP 性能采集器
// 用法: node recorder.mjs <port> <outDir> [durationSec]
// 数据: perf-capture.jsonl（每2s一条增量）+ summary.json（结束时 CDP Performance 域指标快照差值）
// 停止: 在 outDir 放一个 STOP 文件，或等 durationSec 超时，或 SIGINT
import fs from 'node:fs';
import path from 'node:path';

const port = process.argv[2] || '54779';
const outDir = process.argv[3] || '.';
const durationSec = Number(process.argv[4] || 900);
const jsonlPath = path.join(outDir, 'perf-capture.jsonl');
const stopFile = path.join(outDir, 'STOP');
const summaryPath = path.join(outDir, 'summary.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 找主窗口 page target ----
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && /app\.asar.*index\.html/.test(t.url))
  || targets.find((t) => t.type === 'page' && t.url !== 'about:blank' && !/preview/.test(t.url));
if (!page) {
  console.error('[recorder] 未找到主窗口 page target', targets.map((t) => `${t.type}:${t.title}`).join(', '));
  process.exit(1);
}
console.log(`[recorder] target: ${page.title} | ${page.url}`);

// ---- CDP 连接 ----
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 15000);
  });

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg);
  }
};

const evalInPage = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page eval error');
  return r.result.result?.value;
};

// ---- 页面内探针（长任务 / 事件延迟 / 帧间隙 / 交互目标 / 可见性）----
const INSTALL = `(() => {
  if (window.__perfRec) return 'already';
  const S = { longtasks: [], events: [], frameGaps: [], interactions: [], visibility: [], seconds: new Map(), lastFrame: performance.now() };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries())
      S.longtasks.push({ t: Math.round(e.startTime), dur: Math.round(e.duration), name: e.name,
        src: (e.attribution && e.attribution[0] && (e.attribution[0].containerSrc || e.attribution[0].containerName)) || '' });
  }).observe({ entryTypes: ['longtask'] });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries())
      if (e.duration >= 16)
        S.events.push({ t: Math.round(e.startTime), name: e.name, dur: Math.round(e.duration),
          proc: Math.round(e.processingStart - e.startTime) });
  }).observe({ type: 'event', durationThreshold: 16 });
  const desc = (el) => {
    if (!(el instanceof Element)) return String(el).slice(0, 60);
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim())
      s += '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.');
    const label = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    if (label) s += '[' + label.slice(0, 40) + ']';
    return s.slice(0, 140);
  };
  for (const type of ['pointerdown', 'click', 'keydown', 'wheel'])
    addEventListener(type, (e) => S.interactions.push({ t: Math.round(performance.now()), type, target: desc(e.target) }),
      { capture: true, passive: true });
  const frame = (now) => {
    const gap = now - S.lastFrame; S.lastFrame = now;
    const sec = Math.floor(now / 1000);
    let b = S.seconds.get(sec); if (!b) { b = { frames: 0, maxGap: 0 }; S.seconds.set(sec, b); }
    b.frames++; if (gap > b.maxGap) b.maxGap = Math.round(gap);
    if (gap > 100) S.frameGaps.push({ t: Math.round(now), gap: Math.round(gap) });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => S.visibility.push({ t: Math.round(performance.now()), hidden: document.hidden }));
  window.__perfRec = { drain: () => JSON.stringify({
    elapsed: Math.round(performance.now()),
    longtasks: S.longtasks.splice(0), events: S.events.splice(0), frameGaps: S.frameGaps.splice(0),
    interactions: S.interactions.splice(0), visibility: S.visibility.splice(0),
    seconds: [...S.seconds.entries()].map(([sec, b]) => ({ sec, frames: b.frames, maxGap: b.maxGap }))
  }) };
  return 'installed';
})()`;

const DRAIN = 'window.__perfRec ? window.__perfRec.drain() : "MISSING"';

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = (e) => reject(new Error('ws error: ' + e.message));
});

let metrics0 = null;
const t0 = Date.now();
try {
  await cdp('Runtime.enable');
  await cdp('Performance.enable');
  console.log('[recorder] install ->', await evalInPage(INSTALL));
  metrics0 = await cdp('Performance.getMetrics');
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ startWall: new Date().toISOString(), target: page.url }, null, 2));
} catch (e) {
  console.error('[recorder] 初始化失败:', e.message);
  process.exit(1);
}

let totals = { longtasks: 0, worstTask: 0, events: 0, worstGap: 0, interactions: 0 };
console.log(`[recorder] ✅ 采集开始（最长 ${durationSec}s，放 STOP 文件可提前结束）。现在可以操作应用了。`);

const finish = async (reason) => {
  try {
    const last = JSON.parse(await evalInPage(DRAIN));
    fs.appendFileSync(jsonlPath, JSON.stringify({ wall: new Date().toISOString(), ...last }) + '\n');
    const metrics1 = await cdp('Performance.getMetrics');
    const pick = (m) => Object.fromEntries((m || []).result?.metrics?.map((x) => [x.name, x.value]) || []);
    const a = pick(metrics0), b = pick(metrics1);
    const diff = {};
    for (const k of Object.keys(b)) if (typeof b[k] === 'number' && typeof a[k] === 'number') diff[k] = Math.round((b[k] - a[k]) * 1000) / 1000;
    fs.writeFileSync(summaryPath, JSON.stringify({ reason, startWall: new Date(t0).toISOString(), endWall: new Date().toISOString(), totals, metricsDiff: diff }, null, 2));
    console.log(`[recorder] 🏁 结束（${reason}）。totals=${JSON.stringify(totals)}`);
  } catch (e) {
    console.error('[recorder] 收尾失败:', e.message);
  }
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', () => finish('sigint'));

let lostProbe = false;
while (Date.now() - t0 < durationSec * 1000) {
  await sleep(2000);
  if (fs.existsSync(stopFile)) { fs.unlinkSync(stopFile); await finish('stop-file'); break; }
  try {
    let raw = await evalInPage(DRAIN);
    if (raw === 'MISSING' || lostProbe) {
      console.log('[recorder] 探针丢失，重新注入…');
      await evalInPage(INSTALL); raw = await evalInPage(DRAIN); lostProbe = false;
    }
    const d = JSON.parse(raw);
    fs.appendFileSync(jsonlPath, JSON.stringify({ wall: new Date().toISOString(), ...d }) + '\n');
    totals.interactions += d.interactions.length;
    totals.events += d.events.length;
    totals.longtasks += d.longtasks.length;
    for (const x of d.longtasks) totals.worstTask = Math.max(totals.worstTask, x.dur);
    for (const x of d.frameGaps) totals.worstGap = Math.max(totals.worstGap, x.gap);
  } catch (e) {
    if (/ReferenceError|MISSING|Cannot read/.test(e.message)) { lostProbe = true; } 
    else console.error('[recorder] poll error:', e.message);
  }
  const el = Math.round((Date.now() - t0) / 1000);
  if (el % 14 < 2) console.log(`[recorder] … ${el}s | 长任务 ${totals.longtasks}（最差 ${totals.worstTask}ms）| 最大帧间隙 ${totals.worstGap}ms | 交互 ${totals.interactions}`);
}
if (Date.now() - t0 >= durationSec * 1000) await finish('timeout');
