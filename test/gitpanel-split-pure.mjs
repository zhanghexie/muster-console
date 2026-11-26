/**
 * GitPanel 拆分纯函数单测（2026-09-26 GitPanel.tsx → gitpanel/ 拆分的回归锁）：
 * - mergeRepoList：IPC 新对象按 path 对齐复用旧引用（内容没变不触发下游 useMemo 全量失效）
 * - changeTouchesRepo：fs 信号归属仓判定（空信号不命中 / 前缀命中 / 反斜杠归一）
 * - joinRepoRel：仓内相对路径 → 绝对路径（保持仓路径的分隔符风格）
 * - findContainingRepo：revealAbs 定位最深包含仓
 * - isStaged/isUnstaged/badge 徽标：zones 过滤与徽标字符
 * - parseRepoSort / sortLabel / repoSummaryEquals
 * 运行: node test/gitpanel-split-pure.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');

// .ts 即时转译（CJS）：与 host-split-pure 同一套路
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: filename
  });
  module._compile(outputText, filename);
};

const pure = require(
  path.join(root, 'src/renderer/src/panels/gitpanel/gitPanelPure.ts')
);

// ---------- mergeRepoList：引用复用（防下游 useMemo 全量失效） ----------
{
  const keyOf = (p) => p;
  const a = { path: 'E:/w/a', name: 'a', dirty: true, branch: 'main', ahead: 1, behind: 0 };
  const b = { path: 'E:/w/b', name: 'b', dirty: false, branch: 'dev', ahead: 0, behind: 0 };
  const prev = [a, b];

  // 内容等价的新对象 → 复用旧引用，数组本身也不换
  const nextSame = [{ ...a }, { ...b }];
  assert.equal(pure.mergeRepoList(prev, nextSame, keyOf), prev, '内容没变必须复用整个 prev 数组');

  // 单项变化 → 只换该项，另一项引用保住
  const changed = { path: 'E:/w/b', name: 'b', dirty: true, branch: 'dev', ahead: 0, behind: 2 };
  const merged = pure.mergeRepoList(prev, [{ ...a }, changed], keyOf);
  assert.notEqual(merged, prev, '有变化时返回新数组');
  assert.equal(merged[0], a, '未变项必须复用旧引用');
  assert.equal(merged[1], changed, '变化项换成新对象');
  assert.equal(merged[1].behind, 2);

  // prev 为空 → 直接采用 next
  assert.equal(pure.mergeRepoList([], [a], keyOf)[0], a);
}

// ---------- repoSummaryEquals ----------
{
  const base = { path: 'E:/w/a', name: 'a', dirty: false, branch: 'main', ahead: 0, behind: 0, manual: false, lastModifiedMs: 1 };
  assert.ok(pure.repoSummaryEquals(base, { ...base }));
  assert.equal(pure.repoSummaryEquals(base, { ...base, rootId: 'other' }), false);
  assert.equal(pure.repoSummaryEquals(base, { ...base, workspaceId: 'other' }), false);
  assert.ok(!pure.repoSummaryEquals(base, { ...base, dirty: true }));
  assert.ok(!pure.repoSummaryEquals(base, { ...base, ahead: 3 }));
  assert.ok(!pure.repoSummaryEquals(base, { ...base, lastModifiedMs: 2 }));
}

// ---------- changeTouchesRepo：fs 信号归属 ----------
{
  const ws = 'E:/w';
  const repo = 'E:/w/a';
  assert.ok(pure.changeTouchesRepo(['a/src/x.ts'], repo, ws), '仓内相对路径命中');
  assert.ok(pure.changeTouchesRepo(['a', 'other.txt'], repo, ws), '仓路径本身命中');
  assert.ok(!pure.changeTouchesRepo(['ab/c.ts'], repo, ws), '前缀目录名不同不得命中');
  assert.ok(!pure.changeTouchesRepo([''], repo, ws), '空信号（watcher filename 为空）不命中');
  assert.ok(!pure.changeTouchesRepo(['b/c.ts'], repo, ws), '其它目录不命中');
  // 反斜杠（Windows watcher）归一
  assert.ok(pure.changeTouchesRepo(['a\\src\\x.ts'], repo, ws), '反斜杠路径归一后命中');
  // 仓在 workspace 外 → 永不命中
  assert.ok(!pure.changeTouchesRepo(['a/src/x.ts'], 'E:/outside/repo', ws));
  // 根仓（repoRel 为空字符串）等效任意非空信号命中
  assert.ok(pure.changeTouchesRepo(['x.txt'], ws, ws), '根仓：任意非空信号命中');
}

// ---------- joinRepoRel：分隔符风格跟随仓路径 ----------
{
  assert.equal(pure.joinRepoRel('E:/w/a', 'src/x.ts'), 'E:/w/a/src/x.ts');
  assert.equal(pure.joinRepoRel('E:\\w\\a', 'src\\x.ts'), 'E:\\w\\a\\src\\x.ts', '反斜杠仓用反斜杠拼接');
  assert.equal(pure.joinRepoRel('E:/w/a/', 'src/x.ts'), 'E:/w/a/src/x.ts', '尾分隔符去除');
  assert.equal(pure.joinRepoRel('E:/w/a', 'src\\x.ts'), 'E:/w/a/src/x.ts', 'rel 里的反斜杠归一');
}

// ---------- findContainingRepo：最深包含仓 ----------
{
  const repos = [
    { path: 'E:/w', name: 'w' },
    { path: 'E:/w/sub', name: 'sub' }
  ];
  const keyOf = (p) => p;
  assert.equal(pure.findContainingRepo('E:/w/sub/x.ts', repos, keyOf)?.name, 'sub', '选最深包含仓');
  assert.equal(pure.findContainingRepo('E:/w/other.ts', repos, keyOf)?.name, 'w');
  assert.equal(pure.findContainingRepo('E:/elsewhere/x.ts', repos, keyOf), null, '不在任何仓内返回 null');
}

// ---------- 变更分区与徽标 ----------
{
  const stagedOnly = { index: 'M', working_dir: ' ' };
  const unstagedOnly = { index: ' ', working_dir: 'M' };
  const both = { index: 'M', working_dir: 'M' };
  const untracked = { index: '?', working_dir: '?' };
  const renamedStaged = { index: 'R', working_dir: ' ' };

  assert.ok(pure.isStaged(stagedOnly) && !pure.isUnstaged(stagedOnly));
  assert.ok(!pure.isStaged(unstagedOnly) && pure.isUnstaged(unstagedOnly));
  assert.ok(pure.isStaged(both) && pure.isUnstaged(both));
  assert.ok(!pure.isStaged(untracked) && pure.isUnstaged(untracked), '未跟踪归未暂存区');
  assert.ok(pure.isStaged(renamedStaged));

  assert.equal(pure.stagedBadge(untracked), 'M', 'staged 徽标兜底 M');
  assert.equal(pure.stagedBadge(stagedOnly), 'M');
  assert.equal(pure.unstagedBadge(untracked), '?', '未跟踪徽标 ?');
  assert.equal(pure.unstagedBadge(unstagedOnly), 'M');
  assert.equal(pure.unstagedBadge({ index: ' ', working_dir: 'D' }), 'D');
}

// ---------- parseRepoSort / sortLabel ----------
{
  assert.equal(pure.parseRepoSort(undefined), 'name');
  assert.equal(pure.parseRepoSort('bogus'), 'name');
  assert.equal(pure.parseRepoSort('recent'), 'recent');
  assert.equal(pure.parseRepoSort('dirty'), 'dirty');

  const t = (k) => `#${k}`;
  assert.equal(pure.sortLabel('name', t), '#名称');
  assert.equal(pure.sortLabel('recent', t), '#最近修改');
  assert.equal(pure.sortLabel('dirty', t), '#未提交变动');
}

console.log('gitpanel-split-pure: all assertions passed');
