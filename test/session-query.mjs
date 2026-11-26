/**
 * P4 会话枚举/反查 + R7 并发预算纯函数。
 * Run: node test/session-query.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-query-'));
const compile = createSharedCompiler(root, tmp);
const { matchFlexibleSessionId, findSessions, countActiveCodingWorkers, resolveMaxConcurrentWorkers, resolveQueryIds, shouldQueueByCount } = await import(pathToFileURL(compile('shared/sessionQuery.ts')).href);

const rows = [
  {
    id: 'aaaaaaaa-1111-4222-8333-444444444444',
    name: 'T1 派活',
    archived: false,
    worktreePath: 'E:/ws/.worktrees/aaaaaaaa-T1',
    cwd: 'E:/ws/.worktrees/aaaaaaaa-T1',
    type: 'terminal',
    launchKind: 'agent',
    lifecycle: 'working'
  },
  {
    id: 'bbbbbbbb-1111-4222-8333-444444444444',
    name: 'T2 旧',
    archived: true,
    type: 'terminal',
    launchKind: 'agent',
    lifecycle: 'exited'
  },
  {
    id: 'aaaaaaaa-9999-4222-8333-555555555555',
    name: 'T1b',
    archived: false,
    type: 'terminal',
    launchKind: 'agent',
    lifecycle: 'idle'
  }
];

const one = matchFlexibleSessionId(rows, 'aaaaaaaa');
assert.equal(one.kind, 'many', '8 位前缀撞两个 aaaaaaaa-');
const unique = matchFlexibleSessionId(rows, 'bbbbbbbb');
assert.equal(unique.kind, 'one');
assert.equal(unique.id, rows[1].id);

const byPath = matchFlexibleSessionId(rows, 'E:\\ws\\.worktrees\\aaaaaaaa-T1');
assert.equal(byPath.kind, 'one');
assert.equal(byPath.matchedBy, 'worktreePath');

const found = findSessions(rows, { name: '派活' });
assert.equal(found.matches.length, 1);
assert.equal(found.matches[0].id, rows[0].id);

assert.equal(countActiveCodingWorkers(rows), 1, 'working 未归档算 1；idle 不算；archived 不算');
assert.equal(resolveMaxConcurrentWorkers(undefined), 50);
assert.equal(resolveMaxConcurrentWorkers('abc'), 50, '非法回落 50');
assert.equal(resolveMaxConcurrentWorkers('60'), 60);
assert.equal(resolveMaxConcurrentWorkers(0), 0);
assert.equal(resolveMaxConcurrentWorkers(3), 3);

assert.equal(
  countActiveCodingWorkers([
    ...rows,
    { id: 'cccccccc-1111-4222-8333-444444444444', name: '等验收', type: 'terminal', launchKind: 'agent', archived: false, lifecycle: 'working', phase: { value: 'needs_you' } },
    { id: 'dddddddd-1111-4222-8333-444444444444', name: '空闲', type: 'terminal', launchKind: 'agent', archived: false, lifecycle: 'idle' },
    { id: 'eeeeeeee-1111-4222-8333-444444444444', name: '已完成', type: 'terminal', launchKind: 'agent', archived: false, lifecycle: 'exited', phase: { value: 'done' } }
  ]), 1, 'needs_you/idle/exited 均不占运行额度'
);
assert.equal(shouldQueueByCount(5, 5), true);
assert.equal(shouldQueueByCount(4, 5), false);
assert.equal(shouldQueueByCount(99, 0), false, '0=不限制');

const resolved = resolveQueryIds(rows, ['bbbbbbbb', 'missing', 'E:/ws/.worktrees/aaaaaaaa-T1']);
assert.deepEqual(resolved.ok.sort(), [rows[0].id, rows[1].id].sort());
assert.deepEqual(resolved.failed, ['missing']);


fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] session matching and concurrency');
