/**
 * 调度 Orchestrator 拆分（2026-09-26）抽出纯函数的单元守卫：
 * 排队消息变换（orchestrator/queueOps.ts）与桶类型守卫（orchestrator/types.ts）。
 * 这些函数原为 Orchestrator 类内联逻辑，拆分时逐字搬家——本测试锁定其可观察行为，
 * 防止后续「顺手改语义」（撤回/改写/重排是 send-queue-panel 的用户可见行为）。
 * 运行: node test/orchestrator-queue-ops.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-queue-ops-'));
const compile = createSharedCompiler(root, tmp);

const queueOps = await import(pathToFileURL(compile('main/agent/orchestrator/queueOps.ts')).href);
const { desktopTurnGrants } = await import(pathToFileURL(compile('main/desktop/turnGrant.ts')).href);
const { normalizeAgentMode, MAX_AGENT_QUEUE, TRANSCRIPT_INDEX_DEBOUNCE_MS } = await import(
  pathToFileURL(compile('main/agent/orchestrator/types.ts')).href
);

const msg = (id, extra = {}) => ({ id, role: 'user', content: `c-${id}`, createdAt: 1, ...extra });
const turn = (id, text = `t-${id}`) => ({ id, text });

// ---------- 1) normalizeAgentMode（宽松 string → 三档模式） ----------
assert.equal(normalizeAgentMode('ask'), 'ask');
assert.equal(normalizeAgentMode('plan'), 'plan');
assert.equal(normalizeAgentMode('default'), 'default');
assert.equal(normalizeAgentMode('bogus'), 'default');
assert.equal(normalizeAgentMode(undefined), 'default');
assert.equal(normalizeAgentMode(42), 'default');
console.log('ok   normalizeAgentMode 宽松归一');

assert.equal(MAX_AGENT_QUEUE, 8, '排队上限常量（send 忙分支拒绝阈值）');
assert.equal(TRANSCRIPT_INDEX_DEBOUNCE_MS, 2_000, '转录索引去抖窗（B5 §4）');

// ---------- 2) collectRestoredQueue（重启恢复：queued 用户消息重建待发队列） ----------
{
  const display = [
    msg('a'),
    msg('b', { queued: true }),
    msg('c', { role: 'assistant', queued: true, content: 'x' }),
    msg('d', { queued: true }),
    msg('e', {
      queued: true,
      images: [{ id: 'im1', data: 'abc', mimeType: 'image/png' }]
    })
  ];
  assert.deepEqual(collectRestoredQueue(), [
    { id: 'b', text: 'c-b' },
    { id: 'd', text: 'c-d' },
    {
      id: 'e',
      text: 'c-e',
      images: [{ id: 'im1', data: 'abc', mimeType: 'image/png' }]
    }
  ]);
  function collectRestoredQueue() {
    return queueOps.collectRestoredQueue(display);
  }
}
console.log('ok   collectRestoredQueue 只收 queued 用户消息并还原随文图片');

// ---------- 3) removeQueuedTurn（撤回排队消息） ----------
{
  const queue = [turn('1'), turn('2'), turn('3')];
  const display = [msg('0'), msg('1', { queued: true }), msg('2', { queued: true })];
  const next = queueOps.removeQueuedTurn(queue, display, '2');
  assert.ok(next, '命中应返回替换结果');
  assert.deepEqual(next.queue.map((q) => q.id), ['1', '3'], 'queue 摘除目标条');
  assert.deepEqual(
    next.display.map((m) => m.id),
    ['0', '1'],
    'display 过滤同 id 消息'
  );
  assert.equal(queueOps.removeQueuedTurn(queue, display, 'nope'), null, '未命中返回 null（调用方回 false）');
}
console.log('ok   removeQueuedTurn 撤回 + 未命中 null');

// ---------- 4) editQueuedTurn（改写排队消息内容） ----------
{
  const imgs = [{ id: 'im1', data: 'abc', mimeType: 'image/png' }];
  const queue = [turn('1', 'old'), turn('2')];
  queue[0].images = imgs;
  const display = [msg('1', { queued: true, images: imgs }), msg('9')];
  assert.equal(queueOps.editQueuedTurn(queue, display, '1', '  new text  '), true);
  assert.equal(queue[0].text, 'new text', 'queue 侧改写为 trim 后内容');
  assert.deepEqual(queue[0].images, imgs, '行内编辑保留随文图片');
  const m = display.find((x) => x.id === '1');
  assert.equal(m.content, 'new text', 'display 侧同步改写');
  assert.deepEqual(m.images, imgs, 'display 侧保留 images 字段');

  assert.equal(queueOps.editQueuedTurn(queue, display, '2', '   '), false, '纯空白=拒绝');
  assert.equal(queueOps.editQueuedTurn(queue, display, 'nope', 'x'), false, '找不到该 id=拒绝');
}
console.log('ok   editQueuedTurn 同步改写保留图片 + 空文本/缺 id 拒绝');

// ---------- 5) reorderQueuedTurns（重排：ids 目标顺序 + 未列 id 保序追加尾部） ----------
{
  const queue = [turn('1'), turn('2'), turn('3')];
  const next = queueOps.reorderQueuedTurns(queue, ['3', '1']);
  assert.deepEqual(
    next.map((q) => q.id),
    ['3', '1', '2'],
    '未出现在 ids 里的保序追加尾部'
  );
  assert.equal(next[0], queue[2], '保持同一对象引用（不复制 turn）');
  assert.equal(queueOps.reorderQueuedTurns(queue, ['1', '2', '3']), null, '顺序无变化返回 null');
}
console.log('ok   reorderQueuedTurns 重排 + 尾部追加 + 无变化 null');

// ---------- 6) applyQueueOrderToDisplay（display 重排：queued 按新序排尾，其余在前） ----------
{
  const display = [
    msg('q1', { queued: true }),
    msg('a'),
    msg('q2', { queued: true }),
    msg('b'),
    msg('q3', { queued: true })
  ];
  const queue = [turn('q3'), turn('q1'), turn('q2')];
  const next = queueOps.applyQueueOrderToDisplay(display, queue);
  assert.deepEqual(
    next.map((m) => m.id),
    ['a', 'b', 'q3', 'q1', 'q2'],
    '非排队消息保序在前，queued 按 queue 新序排尾'
  );
}
console.log('ok   applyQueueOrderToDisplay display 同步重排');

// ---------- 7) splitSteeredDisplayTurn（插话切分：旧 assistant 定稿 + 插话 user + 新占位入流） ----------
// 回归 2026-10-03：调度面板 steer 成功后未切分转写，回复 delta 继续落插话之前的
// 旧 assistant，「回复插话的消息显示在插话消息本身之前」。切分后顺序必须是
// [.., 旧 assistant(定稿), (既有 queued 原位), 插话 user, 新 assistant 占位]。
const TOOL_NOTE = '回合结束仍未收到该工具的结果';
{
  const runningTool = { id: 't1', name: 'x.read', arguments: '{}', status: 'running' };
  const okTool = { id: 't2', name: 'x.list', arguments: '{}', status: 'ok', result: '[]' };
  const a1 = {
    id: 'a1',
    role: 'assistant',
    content: '旧回复',
    toolCalls: [runningTool, okTool],
    parts: [{ kind: 'tool', toolCall: runningTool }, { kind: 'tool', toolCall: okTool }],
    createdAt: 1
  };
  const queued = { id: 'q1', role: 'user', content: '排队中', queued: true, createdAt: 2 };
  const display = [{ id: 'u0', role: 'user', content: '首发', createdAt: 0 }, a1, queued];
  const steer = { id: 's1', role: 'user', content: '插话内容', createdAt: 3, steering: 'send' };
  const next = queueOps.splitSteeredDisplayTurn(display, a1, steer);
  assert.deepEqual(
    display.map((m) => m.id),
    ['u0', 'a1', 'q1', 's1', next.id],
    '切分后顺序：旧 assistant 定稿 → 既有 queued 原位 → 插话 user → 新占位（插话消息必须在回复占位之前）'
  );
  assert.equal(next.role, 'assistant');
  assert.equal(next.content, '', '新占位从空正文开始承接后续流式');
  assert.ok(next.id !== 'a1', '新占位是新消息（渲染层按 id 追加）');
  assert.equal(runningTool.status, 'cancelled', 'running 工具卡收口为 cancelled');
  assert.equal(runningTool.result, TOOL_NOTE, 'running 工具卡带未收到结果注记（parts 与 toolCalls 同引用，两边同步）');
  assert.equal(okTool.status, 'ok', '已完结工具不受切分影响');
  assert.ok(!('steering' in a1));
}
console.log('ok   splitSteeredDisplayTurn 切分顺序 + running 工具收口');

// ---------- 8) sendNow（steer 成功切分 / 回合竞态收口回落 / steer 拒绝回落排队） ----------
{
  function makeHost(bucket) {
    const calls = { emitted: [], persisted: 0, sent: [] };
    return {
      calls,
      ensureBucket: () => bucket,
      emit: (channel, payload) => calls.emitted.push({ channel, payload }),
      persistBucket: () => { calls.persisted += 1; },
      send: async (text, _workspaceId, _images, options) => {
        calls.sent.push(text);
        if (bucket.busy) bucket.queue.push({ id: options.messageId, text });
        options.onAccepted();
      }
    };
  }
  const steerSession = (steerImpl) => ({ steer: steerImpl, isStreaming: true });

  // 8a) steer 成功：切分 + streamingAssistant 换新 + 三连发按序
  {
    const a1 = { id: 'a1', role: 'assistant', content: '旧', toolCalls: [], createdAt: 1 };
    const bucket = {
      display: [{ id: 'u0', role: 'user', content: '首发', createdAt: 0 }, a1],
      busy: true,
      queue: [],
      piSession: steerSession(async () => {}),
      streamingAssistant: a1
    };
    const host = makeHost(bucket);
    const oldTurn = await desktopTurnGrants.authorize('orchestrator:ws1', () => true, async () => true, () => {});
    const r = await queueOps.sendNow(host, ' 插话内容 ', 'ws1');
    assert.equal(oldTurn(), false, 'direct steering revokes desktop authorization');
    assert.equal(r, 'steered');
    assert.equal(bucket.streamingAssistant, bucket.display.at(-1), '流式落点换到新占位（provider getAssistant 同源）');
    assert.deepEqual(
      bucket.display.map((m) => `${m.role}:${m.content}`),
      ['user:首发', 'assistant:旧', 'user:插话内容', 'assistant:'],
      '插话 user 在新 assistant 占位之前——回复不再显示在插话之前'
    );
    assert.equal(bucket.display[2].steering, 'send', '插话消息带 steering:send 标记');
    const pages = host.calls.emitted.filter(e => e.channel === 'agent:history');
    assert.equal(pages.length, 1, 'atomic split publishes one committed range');
    assert.deepEqual(pages[0].payload.messages.slice(-3).map(m => m.id), ['a1', bucket.display[2].id, bucket.display[3].id]);
    assert.equal(pages[0].payload.total, 4);
    assert.ok(host.calls.persisted >= 1, '切分后持久化桶');
  }

  // A grant acquired while steer is awaiting must not cross into the new message.
  {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const assistant = { id: 'pending', role: 'assistant', content: '', toolCalls: [], createdAt: 1 };
    const bucket = { display: [assistant], busy: true, queue: [], streamingAssistant: assistant,
      piSession: steerSession(() => new Promise(resolve => { release = resolve; entered(); })) };
    const sending = queueOps.sendNow(makeHost(bucket), 'queued steering', 'race');
    await started;
    await assert.rejects(desktopTurnGrants.authorize('orchestrator:race', () => true, async () => true, () => {}), /turn changed/, 'delivery in progress blocks new grants');
    release();
    assert.equal(await sending, 'steered');
    const after = await desktopTurnGrants.authorize('orchestrator:race', () => true, async () => true, () => {});
    assert.equal(after(), true, 'authorization resumes after delivery');
    desktopTurnGrants.observePiMessage('orchestrator:race', { type: 'message_start', message: { role: 'user' } });
    assert.equal(after(), false, 'actual Pi user-message consumption revokes a grant acquired after enqueue');
  }

  // 8b) await steer 期间回合已收口（busy=false）：不切分，只垫 user 消息（旧行为兜底）
  {
    const a1 = { id: 'a1', role: 'assistant', content: '旧', toolCalls: [], createdAt: 1 };
    const bucket = {
      display: [{ id: 'u0', role: 'user', content: '首发', createdAt: 0 }, a1],
      busy: true,
      queue: [],
      piSession: steerSession(async () => { bucket.busy = false; }),
      streamingAssistant: a1
    };
    const host = makeHost(bucket);
    const r = await queueOps.sendNow(host, '插话内容', 'ws1');
    assert.equal(r, 'steered');
    assert.equal(bucket.display.length, 3, '竞态回落：只垫 user 消息，不切分不建新占位');
    assert.equal(bucket.display.at(-1).role, 'user');
    // P3 send-queue F-04：回落垫的 user 消息与切分路径同形态，都带 steering:'send'
    assert.equal(bucket.display.at(-1).steering, 'send', '回落路径插话消息也带 steering:send 标记');
    assert.equal(bucket.streamingAssistant, a1, '流式落点不动（回合已收口，等 finally 清空）');
  }

  // 8c) steer 被引擎拒绝：回落排队（busy 时 send 即入队）
  {
    const bucket = {
      display: [],
      busy: true,
      queue: [],
      piSession: steerSession(async () => { throw new Error('engine refused'); })
    };
    const host = makeHost(bucket);
    const r = await queueOps.sendNow(host, '插话内容', 'ws1');
    assert.equal(r, 'queued');
    assert.deepEqual(host.calls.sent, ['插话内容'], '回落走 o.send（忙时入队语义）');
    assert.equal(bucket.display.length, 0, '拒绝路径不动 display（入队由 send 管线负责）');
  }
  // A successful native steer followed by refused persistence is uncertain,
  // never a queue fallback, partial split or cancelled old tool in memory.
  {
    let deliveries = 0;
    const assistant = { id: 'old', role: 'assistant', content: 'stable', createdAt: 1,
      toolCalls: [{ id: 'running', name: 'read', arguments: '{}', status: 'running' }] };
    const bucket = { display: [assistant], busy: true, queue: [], streamingAssistant: assistant,
      piSession: steerSession(async () => { deliveries++; }),
      schedulerSession: { recordEdit() { throw new Error('append refused'); } } };
    const host = makeHost(bucket); host.ctx = { config: { get: () => ({}) } };
    await assert.rejects(queueOps.sendNow(host, 'accepted once', 'uncertain'), error => error.deliveryUncertain === true && /本地记录失败/.test(error.message));
    assert.equal(deliveries, 1); assert.equal(host.calls.sent.length, 0);
    assert.deepEqual(bucket.display, [assistant]); assert.equal(assistant.toolCalls[0].status, 'running');
    assert.equal(bucket.streamingAssistant, assistant); assert.equal(host.calls.emitted.length, 0);
  }
}
console.log('ok   sendNow steer 切分 / 竞态回落 / 拒绝回落排队');

console.log('orchestrator-queue-ops: all ok');
