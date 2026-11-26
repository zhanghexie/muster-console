// CPU profile 归因: node profile-analyze.mjs <cpuprofile> <jsonl> <sinceISO> [ticksUs]
// ticksUs = 渲染进程启动参数 --time-ticks-at-unix-epoch 的负值绝对值（QPCµs→epochµs），
// 取法见 SKILL.md；缺省时跳过长任务窗口对齐（只看全程聚合）
import fs from 'node:fs';

const [profPath, jsonlPath, since, ticksArg] = process.argv.slice(2);
const prof = JSON.parse(fs.readFileSync(profPath, 'utf8'));
const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter((d) => !since || d.wall >= since);
const longtasks = lines.flatMap((d) => d.longtasks).sort((a, b) => a.dur - b.dur);
const windows = longtasks.filter((l) => l.dur >= 200).map((l) => [l.t, l.t + l.dur]);
console.log(`profile: ${(prof.endTime - prof.startTime) / 1000 | 0}ms, ${prof.samples.length} 样本; 长任务窗口(>=200ms): ${windows.length} 个\n`);

const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const urlOf = (n) => { const u = n.callFrame.url || ''; return u ? u.split('/').pop().slice(0, 60) : '(inline)'; };
const fnOf = (n) => `${n.callFrame.functionName || '(anonymous)'}@${urlOf(n)}:${n.callFrame.line + 1}`;

// self time（µs 累加，timeDeltas[i] 对应 samples[i]）
const selfUs = new Map(); // nodeId -> µs
let totalUs = 0;
for (let i = 0; i < prof.samples.length; i++) {
  const d = prof.timeDeltas[i] ?? 10;
  selfUs.set(prof.samples[i], (selfUs.get(prof.samples[i]) || 0) + d);
  totalUs += d;
}
const ms = (us) => (us / 1000).toFixed(1);
const agg = (entries, keyFn, topN = 25) => {
  const m = new Map();
  for (const [id, us] of entries) {
    const k = keyFn(byId.get(id));
    m.set(k, (m.get(k) || 0) + us);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
};
console.log(`== 全程 self-time Top（总 ${ms(totalUs)}ms 采样）==`);
for (const [k, us] of agg(selfUs, fnOf)) console.log(`${String(ms(us)).padStart(8)}ms ${(100 * us / totalUs).toFixed(1).padStart(5)}%  ${k}`);
console.log(`\n== 全程按文件 ==`);
for (const [k, us] of agg(selfUs, (n) => urlOf(n), 15)) console.log(`${String(ms(us)).padStart(8)}ms ${(100 * us / totalUs).toFixed(1).padStart(5)}%  ${k}`);

// 长任务窗口内样本（对齐：epochµs = (perfNowMs + originMs)*1000，origin 由 jsonl 首行 wall-elapsed 反推）
if (windows.length && ticksArg) {
  const ticksUs = Number(ticksArg);
  const abs = [];
  let t = prof.startTime;
  for (let i = 0; i < prof.samples.length; i++) { t += prof.timeDeltas[i] ?? 10; abs.push(t); }
  const first = lines.find((d) => d.elapsed != null);
  const originMs = Date.parse(first.wall) - first.elapsed;
  const winUs = windows.map(([s, e]) => [(s + originMs) * 1000, (e + originMs) * 1000]);
  const pick = (offUs) => {
    const inWin = new Map(); let hit = 0;
    for (let i = 0; i < prof.samples.length; i++) {
      const a = abs[i] + offUs;
      if (winUs.some(([s, e]) => a >= s && a <= e)) { hit++; inWin.set(prof.samples[i], (inWin.get(prof.samples[i]) || 0) + (prof.timeDeltas[i] ?? 10)); }
    }
    return { hit, inWin };
  };
  let off = ticksUs, r = pick(off);
  if (r.hit < 10) { // 漂移兜底：±180s 内 1s 步进找最优偏移
    let best = r;
    for (let o = ticksUs - 180000000; o <= ticksUs + 180000000; o += 1000000) { const c = pick(o); if (c.hit > best.hit) { best = c; off = o; } }
    r = best;
  }
  console.log(`\n== 长任务窗口内采样：${r.hit}/${prof.samples.length}（对齐偏移 ${Math.round(off / 1000)}ms）==`);
  if (r.hit > 5) {
    for (const [k, us] of agg([...r.inWin.entries()], fnOf)) console.log(`${String(ms(us)).padStart(8)}ms  ${k}`);
    console.log(`-- 窗口内按文件 --`);
    for (const [k, us] of agg([...r.inWin.entries()], (n) => urlOf(n), 12)) console.log(`${String(ms(us)).padStart(8)}ms  ${k}`);
    // 窗口内全栈出现率（沿 parent 链累计，展示调用路径）
    const stackUs = new Map();
    for (const [id, us] of r.inWin.entries()) {
      let cur = byId.get(id);
      const seen = new Set();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        stackUs.set(cur.id, (stackUs.get(cur.id) || 0) + us);
        cur = cur.parent ? byId.get(cur.parent) : null;
      }
    }
    console.log(`-- 窗口内全栈 Top（含祖先帧）--`);
    for (const [k, us] of agg([...stackUs.entries()], fnOf, 30)) console.log(`${String(ms(us)).padStart(8)}ms  ${k}`);
  }
}
