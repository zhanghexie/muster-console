#!/usr/bin/env node
/**
 * 可靠性与易用性专项 · 进度看板生成器
 * 从 docs/plans/reliability-usability-campaign-2026-10-25.md（唯一真源）解析状态账本，
 * 生成自包含 HTML 看板 docs/plans/campaign-dashboard.html。
 * 用法：node scripts/campaign-dashboard.mjs   （每批更新账本后必跑）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(root, 'docs/plans/reliability-usability-campaign-2026-10-25.md');
const OUT = join(root, 'docs/plans/campaign-dashboard.html');

const md = readFileSync(LEDGER, 'utf8');
const lines = md.split(/\r?\n/);

/** 把 `| a | b | c |` 拆成单元格数组（去首尾空管道）。 */
function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
}

/** 单元格状态判定。 */
const isDone = (s) => s.includes('✅');
const isSkipped = (s) => s.startsWith('跳过');

// ---- 解析域表（### Dxx 名称 · TierN 之后的表格行）----
const domains = [];
let cur = null;
for (const line of lines) {
  const dm = line.match(/^### (D\d+)\s*(.*?)\s*·\s*Tier(\d)/);
  if (dm) {
    cur = { id: dm[1], name: dm[2], tier: Number(dm[3]), features: [], plan: null };
    domains.push(cur);
    continue;
  }
  if (cur) {
    // `> 计划：[名称](路径)` —— 域级修复计划登记行
    const pm = line.match(/^>\s*计划：\s*\[([^\]]+)\]\(([^)]+)\)/);
    if (pm) {
      cur.plan = { text: pm[1], href: pm[2] };
      continue;
    }
  }
  if (cur && line.trim().startsWith('|')) {
    const c = cells(line);
    // 功能 | 意图 | 审 | 发现 | 终态 | 备注
    if (c.length >= 6 && c[0] !== '功能' && !c[0].startsWith('---')) {
      const nm = c[0].match(/\[([^\]]+)\]\(([^)]+)\)/);
      const found = c[3].split('/').map((n) => Number(n) || 0);
      while (found.length < 6) found.push(0);
      const name = nm ? nm[1] : c[0];
      const docHref = nm ? nm[2] : null;
      const auditHref = existsSync(join(root, 'docs/audits/reliability', `${name}.md`))
        ? `../audits/reliability/${name}.md`
        : null;
      const intent = isDone(c[1]) ? 'done' : c[1].includes('草案') ? 'draft' : 'pending';
      const reviewed = isDone(c[2]) ? 'done' : c[2].includes('审中') || c[2] === '进行' ? 'doing' : 'pending';
      cur.features.push({
        name,
        docHref,
        auditHref,
        intent,
        reviewed,
        found,
        state: isDone(c[4]) ? 'done' : isSkipped(c[4]) ? 'skipped' : 'pending',
        note: c[5],
      });
    }
  }
}

// ---- 解析横切专项表（## 横切专项 之后的表格行）----
const tracks = [];
let inX = false;
for (const line of lines) {
  if (line.startsWith('## ')) inX = line.includes('横切专项');
  else if (inX && line.trim().startsWith('|')) {
    const c = cells(line);
    // 编号 | 专项 | 状态 | 报告 | 备注
    if (c.length >= 5 && /^X\d/.test(c[0])) {
      const rm = c[3].match(/\[([^\]]+)\]\(([^)]+)\)/);
      tracks.push({
        id: c[0],
        name: c[1],
        state: isDone(c[2]) ? 'done' : c[2] === '进行' ? 'doing' : 'pending',
        report: rm ? { text: rm[1], href: rm[2] } : null,
        note: c[4],
      });
    }
  }
}

// ---- 汇总 ----
const all = domains.flatMap((d) => d.features);
const sum = (arr, fn) => arr.reduce(fn, 0);
const total = all.length;
const doneCount = all.filter((f) => f.state === 'done').length;
const skippedCount = all.filter((f) => f.state === 'skipped').length;
const intentDone = all.filter((f) => f.intent === 'done').length;
const intentDraft = all.filter((f) => f.intent === 'draft').length;
const reviewedDone = all.filter((f) => f.reviewed === 'done').length;
const LEVELS = ['P0', 'P1', 'P2', 'P3', 'DOC', 'Q'];
const foundTotals = LEVELS.map((_, i) => sum(all, (a, f) => a + f.found[i], 0));
const openP0 = sum(
  all.filter((f) => f.state !== 'done'),
  (a, f) => a + f.found[0],
  0
);
const xDone = tracks.filter((t) => t.state === 'done').length;

const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 100));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = () => new Date().toLocaleString('zh-CN', { hour12: false });

function bar(p, cls) {
  return `<div class="bar"><div class="fill ${cls}" style="width:${p}%"></div></div>`;
}

function domainCard(d) {
  const n = d.features.length;
  const done = d.features.filter((f) => f.state === 'done').length;
  const skip = d.features.filter((f) => f.state === 'skipped').length;
  const intent = d.features.filter((f) => f.intent === 'done').length;
  const iDraft = d.features.filter((f) => f.intent === 'draft').length;
  const reviewed = d.features.filter((f) => f.reviewed === 'done').length;
  const rDoing = d.features.filter((f) => f.reviewed === 'doing').length;
  const fsum = LEVELS.map((_, i) => sum(d.features, (a, f) => a + f.found[i], 0));
  const chips = LEVELS.map(
    (L, i) => (fsum[i] ? `<span class="chip lv${i}">${L} ${fsum[i]}</span>` : '')
  ).join('');
  const rows = d.features
    .map((f) => {
      const st =
        f.state === 'done'
          ? '<span class="ok">闭环</span>'
          : f.state === 'skipped'
            ? '<span class="skip">跳过</span>'
            : '<span class="todo">待</span>';
      const nameHtml = f.docHref
        ? `<a class="fdoc" href="${f.docHref}">${esc(f.name)}</a>`
        : esc(f.name);
      const auditHtml = f.auditHref
        ? ` <a class="faudit" href="${f.auditHref}" title="审查报告">审查</a>`
        : '';
      const iCell = f.intent === 'done' ? '✅' : f.intent === 'draft' ? '<span class="draft">稿</span>' : '·';
      const rCell =
        f.reviewed === 'done' ? '✅' : f.reviewed === 'doing' ? '<span class="draft">审</span>' : '·';
      return `<tr class="${f.state}"><td>${nameHtml}${auditHtml}</td><td>${iCell}</td><td>${rCell}</td><td class="mono">${f.found.join('/')}</td><td>${st}</td><td class="note">${esc(
        f.note
      )}</td></tr>`;
    })
    .join('\n');
  const planHtml = d.plan
    ? `<a class="plan" href="${d.plan.href}">计划 · ${esc(d.plan.text)}</a>`
    : '';
  return `<details class="card"${done === n ? '' : ' open'}>
<summary>
  <span class="did">${d.id}</span><span class="dname">${esc(d.name)}</span>${planHtml}
  <span class="frac">${done}/${n}${skip ? `（跳过 ${skip}）` : ''}</span>
  <span class="mini">意图 ${intent}✅${iDraft ? `+${iDraft}稿` : ''}/${n} · 审 ${reviewed}✅${rDoing ? `+${rDoing}审中` : ''}/${n}</span>
  ${chips}
</summary>
${bar(pct(done + skip, n), done === n ? 'ok' : 'doing')}
<table><thead><tr><th>功能</th><th>意图</th><th>审</th><th>发现 P0/P1/P2/P3/DOC/Q</th><th>终态</th><th>备注</th></tr></thead>
<tbody>${rows}</tbody></table>
</details>`;
}

const tierBlocks = [1, 2, 3, 4]
  .map((t) => {
    const ds = domains.filter((d) => d.tier === t);
    if (!ds.length) return '';
    const feats = ds.flatMap((d) => d.features);
    const dn = feats.filter((f) => f.state === 'done').length;
    return `<section class="tier"><h2>Tier ${t}${
      t === 1 ? '（先行：高风险）' : t === 2 ? '（核心体验）' : t === 3 ? '（面板与互联）' : '（设置与基建）'
    } · ${dn}/${feats.length}</h2>${ds.map(domainCard).join('\n')}</section>`;
  })
  .join('\n');

const trackRows = tracks
  .map(
    (t) =>
      `<tr><td class="mono">${t.id}</td><td>${esc(t.name)}</td><td>${
        t.state === 'done' ? '<span class="ok">✅</span>' : t.state === 'doing' ? '进行' : '待'
      }</td><td>${
        t.report ? `<a class="fdoc" href="${t.report.href}">${esc(t.report.text)}</a>` : '—'
      }</td><td class="note">${esc(t.note)}</td></tr>`
  )
  .join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>可靠性 · 易用性专项看板</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c2128;--sub:#5a6472;--line:#e3e6eb;--acc:#3b82f6;
--ok:#16a34a;--do:#d97706;--p0:#dc2626;--p1:#ea580c;--p2:#ca8a04;--p3:#64748b;--doc:#7c3aed;--q:#0891b2}
@media(prefers-color-scheme:dark){:root{--bg:#101418;--card:#171c22;--fg:#e6e9ee;--sub:#98a2b0;--line:#2a323c;--acc:#60a5fa}}
*{box-sizing:border-box}body{margin:0;padding:24px;font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
background:var(--bg);color:var(--fg)}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--sub);font-size:12px;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.stat b{font-size:22px;display:block}.stat span{color:var(--sub);font-size:12px}
.alert{background:color-mix(in srgb,var(--p0) 12%,transparent);border:1px solid var(--p0);
color:var(--p0);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-weight:600}
.tier h2{font-size:15px;margin:22px 0 8px;color:var(--sub)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;padding:0 14px}
.card summary{cursor:pointer;padding:10px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;list-style:none}
.card summary::-webkit-details-marker{display:none}
.did{color:var(--sub);font-family:ui-monospace,monospace}.dname{font-weight:600}
.frac{margin-left:auto;font-weight:600;color:var(--acc)}.mini{color:var(--sub);font-size:12px}
.chip{font-size:11px;border-radius:99px;padding:1px 8px;border:1px solid currentColor}
.lv0{color:var(--p0)}.lv1{color:var(--p1)}.lv2{color:var(--p2)}.lv3{color:var(--p3)}.lv4{color:var(--doc)}.lv5{color:var(--q)}
.bar{height:5px;border-radius:99px;background:var(--line);overflow:hidden;margin:2px 0 8px}
.fill{height:100%;border-radius:99px}.fill.ok{background:var(--ok)}.fill.doing{background:var(--do)}
table{border-collapse:collapse;width:100%;margin:4px 0 12px;font-size:13px}
th,td{text-align:left;padding:5px 8px;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--sub);font-weight:500;font-size:12px}
tr.skipped td{opacity:.5}.mono{font-family:ui-monospace,monospace}.note{color:var(--sub)}
.ok{color:var(--ok)}.skip{color:var(--p3)}.todo{color:var(--do)}.draft{color:var(--doc)}
h2 a{color:var(--fg);text-decoration:none}
.fdoc{color:var(--acc);text-decoration:none}.fdoc:hover{text-decoration:underline}
.faudit{font-size:10px;color:var(--doc);border:1px solid currentColor;border-radius:99px;
padding:0 5px;text-decoration:none;white-space:nowrap}.faudit:hover{background:color-mix(in srgb,var(--doc) 14%,transparent)}
.plan{font-size:12px;color:var(--doc);text-decoration:none;border:1px dashed currentColor;border-radius:6px;padding:0 6px}
.plan:hover{background:color-mix(in srgb,var(--doc) 12%,transparent)}
.foot{color:var(--sub);font-size:12px;margin-top:20px}
</style>
</head>
<body>
<h1>可靠性 · 易用性专项看板</h1>
<div class="sub">真源：<code>docs/plans/reliability-usability-campaign-2026-10-25.md</code> · 生成于 ${fmt()} · 更新账本后运行 <code>node scripts/campaign-dashboard.mjs</code></div>
${openP0 > 0 ? `<div class="alert">⚠ 未闭环功能上仍有 ${openP0} 个 P0 发现</div>` : ''}
<div class="stats">
<div class="stat"><b>${doneCount}<span style="font-size:13px;color:var(--sub)">/${total}</span></b><span>功能闭环${skippedCount ? `（跳过 ${skippedCount}）` : ''}</span></div>
<div class="stat"><b>${intentDone}<span style="font-size:13px;color:var(--sub)">/${total}</span></b><span>设计初衷已确认${intentDraft ? `（另有 ${intentDraft} 项 AI 草案待确认）` : ''}</span></div>
<div class="stat"><b>${reviewedDone}<span style="font-size:13px;color:var(--sub)">/${total}</span></b><span>Review 完成</span></div>
<div class="stat"><b>${foundTotals[0] + foundTotals[1] + foundTotals[2]}</b><span>发现 P0+P1+P2（${LEVELS.map((L, i) => `${L} ${foundTotals[i]}`).join(' · ')}）</span></div>
<div class="stat"><b>${xDone}<span style="font-size:13px;color:var(--sub)">/${tracks.length}</span></b><span>横切专项闭环</span></div>
</div>
${tierBlocks}
<section class="tier"><h2>横切专项 X1–X${tracks.length}</h2>
<div class="card" style="padding:12px 14px"><table>
<thead><tr><th>编号</th><th>专项</th><th>状态</th><th>报告</th><th>备注</th></tr></thead><tbody>${trackRows}</tbody></table></div></section>
<div class="foot">图例：意图＝设计初衷已与用户确认（稿=AI 草案待确认）· 审＝五维 review 完成（审=进行中）· 发现列＝P0/P1/P2/P3/DOC/Q 计数 · 终态＝闭环✅ 或经批准的跳过。跳过与降级必有备注原因。链接：功能名→功能文档 · 「审查」胶囊→审查报告（docs/audits/reliability/，有报告才出现）· 域头「计划」→该域修复计划 · 横切「报告」列→专项报告。</div>
</body></html>`;

writeFileSync(OUT, html, 'utf8');
const domainCount = domains.length;
const featCount = domains.reduce((a, d) => a + d.features.length, 0);
console.log(`看板已生成：${OUT}`);
console.log(`解析：${domainCount} 域 / ${featCount} 功能 / ${tracks.length} 横切专项`);
if (featCount !== 101) {
  console.warn(`⚠ 功能数 ${featCount} ≠ 101，检查账本表格是否被改动破坏`);
  process.exitCode = 1;
}
