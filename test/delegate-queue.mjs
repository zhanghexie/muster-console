/**
 * 派活队列：drain 失败回插队首不丢任务（回归）/ 成功后出队。
 * Run: node test/delegate-queue.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-queue-'));
const compile = createSharedCompiler(root, tmp);
const dq = await import(pathToFileURL(compile('main/tasks/delegateQueue.ts')).href);

// readWorkspaceFile 会在 wsRoot 落一个 workspace.json（缺省并发 5），配 0 活跃 → 不排队直接跑
const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-queue-ws-'));
const ctx = {
  config: { get: () => ({ workspace: wsRoot, workspaces: [{ id: 'ws', path: wsRoot }] }) },
  sessions: { listByWorkspace: () => [] }
};

dq.resetDelegateQueueForTests();
const submission = { isolate: false, task: '', name: 'n1', characterId: 'quantum', creationKey: 'desktop-test',
  desktopUserInstruction: true, attachments: [{ id: 'one', name: 'note.txt', mimeType: 'text/plain', data: 'eA==' }] };
const queued = dq.enqueueDelegate(ctx, 'ws', submission);
assert.equal(queued.position, 1);
assert.equal(dq.enqueueDelegate(ctx, 'ws', submission).queueId, queued.queueId);
submission.attachments[0].data = '';
assert.equal('attachments' in dq.listDelegateQueue('ws')[0], false);

let calls = 0;
dq.bindDelegateRunner(async (_ctx, input) => {
  assert.equal(input.characterId, 'quantum', 'queued retry preserves assigned avatar');
  assert.equal(input.attachments[0].data, 'eA==', 'queued first turn keeps its submitted bytes');
  calls += 1;
  throw new Error('boom');
});
await dq.drainDelegateQueue('ws');
assert.equal(calls, 1);
assert.equal(dq.listDelegateQueue('ws').length, 1, '失败后回插队列，不丢任务');

dq.bindDelegateRunner(async (_ctx, input) => {
  assert.equal(input.characterId, 'quantum', 'queued retry preserves assigned avatar');
  calls += 1;
  return { ok: true };
});
await dq.drainDelegateQueue('ws');
assert.equal(calls, 2);
assert.equal(dq.listDelegateQueue('ws').length, 0, '重试成功后出队');

// ---------- 失败重试必须有界：确定性失败项不能每次槽位释放都重来（孤儿会话无界复制） ----------
dq.resetDelegateQueueForTests();
calls = 0;
dq.bindDelegateRunner(async () => {
  calls += 1;
  throw new Error('deterministic boom');
});
dq.enqueueDelegate(ctx, 'ws', { isolate: false, prompt: 'poison', name: 'poison' });
for (let i = 0; i < 8; i++) {
  await dq.drainDelegateQueue('ws');
}
assert.equal(
  dq.listDelegateQueue('ws').length,
  0,
  '超过重试上限后该项出队，不再无限重试'
);
assert.ok(calls <= 5, `重试应有上限（首跑+至多3次重试），实际调用 ${calls} 次`);

// ---------- 失败回插队尾：坏项不得永久挡住其后的排队任务 ----------
dq.resetDelegateQueueForTests();
const order = [];
dq.bindDelegateRunner(async (_ctx, input) => {
  order.push(input.name);
  if (input.name === 'bad') throw new Error('still broken');
  return { ok: true };
});
dq.enqueueDelegate(ctx, 'ws', { isolate: false, prompt: 'a', name: 'bad' });
dq.enqueueDelegate(ctx, 'ws', { isolate: false, prompt: 'b', name: 'good1' });
dq.enqueueDelegate(ctx, 'ws', { isolate: false, prompt: 'c', name: 'good2' });
// 每次槽位释放触发一次 drain（失败收口即返回，等下次释放）
for (let i = 0; i < 10 && dq.listDelegateQueue('ws').length; i++) {
  await dq.drainDelegateQueue('ws');
}
assert.deepEqual(
  order,
  ['bad', 'good1', 'good2', 'bad', 'bad', 'bad'],
  '坏项回插队尾，其后任务照常推进（good1/good2 在第二次 drain 全部执行）；初跑+3 次重试后清出'
);
assert.equal(dq.listDelegateQueue('ws').length, 0, '坏项超限后清出队列');

console.log('delegate-queue: ok');
