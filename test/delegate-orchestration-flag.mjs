/**
 * 派活身份跨 delegate 队列传播：调度 Agent 的 tasks.delegate 在并发位满时入队，
 * drain 在游离 promise 链外执行（ALS 传不过去）——入队时捕获 orchestrated 旗标、
 * drain 时重包 runAsSchedulerTool，delegateTask 内的编排打标（SessionMeta.orchestrated）
 * 才能在延迟拉起时照常生效。用户 UI「＋新建任务」同走此队列，不带身份 → 不打标。
 *
 * 运行: node test/delegate-orchestration-flag.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-flag-'));
const compile = createSharedCompiler(root, tmp);

const queue = await import(pathToFileURL(compile('main/tasks/delegateQueue.ts')).href);
const { isSchedulerInvocation, runAsSchedulerTool } = await import(
  pathToFileURL(compile('main/agent/agentScope.ts')).href
);

// 假 runner：记录被调时是否带调度身份（真实链路里 delegateTask 据此给会话打标）
const seen = [];
queue.bindDelegateRunner(async (_ctx, input) => {
  seen.push({ scheduler: isSchedulerInvocation(), task: input.task });
  return { status: 'started' };
});

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(wsDir, { recursive: true });
const ctx = {
  sessions: { listByWorkspace: () => [] },
  config: { get: () => ({ workspaces: [{ id: 'ws1', path: wsDir }] }) }
};

// ---------- 1) 调度入队 → 延迟 drain 时身份仍在 ----------
{
  queue.resetDelegateQueueForTests();
  seen.length = 0;
  await runAsSchedulerTool(() => {
    queue.enqueueDelegate(ctx, 'ws1', { isolate: false, task: '调度派的', skipConcurrencyQueue: true });
  });
  // drain 完全脱离原调用链：身份只能来自入队时捕获的旗标
  await queue.drainDelegateQueue('ws1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].scheduler, true, '调度入队的排队项 drain 时必须带调度身份');
  assert.equal(seen[0].task, '调度派的');
}

// ---------- 2) 用户入队（UI ＋新建任务）→ drain 不带身份 ----------
{
  queue.resetDelegateQueueForTests();
  seen.length = 0;
  queue.enqueueDelegate(ctx, 'ws1', { isolate: false, task: '用户建的', skipConcurrencyQueue: true });
  await queue.drainDelegateQueue('ws1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].scheduler, false, '用户入队的排队项不得带调度身份（不打编排标记）');
}

// ---------- 3) 混合队列：FIFO，各带各的身份 ----------
{
  queue.resetDelegateQueueForTests();
  seen.length = 0;
  await runAsSchedulerTool(() => {
    queue.enqueueDelegate(ctx, 'ws1', { isolate: false, task: 'A-调度', skipConcurrencyQueue: true });
  });
  queue.enqueueDelegate(ctx, 'ws1', { isolate: false, task: 'B-用户', skipConcurrencyQueue: true });
  await queue.drainDelegateQueue('ws1');
  assert.deepEqual(
    seen.map((x) => [x.task, x.scheduler]),
    [
      ['A-调度', true],
      ['B-用户', false]
    ],
    '队列项按各自入队身份执行'
  );
}

// A retained session is a committed creation, so retrying the creation would duplicate work.
{
  queue.resetDelegateQueueForTests();
  let attempts = 0;
  const outcomes = [], notices = [];
  const off = queue.addDelegateDrainedListener((_id, _ws, outcome) => outcomes.push(outcome));
  const retainedCtx = { ...ctx, notify: { push: notice => notices.push(notice) } };
  queue.bindDelegateRunner(async () => {
    attempts++; throw Object.assign(new Error('delivery rejected'), { sessionId: 'retained-child' });
  });
  queue.enqueueDelegate(retainedCtx, 'ws1', { isolate: false, task: '保留会话', skipConcurrencyQueue: true });
  await queue.drainDelegateQueue('ws1');
  await queue.drainDelegateQueue('ws1');
  assert.equal(attempts, 1, '会话已经建立后不得自动重建');
  assert.equal(outcomes[0].dropped, true);
  assert.equal(outcomes[0].sessionId, 'retained-child');
  assert.equal(notices[0].sessionId, 'retained-child');
  assert.match(notices[0].text, /原会话.*保留.*未自动重复创建/);
  off();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('delegate-orchestration-flag: all ok');
