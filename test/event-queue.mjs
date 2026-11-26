/**
 * AsyncEventQueue 回归（2026-10-01 接入审查 P1-6）：
 * fail() 必须让「等待中的消费者」收到 reject——旧实现把 pending resolver resolve 成
 * done:true，for-await 正常结束、错误被吞（cursor worker 崩溃回合被 Host 当正常收口）。
 * 还原修复（fail 改回 resolve done）本文件第一组即红。
 * 运行: node test/event-queue.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, '.tmp', 'event-queue');
fs.rmSync(tmp, { recursive: true, force: true });
const compile = createSharedCompiler(root, tmp);
const { AsyncEventQueue } = await import(
  pathToFileURL(compile('main/agentSession/drivers/eventQueue.ts')).href
);

// ── 1) fail 对等待中的消费者必须 reject（P1-6 核心）──
{
  const q = new AsyncEventQueue();
  let iter = q[Symbol.asyncIterator]();
  const pending = iter.next(); // 消费者正等下一条事件
  q.fail(new Error('worker exited'));
  await assert.rejects(() => pending, /worker exited/, '等待中的 next() 应 reject 而非 resolve done');
  // for-await 语义：消费者循环抛出（Host 泵的 catch 接住 → error 事件）
  iter = q[Symbol.asyncIterator]();
  await assert.rejects(async () => {
    for await (const _ of q) void _;
  }, /worker exited/, 'for-await 应抛出而非正常结束');
  console.log('ok   fail(): 等待中的消费者收到 reject（不被吞成正常结束）');
}

// ── 2) fail 后：缓冲丢弃、后续 next 持续 reject、push 拒收 ──
{
  const q = new AsyncEventQueue();
  q.push({ type: 'text-delta', delta: 'a' });
  q.push({ type: 'text-delta', delta: 'b' });
  q.fail(new Error('boom'));
  q.push({ type: 'text-delta', delta: 'c' }); // 已关：丢弃 + warn（不应抛）
  const iter = q[Symbol.asyncIterator]();
  await assert.rejects(() => iter.next(), /boom/, '缓冲清空后按 err reject');
  console.log('ok   fail(): 缓冲丢弃、后续 next reject、push 拒收');
}

// ── 3) close() 语义不变：pending 与后续 next 都 resolve done ──
{
  const q = new AsyncEventQueue();
  q.push({ v: 1 });
  const iter = q[Symbol.asyncIterator]();
  const first = await iter.next();
  assert.deepEqual(first, { value: { v: 1 }, done: false }, '缓冲项先投递');
  const pending = iter.next();
  q.close();
  assert.deepEqual(await pending, { value: undefined, done: true }, 'close 使 pending 正常结束');
  assert.deepEqual(await iter.next(), { value: undefined, done: true }, 'close 后 next 恒 done');
  console.log('ok   close(): 正常结束语义保持');
}

// ── 4) 空闲（无 pending）时 fail：进入错误态，之后首次 next 即 reject ──
{
  const q = new AsyncEventQueue();
  q.fail(new Error('late crash'));
  const iter = q[Symbol.asyncIterator]();
  await assert.rejects(() => iter.next(), /late crash/);
  console.log('ok   fail() 无消费者时进入错误态');
}

// ── 5) 字节上限：大帧不得把 stalled consumer 的内存推到无界 ──
{
  const q = new AsyncEventQueue({ maxBufferedBytes: 5, sizeOf: value => value.length });
  q.push('1234');
  assert.equal(q.bufferedBytesCount, 4);
  assert.throws(() => q.push('xx'), /byte backpressure/);
  const iter = q[Symbol.asyncIterator]();
  assert.deepEqual(await iter.next(), { value: '1234', done: false });
  assert.equal(q.bufferedBytesCount, 0);
  console.log('ok   maxBufferedBytes：按编码字节数拒绝超限事件并在消费后释放');
}

console.log('event-queue: 全部通过');
