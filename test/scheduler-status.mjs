/**
 * 调度会话 needs_you 状态通道 + 工作区气泡计数。
 * 运行: node test/scheduler-status.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-status-'));
const compile = createSharedCompiler(root, tmp);

const {
  resolveSetStatusChannel,
  applySchedulerSetStatus,
  workspaceNeedsYouCount,
  parseSchedulerStatusMap
} = await import(pathToFileURL(compile('shared/schedulerStatus.ts')).href);

// ---------- 状态通道：缺省目标 + 调度 → 本调度会话 ----------
assert.deepEqual(
  resolveSetStatusChannel({ isScheduler: true, workspaceId: 'ws-1' }),
  { channel: 'scheduler', workspaceId: 'ws-1', sessionId: 'orchestrator:ws-1' }
);
assert.equal(
  resolveSetStatusChannel({ isScheduler: false }).channel,
  'missing',
  '非调度缺省目标仍 missing（需要 statusToken）'
);
assert.equal(
  resolveSetStatusChannel({
    isScheduler: true,
    workspaceId: 'ws-1',
    sessionId: 'aaaaaaaa-1111-4222-8333-444444444444'
  }).channel,
  'worker',
  '显式 Worker sessionId 仍走 Worker，不劫持'
);
assert.deepEqual(
  resolveSetStatusChannel({
    isScheduler: false,
    sessionId: 'orchestrator:ws-2'
  }),
  { channel: 'scheduler', workspaceId: 'ws-2', sessionId: 'orchestrator:ws-2' },
  '合成 id 一律调度通道，防呆不建 SessionMeta'
);
// 调度 needs_you 不弹桌面通知：契约由下方 handler 测试兜底（notifyPushes 恒空），
// orchestrator: 身份在 notifyDecision 的豁免由 test/notify-decision.mjs 覆盖。

// ---------- 写入 / 回落 ----------
const first = applySchedulerSetStatus(
  undefined,
  { workspaceId: 'ws-1', sessionId: 'orchestrator:ws-1', phase: 'needs_you' },
  100
);
assert.equal(first.phase, 'needs_you');
assert.equal(first.note, '等验收');
assert.equal(first.kind, 'waiting');
assert.equal(first.sessionId, 'orchestrator:ws-1');

const idle = applySchedulerSetStatus(
  first,
  { workspaceId: 'ws-1', sessionId: 'orchestrator:ws-1', phase: 'idle' },
  200
);
assert.equal(idle.phase, 'idle');
assert.equal(idle.note, '空闲');

const done = applySchedulerSetStatus(
  first,
  { workspaceId: 'ws-1', sessionId: 'orchestrator:ws-1', phase: 'done' },
  300
);
assert.equal(done.phase, 'done');

const noteOnly = applySchedulerSetStatus(
  first,
  { workspaceId: 'ws-1', sessionId: 'orchestrator:ws-1', note: '等你拍板' },
  400
);
assert.equal(noteOnly.phase, 'needs_you', '只改胶囊不改相位');
assert.equal(noteOnly.note, '等你拍板');

// 历史 idle 仍可读取；调度条目已改用未读回复气泡。
assert.deepEqual(parseSchedulerStatusMap({ 'ws-1': idle })['ws-1'], idle);

// ---------- 气泡计数：只计 Worker；调度 needs_you 不进黄点 ----------
const worker = {
  id: 'se-a',
  type: 'terminal',
  name: '改码',
  createdAt: 1,
  launchKind: 'agent',
  workspaceId: 'ws-1',
  status: 'running',
  lifecycle: 'idle',
  phase: { value: 'needs_you', source: 'model', ts: 1 }
};
const otherWs = { ...worker, id: 'se-b', workspaceId: 'ws-2' };
const archived = { ...worker, id: 'se-c', archived: true };

assert.equal(
  workspaceNeedsYouCount({
    sessions: [worker, otherWs, archived],
    workspaceId: 'ws-1',
    now: 10
  }),
  1,
  '本区 1 Worker；他区/归档不计（调度走条目胶囊不进黄点）'
);
assert.equal(
  workspaceNeedsYouCount({
    sessions: [worker],
    workspaceId: 'ws-1',
    now: 10
  }),
  1,
  '只有 Worker 计入；调度 needs_you/done 均不重复计数'
);
assert.equal(
  workspaceNeedsYouCount({
    sessions: [],
    workspaceId: 'ws-1'
  }),
  0,
  '无 Worker 不亮黄点'
);

const parsed = parseSchedulerStatusMap({
  'ws-1': { workspaceId: 'ws-1', phase: 'needs_you', note: '等决策', ts: 9 },
  junk: 1
});
assert.equal(parsed['ws-1'].phase, 'needs_you');
assert.equal(parsed['ws-1'].sessionId, 'orchestrator:ws-1');
assert.equal(parsed.junk, undefined);

// ---------- handler：调度缺省目标不碰 Worker setPhase ----------
const { sessionsHost } = await import(pathToFileURL(compile('main/capabilities/hosts/sessions.ts')).href);
const { runAsSchedulerTool } = await import(pathToFileURL(compile('main/agent/agentScope.ts')).href);

const stored = [];
const setPhaseCalls = [];
const notifyPushes = [];
const handlerCtx = {
  resolveBubbleWorkspaceId: () => 'ws-1',
  notify: { push: (item) => notifyPushes.push(item) },
  schedulerStatus: {
    get: () => undefined,
    set: (s) => {
      stored.push(s);
      return s;
    }
  },
  sessions: {
    resolveSessionRef: () => {
      throw new Error('需要 statusToken（推荐 MUSTER_STATUS_URL）或 sessionId / externalSessionId');
    },
    setPhase: () => {
      setPhaseCalls.push(1);
    },
    setLiveStatus: () => {
      throw new Error('worker liveStatus 不应被调度通道调用');
    },
    get: () => null
  }
};

const reported = await runAsSchedulerTool(() =>
  sessionsHost['sessions.setStatus'](handlerCtx, { phase: 'needs_you', note: '等你拍板' })
);
assert.equal(reported.channel, 'scheduler');
assert.equal(reported.sessionId, 'orchestrator:ws-1');
assert.equal(reported.phase, 'needs_you');
assert.equal(stored.length, 1);
assert.equal(setPhaseCalls.length, 0, '调度通道不得写 Worker setPhase');
assert.equal(notifyPushes.length, 0, '调度 needs_you 不弹系统通知');

await assert.rejects(
  () => sessionsHost['sessions.setStatus'](handlerCtx, { phase: 'needs_you' }),
  /需要 statusToken/,
  '非调度缺省目标仍报需要 statusToken'
);

await assert.rejects(
  () => runAsSchedulerTool(() => sessionsHost['sessions.setStatus'](handlerCtx, { phase: 'idle' })),
  /空闲由宿主判断/
);
assert.equal(stored.length, 1, 'an invalid model report leaves the pending user action intact');
assert.equal(setPhaseCalls.length, 0);

// ---------- X1-F02 单一等人谓词 isSchedulerWaitingOnHuman：C1 持久账 || C2 内存 ask 卡 ----------
{
  const { isSchedulerWaitingOnHuman, SchedulerStatusStore } = await import(
    pathToFileURL(compile('main/schedulerStatusStore.ts')).href
  );
  const c1 = (phase) => ({ workspaceId: 'ws-1', sessionId: 'orchestrator:ws-1', phase, ts: 1 });
  const ask = { workspaceId: 'ws-1', reason: 'askQuestion', questionId: 'q1', since: 1 };
  const ctx = (over = {}) => ({
    schedulerStatus: { get: (id) => (id === 'ws-1' ? c1('needs_you') : undefined) },
    orchestrator: { getHumanWait: () => null },
    ...over
  });
  assert.equal(isSchedulerWaitingOnHuman(ctx(), 'ws-1'), true, 'C1 needs_you → 在等');
  assert.equal(
    isSchedulerWaitingOnHuman(ctx({ schedulerStatus: { get: () => c1('idle') } }), 'ws-1'),
    false,
    'C1 非 needs_you → 不等'
  );
  assert.equal(
    isSchedulerWaitingOnHuman(
      ctx({ schedulerStatus: { get: () => undefined }, orchestrator: { getHumanWait: (id) => (id === 'ws-1' ? ask : null) } }),
      'ws-1'
    ),
    true,
    'C2 ask 卡挂起 → 在等（askQuestion 未写 setStatus 也算等人）'
  );
  assert.equal(
    isSchedulerWaitingOnHuman(ctx({ schedulerStatus: { get: () => undefined } }), 'ws-1'),
    false,
    '两本账都空 → 不等'
  );
  assert.equal(
    isSchedulerWaitingOnHuman(
      ctx({
        schedulerStatus: { get: () => { throw new Error('boom'); } },
        orchestrator: { getHumanWait: () => { throw new Error('boom'); } }
      }),
      'ws-1'
    ),
    false,
    '两侧读失败 fail-open（当不挡）'
  );
  assert.equal(isSchedulerWaitingOnHuman(ctx(), '  '), false, '空工作区 id 不挡');
  // SchedulerStatusStore 仍可实例化（谓词未破坏原类导出）
  assert.equal(typeof SchedulerStatusStore, 'function');
  // 接线守卫：外部 CLI 派活门（startCliRuns 无法离线构造）消费单一谓词而非只查 C2
  const wiringSrc = fs.readFileSync(path.join(root, 'src/main/cliRuns/wiring.ts'), 'utf8');
  assert.match(
    wiringSrc,
    /isSchedulerWaitingOnHuman\(ctx, run\.workspaceId\)/,
    'X1-F02：外部 CLI 派活门消费单一等人谓词（C1||C2）'
  );
  assert.doesNotMatch(
    wiringSrc,
    /scheduler\.getHumanWait\(run\.workspaceId\)/,
    '不再只查 C2 ask 卡（setStatus 写了 needs_you 也拒绝）'
  );
  console.log('ok: X1-F02 单一等人谓词（C1 || C2 / fail-open / wiring 接线）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('scheduler-status: ok');
