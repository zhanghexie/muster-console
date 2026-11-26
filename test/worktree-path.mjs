/**
 * 隔离 worktree 路径判定单源（A2-6-2）：src/shared/worktreePath.ts 的
 * isIsolatedWorktreePath / WORKTREES_DIR_NAME 语义 + 接线源码锚
 * （useGitPanelDerived.ts / workerTreeGuard.ts）。
 * 还原即红：任一接线点改回手写判定（regex 或 includes('.worktrees')），
 * 对应锚断言转红；共享函数语义被改坏时语义用例转红。
 * 运行: node test/worktree-path.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-path-'));
const compile = createSharedCompiler(root, tmp);
const { isIsolatedWorktreePath, WORKTREES_DIR_NAME } = await import(
  pathToFileURL(compile('shared/worktreePath.ts')).href
);

assert.equal(WORKTREES_DIR_NAME, '.worktrees', '目录名常量');

/* ---------- 共享语义：目录边界正则 /[\\/]\.worktrees[\\/]/ ---------- */
assert.equal(isIsolatedWorktreePath('E:/repo/.worktrees/ao-1'), true, 'posix 目录段');
assert.equal(isIsolatedWorktreePath('E:\\repo\\.worktrees\\ao-1'), true, 'win 反斜杠目录段');
assert.equal(isIsolatedWorktreePath('/repo/.worktrees/ao-1/worktrees/deep'), true, '嵌套仍真');
assert.equal(isIsolatedWorktreePath('C:/r/.worktrees/'), true, '尾部边界');
assert.equal(isIsolatedWorktreePath('E:/repo/my.worktrees/ao-1'), false, '子串不算（目录边界）');
assert.equal(isIsolatedWorktreePath('E:/repo/.worktrees-backup/ao-1'), false, '后缀目录名不算');
assert.equal(isIsolatedWorktreePath('E:/repo/worktrees/ao-1'), false, '缺前置点不算');
assert.equal(isIsolatedWorktreePath('.worktrees/ao-1'), false, '相对根无前导边界不算');
assert.equal(isIsolatedWorktreePath(''), false, '空串不算');
assert.equal(isIsolatedWorktreePath(null), false, 'null 不算');
assert.equal(isIsolatedWorktreePath(undefined), false, 'undefined 不算');

/* ---------- 接线源码锚（同输入同答案的前提是都走同一函数） ---------- */
const SITES = [
  'src/renderer/src/panels/gitpanel/useGitPanelDerived.ts',
  'src/main/agentSession/workerTreeGuard.ts'
];
for (const rel of SITES) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  assert.ok(src.includes('isIsolatedWorktreePath('), `${rel} 应改引共享判定`);
  assert.ok(
    !src.includes("includes('.worktrees')") && !/[\\/]\.worktrees\[\\\\\/\]/.test(src),
    `${rel} 不再手写判定`
  );
}

console.log('worktree-path: ok');
