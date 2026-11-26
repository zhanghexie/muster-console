/**
 * 轮内增量 checkpoint 元信息回归（zcode-adopt-batch-d D4 / T4）：
 * 1) reason 落账：tool_completed|part_boundary|periodic 进 checkpoints[] 并同步
 *    行级 checkpointState/Reason（seq 递增、toolCallId 透传）；
 * 2) 状态机：轮内增量恒 partial，settleCheckpoints 盖 settled（幂等）；
 * 3) 周期判定：无历史即打、间隔内不打、到点再打；
 * 4) rewind 入口收敛到编辑历史：listRewindEditEntries 提取人手用户消息 +
 *    工具边界 checkpoint；独立 /rewind 命令被拒（HAS_STANDALONE_REWIND_COMMAND=false）。
 * 运行: node test/turn-checkpoint.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-checkpoint-'));
const compile = createSharedCompiler(root, tmp);

const tc = await import(pathToFileURL(compile('shared/turnCheckpoint.ts')).href);
const {
  CHECKPOINT_REASONS,
  CHECKPOINT_STATES,
  CHECKPOINT_MAX_PER_MESSAGE,
  PERIODIC_CHECKPOINT_INTERVAL_MS,
  parseCheckpointReason,
  parseCheckpointState,
  classifyCheckpointReason,
  shouldPeriodicCheckpoint,
  stampCheckpoint,
  settleCheckpoints,
  HAS_STANDALONE_REWIND_COMMAND,
  FORBIDDEN_REWIND_COMMANDS,
  isStandaloneRewindCommand,
  isHumanUserMessage,
  listRewindEditEntries,
  resolveRewindEntry
} = tc;

// ── 1) reason 落账 ──
{
  assert.deepEqual([...CHECKPOINT_REASONS], [
    'tool_completed',
    'part_boundary',
    'periodic'
  ]);
  assert.deepEqual([...CHECKPOINT_STATES], ['partial', 'settled']);
  assert.equal(PERIODIC_CHECKPOINT_INTERVAL_MS, 30_000);

  assert.equal(parseCheckpointReason('tool_completed'), 'tool_completed');
  assert.equal(parseCheckpointReason('part_boundary'), 'part_boundary');
  assert.equal(parseCheckpointReason('periodic'), 'periodic');
  assert.equal(parseCheckpointReason('turn_end'), null);
  assert.equal(parseCheckpointState('partial'), 'partial');
  assert.equal(parseCheckpointState('settled'), 'settled');
  assert.equal(parseCheckpointState('open'), null);
  assert.equal(classifyCheckpointReason({ kind: 'tool_completed' }), 'tool_completed');
  assert.equal(classifyCheckpointReason({ kind: 'part_boundary' }), 'part_boundary');
  assert.equal(classifyCheckpointReason({ kind: 'periodic' }), 'periodic');

  const msg = {};
  const m1 = stampCheckpoint(msg, {
    reason: 'tool_completed',
    at: 1000,
    toolCallId: 'tc-1'
  });
  assert.equal(m1.reason, 'tool_completed');
  assert.equal(m1.state, 'partial');
  assert.equal(m1.seq, 1);
  assert.equal(m1.toolCallId, 'tc-1');
  assert.equal(msg.checkpointState, 'partial');
  assert.equal(msg.checkpointReason, 'tool_completed');
  assert.equal(msg.checkpoints.length, 1);

  const m2 = stampCheckpoint(msg, { reason: 'part_boundary', at: 2000 });
  assert.equal(m2.seq, 2);
  assert.equal(m2.reason, 'part_boundary');
  assert.equal(m2.toolCallId, undefined);
  assert.equal(msg.checkpointReason, 'part_boundary');
  assert.equal(msg.checkpoints.length, 2);

  const m3 = stampCheckpoint(msg, { reason: 'periodic', at: 3000 });
  assert.equal(m3.seq, 3);
  assert.equal(m3.reason, 'periodic');
  assert.equal(msg.checkpointReason, 'periodic');
  assert.equal(msg.checkpointState, 'partial');
  assert.equal(msg.checkpoints.length, 3);

  // 三个 reason 都落账可查
  const reasons = msg.checkpoints.map((c) => c.reason);
  assert.deepEqual(reasons, ['tool_completed', 'part_boundary', 'periodic']);
}

// ── 2) 状态机：partial → settled ──
{
  const msg = {};
  stampCheckpoint(msg, { reason: 'tool_completed', at: 10, toolCallId: 'a' });
  stampCheckpoint(msg, { reason: 'tool_completed', at: 20, toolCallId: 'b' });
  assert.equal(msg.checkpointState, 'partial');

  const settled = settleCheckpoints(msg, 30);
  assert.equal(settled.state, 'settled');
  assert.equal(msg.checkpointState, 'settled');
  assert.equal(msg.checkpointReason, 'tool_completed');
  assert.equal(msg.checkpoints.length, 3);
  assert.equal(msg.checkpoints[2].seq, 3);

  // 幂等：再次 settle 不追加
  const again = settleCheckpoints(msg, 40);
  assert.equal(again, settled);
  assert.equal(msg.checkpoints.length, 3);

  // 空消息 settle 也补一条
  const empty = {};
  const e = settleCheckpoints(empty, 50);
  assert.equal(e.state, 'settled');
  assert.equal(e.reason, 'part_boundary');
  assert.equal(empty.checkpoints.length, 1);
}

// ── 3) 周期判定 ──
{
  assert.equal(shouldPeriodicCheckpoint(null, 0), true);
  assert.equal(shouldPeriodicCheckpoint(undefined, 100), true);
  const last = { state: 'partial', reason: 'tool_completed', at: 1000, seq: 1 };
  assert.equal(shouldPeriodicCheckpoint(last, 1000), false);
  assert.equal(shouldPeriodicCheckpoint(last, 1000 + PERIODIC_CHECKPOINT_INTERVAL_MS - 1), false);
  assert.equal(shouldPeriodicCheckpoint(last, 1000 + PERIODIC_CHECKPOINT_INTERVAL_MS), true);
}

// ── 4) rewind 入口收敛到编辑历史 ──
{
  assert.equal(HAS_STANDALONE_REWIND_COMMAND, false);
  assert.deepEqual([...FORBIDDEN_REWIND_COMMANDS], ['rewind', '/rewind']);
  assert.equal(isStandaloneRewindCommand('rewind'), true);
  assert.equal(isStandaloneRewindCommand('/rewind'), true);
  assert.equal(isStandaloneRewindCommand('REWIND'), true);
  assert.equal(isStandaloneRewindCommand('edit'), false);
  assert.equal(isStandaloneRewindCommand('fork'), false);

  // 消息流：人手用户消息 → assistant（工具 checkpoint）→ 另一条
  const toolMark = {
    state: 'partial',
    reason: 'tool_completed',
    at: 10,
    seq: 1,
    toolCallId: 'tc-9'
  };
  const messages = [
    { id: 'u1', role: 'user', ts: 100, parts: [] },
    { id: 'a1', role: 'assistant', ts: 110, checkpoints: [toolMark] },
    { id: 'u2', role: 'user', ts: 200, host: true },
    { id: 'u3', role: 'user', ts: 300, source: 'scheduler' },
    { id: 'u4', role: 'user', ts: 400, queued: true },
    { id: 'u5', role: 'user', ts: 500 },
    { id: 'a2', role: 'assistant', ts: 510, checkpoints: [toolMark] },
    { id: 'u6', role: 'user', ts: 600, createdAt: 600 }
  ];

  assert.equal(isHumanUserMessage(messages[0]), true);
  assert.equal(isHumanUserMessage(messages[1]), false);
  assert.equal(isHumanUserMessage(messages[2]), false);
  assert.equal(isHumanUserMessage(messages[3]), false);
  assert.equal(isHumanUserMessage(messages[4]), false);
  assert.equal(isHumanUserMessage(messages[5]), true);
  assert.equal(isHumanUserMessage(messages[7]), true);
  assert.equal(isHumanUserMessage({ role: 'user', source: 'agent' }), false);

  const entries = listRewindEditEntries(messages);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.userMessageId),
    ['u1', 'u5', 'u6']
  );
  // u1 之后有 tool_completed checkpoint
  assert.equal(entries[0].checkpoint?.toolCallId, 'tc-9');
  // u5 之后 a2 也有
  assert.equal(entries[1].checkpoint?.toolCallId, 'tc-9');
  // u6 之后没有 assistant → 无 checkpoint
  assert.equal(entries[2].checkpoint, undefined);
  assert.equal(entries[2].ts, 600);

  // resolveRewindEntry：命编辑历史条目
  const hit = resolveRewindEntry(messages, 'u5');
  assert.equal(hit?.userMessageId, 'u5');
  assert.equal(hit?.checkpoint?.toolCallId, 'tc-9');

  // 独立 /rewind 命令与未知 id 都拒绝
  assert.equal(resolveRewindEntry(messages, '/rewind'), null);
  assert.equal(resolveRewindEntry(messages, 'rewind'), null);
  assert.equal(resolveRewindEntry(messages, 'nope'), null);
  assert.equal(resolveRewindEntry(messages, ''), null);
}

// ── 2026-09-27 复审回归：条数上限（超长工具轮不无界膨胀）+ seq 裁剪后仍单调 ──
{
  const msg = {};
  for (let i = 0; i < CHECKPOINT_MAX_PER_MESSAGE + 50; i++) {
    stampCheckpoint(msg, { reason: 'tool_completed', at: i, toolCallId: `t${i}` });
  }
  const marks = msg.checkpoints;
  assert.equal(marks.length, CHECKPOINT_MAX_PER_MESSAGE, '裁剪到上限');
  assert.equal(marks[marks.length - 1].seq, CHECKPOINT_MAX_PER_MESSAGE + 50, 'seq 按累计单调（不因裁剪回退）');
  assert.equal(marks[0].toolCallId, `t${50}`, '最旧的 50 条被裁掉');
}

// 宿主暂不落账：rewind 消费方（listRewindEditEntries）尚无调用方，逐工具写入的
// checkpoints 只会增大每条 assistant 消息与会话落盘体积；消费方落地时再接线
{
  const read = (...parts) => fs.readFileSync(path.join(root, 'src', 'main', 'agentSession', 'host', ...parts), 'utf8');
  assert.ok(!/stampCheckpoint|settleCheckpoints/.test(read('events.ts')), 'events.ts 不再逐工具落 checkpoint');
  assert.ok(!/stampCheckpoint|settleCheckpoints/.test(read('turn.ts')), 'turn.ts 不再轮末 settle checkpoint');
}

console.log('turn-checkpoint.mjs OK');
