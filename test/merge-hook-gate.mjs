/**
 * 合入门禁：仓库自带的 pre-merge-commit 钩子拒绝合并时，mergeIsolateBranch 必须
 * 如实报「门禁拦下」并 abort 干净（真 git fixture）。
 *
 * 回归：钩子拒绝后 git 留下 MERGE_HEAD、无冲突文件，旧逻辑把它当成冲突/脏重叠——
 * 主仓有无关未提交文件时报「本地改动重叠」，否则报「未能列出冲突文件」，门禁输出丢失。
 * 还原即红：去掉 mergeIsolate.ts 里 MERGE_HEAD 判定分支 → blockReason 断言转红。
 *
 * Run: node test/merge-hook-gate.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-hook-gate-'));
const compile = createSharedCompiler(root, tmp);
const iso = await import(pathToFileURL(compile('main/git/mergeIsolate.ts')).href);
const { ensureWorktreesExclude } = await import(pathToFileURL(compile('main/git/worktree.ts')).href);

/** 主仓与隔离分支各有一个提交（分叉），保证是真合并而非快进——快进不触发 pre-merge-commit */
function makeDiverged(name, hookBody) {
  const main = path.join(tmp, name);
  fs.mkdirSync(main, { recursive: true });
  const git = (args, cwd = main) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  const wt = path.join(main, '.worktrees', 'w');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(['worktree', 'add', '-b', 'ao/w', wt, 'HEAD']);
  ensureWorktreesExclude(main);
  fs.writeFileSync(path.join(wt, 'feat.txt'), 'feat\n', 'utf8');
  git(['add', '.'], wt);
  git(['commit', '-m', 'feat'], wt);
  fs.writeFileSync(path.join(main, 'main2.txt'), 'm\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'main2']);

  const hooks = path.join(main, '.git', 'test-hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'pre-merge-commit'), `#!/bin/sh\n${hookBody}\n`, { mode: 0o755 });
  git(['config', 'core.hooksPath', hooks]);
  return { main, wt, git };
}

// 钩子拒绝 → gate-failed，门禁输出带回，abort 干净，主仓无关未提交文件原样保留
{
  const { main, wt, git } = makeDiverged('reject', 'echo GATE-OUTPUT-MARKER >&2\nexit 1');
  const headBefore = git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(main, 'wip.txt'), 'wip\n', 'utf8');

  const r = await iso.mergeIsolateBranch({ mainRepo: main, worktreePath: wt, branch: 'ao/w' });
  assert.equal(r.ok, false, '钩子拒绝时合入必须失败');
  assert.equal(r.blockReason, 'gate-failed', `应判为门禁拦下，实际 ${r.blockReason}：${r.message}`);
  assert.equal(r.gates?.mergeHook, 'failed');
  assert.match(r.message, /pre-merge-commit/);
  assert.match(r.message, /GATE-OUTPUT-MARKER/, '门禁输出必须带回给调用方');
  assert.equal(git(['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD 不得前进');
  assert.ok(!fs.existsSync(path.join(main, '.git', 'MERGE_HEAD')), '必须 abort，不留半合并状态');
  assert.ok(!fs.existsSync(path.join(main, 'feat.txt')), '隔离分支内容不得残留在主仓');
  assert.equal(fs.readFileSync(path.join(main, 'wip.txt'), 'utf8'), 'wip\n', '主仓无关未提交文件原样保留');
  console.log('ok: pre-merge-commit 拒绝 → gate-failed + abort 干净');
}

// 钩子放行 → 正常合入
{
  const { main, wt } = makeDiverged('pass', 'exit 0');
  const r = await iso.mergeIsolateBranch({
    mainRepo: main,
    worktreePath: wt,
    branch: 'ao/w',
    skipTypecheck: true
  });
  assert.equal(r.ok, true, r.message);
  assert.ok(fs.existsSync(path.join(main, 'feat.txt')));
  console.log('ok: pre-merge-commit 放行 → 正常合入');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('merge-hook-gate: all ok');
