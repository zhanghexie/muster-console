/**
 * gitGraphLayout 增量计算正确性：
 * appendCommits 分批追加的结果应与 computeGraph 一次性全量计算完全一致。
 * 覆盖：线性历史、分叉、合并、多泳道交错、翻页分批。
 *
 * 用 typescript 编译 .ts 到临时 .mjs 再 import（与 git-repo-tree.mjs 同款做法）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'renderer', 'src', 'panels', 'gitGraphLayout.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-layout-'));
  const outFile = path.join(tmp, 'gitGraphLayout.mjs');
  const src = fs.readFileSync(entry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
  return { outFile, tmp };
}

const { outFile } = compile();
const { appendCommits, computeGraph, emptyGraphState } = await import(
  pathToFileURL(outFile).href
);

/** @param {Array<[string, string[]]>} spec */
function makeCommits(spec) {
  return spec.map(([hash, parents]) => ({ hash, parents }));
}

function rowsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.col !== y.col || x.color !== y.color) return false;
    if (x.topLinks.length !== y.topLinks.length) return false;
    for (let k = 0; k < x.topLinks.length; k++) {
      const xl = x.topLinks[k];
      const yl = y.topLinks[k];
      if (xl.from !== yl.from || xl.to !== yl.to || xl.color !== yl.color) return false;
    }
    if (x.bottomLinks.length !== y.bottomLinks.length) return false;
    for (let k = 0; k < x.bottomLinks.length; k++) {
      const xl = x.bottomLinks[k];
      const yl = y.bottomLinks[k];
      if (xl.from !== yl.from || xl.to !== yl.to || xl.color !== yl.color) return false;
    }
  }
  return true;
}

function computeMaxColumns(rows) {
  let columns = 0;
  for (const row of rows) {
    columns = Math.max(columns, row.col + 1);
    for (const link of row.topLinks) columns = Math.max(columns, link.from + 1, link.to + 1);
    for (const link of row.bottomLinks) columns = Math.max(columns, link.from + 1, link.to + 1);
  }
  return columns;
}

// 1) 线性历史：c3 -> c2 -> c1 -> c0
const linear = makeCommits([
  ['c3', ['c2']],
  ['c2', ['c1']],
  ['c1', ['c0']],
  ['c0', []]
]);
const linearFull = computeGraph(linear);
let state = emptyGraphState();
let acc = [];
for (const c of linear) {
  const { newRows, state: s } = appendCommits([c], state);
  state = s;
  acc = acc.concat(newRows);
}
assert.ok(rowsEqual(acc, linearFull.rows), '线性历史：增量与全量不一致');

// 2) 分叉：c2 有两个子 c3a / c3b
const fork = makeCommits([
  ['c3a', ['c2']],
  ['c3b', ['c2']],
  ['c2', ['c1']],
  ['c1', ['c0']],
  ['c0', []]
]);
const forkFull = computeGraph(fork);
state = emptyGraphState();
acc = [];
for (const c of fork) {
  const { newRows, state: s } = appendCommits([c], state);
  state = s;
  acc = acc.concat(newRows);
}
assert.ok(rowsEqual(acc, forkFull.rows), '分叉历史：增量与全量不一致');

// 3) 合并：c4 有两个父 c3a / c3b
const merge = makeCommits([
  ['c4', ['c3a', 'c3b']],
  ['c3a', ['c2']],
  ['c3b', ['c2']],
  ['c2', ['c1']],
  ['c1', ['c0']],
  ['c0', []]
]);
const mergeFull = computeGraph(merge);
state = emptyGraphState();
acc = [];
for (const c of merge) {
  const { newRows, state: s } = appendCommits([c], state);
  state = s;
  acc = acc.concat(newRows);
}
assert.ok(rowsEqual(acc, mergeFull.rows), '合并历史：增量与全量不一致');

// 4) 分批追加（模拟翻页）：每批 2 个，结果应与全量一致
const batched = makeCommits([
  ['c5', ['c4']],
  ['c4', ['c3', 'c3b']],
  ['c3', ['c2']],
  ['c3b', ['c2']],
  ['c2', ['c1']],
  ['c1', ['c0']],
  ['c0', []]
]);
const batchedFull = computeGraph(batched);
state = emptyGraphState();
acc = [];
for (let i = 0; i < batched.length; i += 2) {
  const slice = batched.slice(i, i + 2);
  const { newRows, state: s } = appendCommits(slice, state);
  state = s;
  acc = acc.concat(newRows);
}
assert.ok(rowsEqual(acc, batchedFull.rows), '分批追加：增量与全量不一致');
assert.equal(computeMaxColumns(acc), batchedFull.columns, '分批追加：columns 不一致');

console.log('git-graph-layout: ok');
