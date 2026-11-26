// perf-capture.jsonl 中场/终场分析器: node analyze.mjs [jsonl路径]
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || path.join(import.meta.dirname, 'perf-capture.jsonl');
const since = process.argv[3] || '';
let lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (since) lines = lines.filter((d) => d.wall >= since);

const longtasks = [], events = [], frameGaps = [], interactions = [], seconds = [];
let t0 = null, tEnd = 0;
for (const d of lines) {
  if (t0 === null) t0 = d.elapsed;
  tEnd = Math.max(tEnd, d.elapsed);
  longtasks.push(...d.longtasks); events.push(...d.events);
  frameGaps.push(...d.frameGaps); interactions.push(...d.interactions);
  seconds.push(...d.seconds);
}
// seconds 去重（跨 drain 重复的桶保留最新）
const secMap = new Map();
for (const s of seconds) secMap.set(s.sec, s);
const spanMin = ((tEnd - t0) / 60000).toFixed(1);

const q = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
const fmt = (t) => `+${((t - t0) / 1000).toFixed(1)}s`;

// 把时间点关联到最近的用户交互（前面 3s 内）
const nearestInteraction = (t) => {
  let best = null;
  for (const it of interactions) {
    if (it.t <= t && t - it.t < 3000 && (!best || t - it.t < t - best.t)) best = it;
  }
  return best;
};

console.log(`\n===== 采集窗口 ${spanMin} 分钟（wall ${lines[0]?.wall?.slice(11, 19)} → ${lines.at(-1)?.wall?.slice(11, 19)} UTC）=====`);
console.log(`用户交互 ${interactions.length} 次 | 长任务 ${longtasks.length} 个 | >100ms 帧间隙 ${frameGaps.length} 个 | event timing ${events.length} 条\n`);

// 交互时间线（合并同目标连击）
console.log('--- 交互时间线 ---');
let lastKey = '', count = 0;
const flush = () => { if (lastKey) console.log(`${lastKey}${count > 1 ? ` ×${count}` : ''}`); };
for (const it of interactions) {
  const key = `${fmt(it.t)}  ${it.type.padEnd(11)} ${it.target}`;
  if (key.slice(0, 8) === lastKey.slice(0, 8) && it.type === lastKey.split('  ')[1]?.trim() && it.target === lastKey.split('  ')[2]) count++;
  else { flush(); lastKey = key; count = 1; }
}
flush();

console.log('\n--- 长任务 TOP15（>50ms，按耗时）---');
for (const lt of longtasks.sort((a, b) => b.dur - a.dur).slice(0, 15)) {
  const it = nearestInteraction(lt.t);
  console.log(`${fmt(lt.t).padEnd(9)} ${String(lt.dur).padStart(4)}ms  ${lt.src || lt.name}${it ? `   ← ${it.type} ${it.target.slice(0, 60)} (${((lt.t - it.t) / 1000).toFixed(1)}s 前)` : ''}`);
}

console.log('\n--- 帧间隙 TOP15（>100ms）---');
for (const g of frameGaps.sort((a, b) => b.gap - a.gap).slice(0, 15)) {
  const it = nearestInteraction(g.t);
  console.log(`${fmt(g.t).padEnd(9)} ${String(g.gap).padStart(4)}ms${it ? `   ← ${it.type} ${it.target.slice(0, 60)} (${((g.t - it.t) / 1000).toFixed(1)}s 前)` : ''}`);
}

console.log('\n--- 交互延迟（event timing, duration≥16ms）---');
if (events.length) {
  const durs = events.map((e) => e.durs ?? e.dur);
  const procs = events.map((e) => e.proc).filter((x) => x >= 0);
  console.log(`样本 ${events.length} | duration p50=${q(durs, .5)}ms p90=${q(durs, .9)}ms p99=${q(durs, .99)}ms max=${Math.max(...durs)}ms`);
  if (procs.length) console.log(`输入→处理延迟 p50=${q(procs, .5)}ms p90=${q(procs, .9)}ms max=${Math.max(...procs)}ms`);
  console.log('最差 10 次:');
  for (const e of events.sort((a, b) => b.dur - a.dur).slice(0, 10)) console.log(`${fmt(e.t).padEnd(9)} ${String(e.dur).padStart(4)}ms (${e.name}, 输入延迟${e.proc}ms)`);
} else console.log('（无）');

console.log('\n--- 掉帧秒（fps<50 或 maxGap>50ms 的秒）---');
const bad = [...secMap.values()].filter((s) => s.frames < 50 || s.maxGap > 50);
console.log(bad.length ? bad.map((s) => `sec${s.sec}: ${s.frames}fps maxGap=${s.maxGap}ms`).join('\n') : '（无）');

console.log(`\n--- 汇总 ---`);
const allGaps = frameGaps.map((g) => g.gap);
console.log(`长任务: n=${longtasks.length} p50=${q(longtasks.map(l=>l.dur),.5)} p90=${q(longtasks.map(l=>l.dur),.9)} max=${longtasks.length?Math.max(...longtasks.map(l=>l.dur)):0}ms`);
console.log(`帧间隙>100ms: n=${frameGaps.length} max=${allGaps.length?Math.max(...allGaps):0}ms`);
