/**
 * P4 统一派活管线：auto 隔离判断 / 临时名派生 / 协调通知文案（纯函数）。
 * Run: node test/delegate-task.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-task-'));

// delegate.ts 依赖链：chat.ts（fs/path/submit/workspaceFile）——把 submit/workspaceFile 打桩后转译注入。
// 这里只取纯函数（deriveDisplayName / hasActiveCodingWorkerInRepo / buildDelegationNotifyMessage），
// import 语句在转译后整体剥掉，函数体不触碰被剥依赖。
const entry = path.join(root, 'src', 'main', 'tasks', 'delegate.ts');
let src = fs.readFileSync(entry, 'utf8');
src = src
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gm, '')
  .replace(/^export (interface|type)[\s\S]*?\n\}\r?\n/gm, '');
const { outputText } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'delegate.mjs');
fs.writeFileSync(out, "import { randomUUID } from 'node:crypto';\n" + outputText, 'utf8');
const {
  deriveDisplayName,
  hasActiveCodingWorkerInRepo,
  buildDelegationNotifyMessage
} = await import(pathToFileURL(out).href);

// ---------- 临时会话名（AO delegatedTaskDisplayName 同款）----------
assert.equal(deriveDisplayName('查缺陷 7067220353'), '查缺陷 7067220353');
assert.equal(deriveDisplayName('  修复\n登录   页样式问题  '), '修复 登录 页样式问题');
{
  const long = 'a'.repeat(30);
  const name = deriveDisplayName(long);
  assert.equal(name.length, 21);
  assert.ok(name.endsWith('…'));
}
console.log('ok: deriveDisplayName');

// ---------- auto 隔离判断 ----------
const WIN = process.platform === 'win32';
const inside = (child, rootDir) => {
  if (WIN) {
    const c = child.toLowerCase();
    const r = rootDir.toLowerCase();
    return c === r || c.startsWith(r + '\\');
  }
  return child === rootDir || child.startsWith(rootDir + '/');
};
const REPO = WIN ? 'C:\\ws\\proj' : '/ws/proj';
const sess = (over = {}) => ({
  id: 'x',
  type: 'terminal',
  launchKind: 'agent',
  lifecycle: 'working',
  archived: false,
  cwd: REPO,
  ...over
});

// 无活跃 worker → 不隔离（首个任务共享）
assert.equal(
  hasActiveCodingWorkerInRepo([], REPO, inside),
  false,
  '无 worker 不隔离'
);
// 同仓库活跃 worker → 隔离
assert.equal(
  hasActiveCodingWorkerInRepo([sess()], REPO, inside),
  true,
  '同仓库活跃 worker 触发隔离'
);
// 子目录 cwd 也算同仓库
assert.equal(
  hasActiveCodingWorkerInRepo([sess({ cwd: path.join(REPO, 'src') })], REPO, inside),
  true
);
// exited / archived / shell 不算活跃
assert.equal(
  hasActiveCodingWorkerInRepo([sess({ lifecycle: 'exited' })], REPO, inside),
  false,
  'exited 不算'
);
assert.equal(
  hasActiveCodingWorkerInRepo([sess({ archived: true })], REPO, inside),
  false,
  'archived 不算'
);
assert.equal(
  hasActiveCodingWorkerInRepo([sess({ launchKind: 'shell' })], REPO, inside),
  false,
  'shell 不算 coding worker'
);
// 闲置空会话（idle 且从未有 phase / 结构化信号）不算：占位不该把首个真任务推进 worktree
assert.equal(
  hasActiveCodingWorkerInRepo([sess({ lifecycle: 'idle' })], REPO, inside),
  false,
  '从未用过的 idle 空会话不触发隔离'
);
// 已标记完成（phase=done，用户手动或 Worker 上报）= 工作闭环，不算活跃
assert.equal(
  hasActiveCodingWorkerInRepo(
    [sess({ lifecycle: 'idle', phase: { value: 'done', source: 'user' } })],
    REPO,
    inside
  ),
  false,
  '用户标记完成的会话不触发隔离'
);
assert.equal(
  hasActiveCodingWorkerInRepo(
    [sess({ lifecycle: 'idle', phase: { value: 'done', source: 'model' } })],
    REPO,
    inside
  ),
  false,
  'Worker 上报 done 的会话同样不算活跃'
);
// needs_you / 干过活的 idle 仍算：会话还占着检出（可能有未合入改动）
assert.equal(
  hasActiveCodingWorkerInRepo(
    [sess({ lifecycle: 'idle', phase: { value: 'needs_you', source: 'model' } })],
    REPO,
    inside
  ),
  true,
  'needs_you（等验收）仍触发隔离'
);
assert.equal(
  hasActiveCodingWorkerInRepo([sess({ lifecycle: 'idle', firstSignalAt: 123 })], REPO, inside),
  true,
  'idle 但有历史信号的 worker 仍触发隔离'
);
// 其它仓库的 worker 不影响
assert.equal(
  hasActiveCodingWorkerInRepo([sess({ cwd: WIN ? 'C:\\ws\\other' : '/ws/other' })], REPO, inside),
  false,
  '别的仓库不触发'
);
console.log('ok: hasActiveCodingWorkerInRepo');

// ---------- 协调通知文案 ----------
{
  const msg = buildDelegationNotifyMessage('sid-123', '查缺陷 7067', '排查登录接口 500');
  assert.ok(msg.includes('【任务已直接拉起】'));
  assert.ok(msg.includes('sid-123'));
  assert.ok(msg.includes('排查登录接口 500'));
  assert.ok(msg.includes('不要重复派活'));
  assert.ok(msg.includes('sessions.rename'));
  assert.ok(msg.includes('≤20 字短名'));
}
console.log('ok: buildDelegationNotifyMessage');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] delegate-task');
