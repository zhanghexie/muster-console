#!/usr/bin/env node
/**
 * 组件单测覆盖率的「未覆盖清单」：读 vitest --coverage 产出的 json-summary，
 * 按未覆盖分支数排序列出最该补测的文件，另列从未被任何 spec 加载过的文件。
 * 用法：npm run test:coverage（先跑 vitest --coverage 再调本脚本）
 *      node scripts/coverage-report.mjs [--top N]
 * 注意：src/shared 的纯逻辑大多由 test/*.mjs（Node 自测）覆盖，那一层不计入 v8 覆盖率，
 * 这里的 0% 不等于没测——看清单时以 src/renderer 为主。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const summaryPath = path.join(root, '.tmp', 'coverage', 'coverage-summary.json');
const topIdx = process.argv.indexOf('--top');
const top = topIdx >= 0 ? Number(process.argv[topIdx + 1]) || 30 : 30;

if (!existsSync(summaryPath)) {
  console.error(`coverage-report: 找不到 ${path.relative(root, summaryPath)}，先跑 npm run test:coverage`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
const pct = (m) => (m.total === 0 ? 100 : m.pct);

const files = Object.entries(summary)
  .filter(([k]) => k !== 'total')
  .map(([file, m]) => ({
    file: rel(file),
    lines: m.lines,
    branches: m.branches,
    missBranches: m.branches.total - m.branches.covered,
    missLines: m.lines.total - m.lines.covered
  }));

const never = files.filter((f) => f.lines.total > 0 && f.lines.covered === 0);
const partial = files
  .filter((f) => f.lines.covered > 0 && (f.missBranches > 0 || f.missLines > 0))
  .sort((a, b) => b.missBranches - a.missBranches || b.missLines - a.missLines);

const t = summary.total;
console.log(
  `总计  行 ${t.lines.pct}%（${t.lines.covered}/${t.lines.total}）  分支 ${t.branches.pct}%（${t.branches.covered}/${t.branches.total}）  函数 ${t.functions.pct}%`
);

console.log(`\n部分覆盖、未覆盖分支最多的前 ${Math.min(top, partial.length)} 个文件：`);
for (const f of partial.slice(0, top)) {
  console.log(
    `  ${String(f.missBranches).padStart(4)} 分支未覆盖  ${String(pct(f.branches)).padStart(6)}%  行 ${String(pct(f.lines)).padStart(6)}%  ${f.file}`
  );
}

const neverRenderer = never.filter((f) => f.file.startsWith('src/renderer/')).sort((a, b) => b.lines.total - a.lines.total);
console.log(`\n从未被任何组件 spec 加载的渲染层文件（${neverRenderer.length} 个，按行数排序，前 ${Math.min(top, neverRenderer.length)}）：`);
for (const f of neverRenderer.slice(0, top)) {
  console.log(`  ${String(f.lines.total).padStart(5)} 行  ${f.file}`);
}
console.log(`\n（src/shared 另有 ${never.length - neverRenderer.length} 个文件未被组件 spec 加载，多数由 test/*.mjs 覆盖，不在此列）`);
console.log(`HTML 明细：${rel(path.join(root, '.tmp', 'coverage', 'index.html'))}`);
