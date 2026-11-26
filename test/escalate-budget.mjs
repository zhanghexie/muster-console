/**
 * T4/T5 escalate 升级预算与纪律文案：
 * needs_you预算（寄信不消费）、第 4 次 refused 非错误、预算尽不发新通知、文案断言。
 * Run: node test/escalate-budget.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'escalate-budget-'));
const compile = createSharedCompiler(root, tmp);

const {
  ESCALATE_BUDGET_LIMIT,
  ESCALATE_REFUSED_MESSAGE,
  escalateBudgetKey,
  tryEscalate,
  shouldNotifyEscalate
} = await import(pathToFileURL(compile('shared/escalateBudget.ts')).href);

// ---------------------------------------------------------------------------
// 纯函数：计数合并 / 第 4 次 refused 非错误 / 预算尽不发新通知
// ---------------------------------------------------------------------------
{
  assert.equal(ESCALATE_BUDGET_LIMIT, 3);
  assert.equal(
    ESCALATE_REFUSED_MESSAGE,
    'refused: upgrade budget spent (3/3). Proceed on your best judgement; do not retry.'
  );

  // key：按会话身份独立累计
  assert.equal(escalateBudgetKey({ sessionId: 's-1' }), 'session:s-1');
  assert.equal(escalateBudgetKey({ sessionId: 's-2' }), 'session:s-2');
  console.log('ok: escalateBudgetKey');
}

{
  // 同一会话的用户注意通知共用预算
  const budgets = {};
  const key = escalateBudgetKey({ sessionId: 's-1' });
  const a1 = tryEscalate(budgets, key); // needs_you 第 1 次
  const a2 = tryEscalate(budgets, key); // needs_you 第 2 次
  const a3 = tryEscalate(budgets, key); // needs_you 第 3 次
  assert.equal(a1.allowed, true);
  assert.equal(a1.used, 1);
  assert.equal(a1.remaining, 2);
  assert.equal(a2.allowed, true);
  assert.equal(a2.used, 2);
  assert.equal(a3.allowed, true);
  assert.equal(a3.used, 3);
  assert.equal(a3.remaining, 0);
  assert.equal(budgets[key], 3, '同会话累计到同一键');
  console.log('ok: 同一会话的 needs_you 累计');
}

{
  // 第 4 次 refused 是正常结果（返回值而非抛错）
  const budgets = {};
  const key = 'session:s-x';
  for (let i = 0; i < 3; i++) assert.equal(tryEscalate(budgets, key).allowed, true);
  const fourth = tryEscalate(budgets, key);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.escalate, false);
  assert.equal(fourth.used, 3);
  assert.equal(fourth.remaining, 0);
  assert.equal(fourth.message, ESCALATE_REFUSED_MESSAGE);
  assert.match(fourth.message, /refused: upgrade budget spent/);
  assert.match(fourth.message, /Proceed on your best judgement; do not retry/);
  assert.equal(budgets[key], 3, 'refused 不再自增');
  // 第 5 次仍 refused，不抛错
  const fifth = tryEscalate(budgets, key);
  assert.equal(fifth.allowed, false);
  assert.equal(fifth.message, ESCALATE_REFUSED_MESSAGE);
  console.log('ok: 第 4 次 refused 非错误');
}

{
  // 预算尽不发新通知
  const budgets = {};
  const key = 'task:t-notify';
  assert.equal(shouldNotifyEscalate(tryEscalate(budgets, key)), true);
  assert.equal(shouldNotifyEscalate(tryEscalate(budgets, key)), true);
  assert.equal(shouldNotifyEscalate(tryEscalate(budgets, key)), true);
  const refused = tryEscalate(budgets, key);
  assert.equal(shouldNotifyEscalate(refused), false, '预算尽不得再发「等人」通知');
  console.log('ok: 预算尽不发新通知');
}

// ---------------------------------------------------------------------------
// 宿主接线：setStatus(needs_you) 计数，普通寄信不消费 + refused 正常结果
// ---------------------------------------------------------------------------
const { sessionsHost } = await import(
  pathToFileURL(compile('main/capabilities/hosts/sessions.ts')).href
);
const { ACTOR_SESSION_ID_ARG: actorKey } = await import(
  pathToFileURL(compile('main/capabilities/hosts/actors.ts')).href
);
// 通信单通道：未答提问从消息账本派生（挂账层已退役）
const { setAgentMessagesUserDataDir, readAgentMessageLedger } = await import(
  pathToFileURL(compile('main/metaAgent/messageStore.ts')).href
);
setAgentMessagesUserDataDir(tmp);
const questionsNow = () => readAgentMessageLedger('E:/ws', 'ws-1').messages.filter(mail => mail.kind === 'ask');

const sent = [];
const notifyCalls = [];
const worker = {
  id: 'eb-w',
  type: 'terminal',
  name: 'Worker-EB',
  runtime: 'pi',
  workspaceId: 'ws-1',
  worktreePath: 'E:/wt',
  worktreeBranch: 'ao/eb-w',
  escalateBudget: {}
};
const store = new Map([[worker.id, worker]]);

function mockCtx() {
  return {
    orchestrator: {
      isBusy: () => false,
      send: async (message, workspaceId) => {
        sent.push({ message, workspaceId });
      }
    },
    sessions: {
      get: (id) => store.get(id),
      resolveSessionRef: ({ sessionId }) => ({ id: sessionId }),
      broadcastMessagesChanged: () => {},
      setPhase: (id, phase) => {
        const s = store.get(id);
        s.phase = { value: phase.value, source: phase.source, ts: Date.now() };
        notifyCalls.push({ id, phase: phase.value });
        return s;
      },
      setLiveStatus: (id, live) => {
        const s = store.get(id);
        s.liveStatus = live;
        return s;
      },
      consumeEscalateBudget: (id, key) => {
        const s = store.get(id);
        const budgets = s.escalateBudget ?? (s.escalateBudget = {});
        return tryEscalate(budgets, key);
      },
      isChatRuntime: () => true,
      select: () => {},
      clearDonePhase: () => {},
      ensureStatusToken: () => {}
    },
    agentSessions: {
      isOpen: () => true,
      open: () => {},
      send: async () => ({ ok: true }),
      getTurnStartedAt: () => undefined,
      injectHostNudge: async () => ({ ok: true })
    },
    workspaces: { activePath: () => 'E:/ws', list: () => [{ id: 'ws-1', path: 'E:/ws' }] },
    resolveBubbleWorkspaceId: () => 'ws-1',
    schedulerStatus: { get: () => undefined, set: () => {} }
  };
}

function reset() {
  sent.length = 0;
  notifyCalls.length = 0;
  worker.escalateBudget = {};
  worker.phase = undefined;
  worker.liveStatus = undefined;
  fs.rmSync(path.join(tmp, 'agent-messages'), { recursive: true, force: true });
}

// 用户注意通知仍受预算约束；普通寄信 是普通通信，不消费或受此预算阻挡。
{
  reset();
  const ctx = mockCtx();
  await assert.rejects(() => sessionsHost['sessions.setStatus'](ctx, {
    sessionId: 'eb-w', phase: 'needs_you', note: '一二三四五六七八九十一'
  }), /10/);
  assert.equal(worker.phase, undefined, '超长文案不能先改变看板');
  assert.equal(worker.liveStatus, undefined);
  assert.equal(notifyCalls.length, 0);
  assert.deepEqual(worker.escalateBudget, {}, '校验失败不消耗通知预算');
  await sessionsHost['sessions.setStatus'](ctx, { sessionId: 'eb-w', note: '随意描述当前工作' });
  assert.equal(worker.liveStatus.label, '随意描述当前工作');
  assert.equal(worker.phase, undefined, '自由文案不改变生命周期');
}
{
  reset();
  const ctx = mockCtx();
  for (let i = 0; i < 3; i++) {
    const r = await sessionsHost['sessions.setStatus'](ctx, {
      sessionId: 'eb-w',
      phase: 'needs_you',
      note: `等验收 ${i}`
    });
    assert.ok(!r.refused, `第 ${i + 1} 次 needs_you 不应 refused`);
  }
  // 用尽用户注意通知预算仍可正常发问。
  const asked = await sessionsHost['sessions.message'](ctx,{to:"scheduler",kind:"ask",
    text: '被卡，以哪侧为准？',

    [actorKey]: 'eb-w'
  });
  assert.equal(asked.ok, true);
  assert.ok(!asked.refused);
  assert.ok(asked.messageId);
  assert.equal(worker.escalateBudget['session:eb-w'], 3);

  // 第 4 次 needs_you：refused 正常结果，不进 setPhase（不发「等人」通知）
  const beforeNotify = notifyCalls.length;
  const r4 = await sessionsHost['sessions.setStatus'](ctx, {
    sessionId: 'eb-w',
    phase: 'needs_you',
    note: '预算尽仍改 note'
  });
  assert.equal(r4.refused, true);
  assert.equal(r4.message, ESCALATE_REFUSED_MESSAGE);
  assert.match(r4.message, /refused: upgrade budget spent/);
  assert.equal(notifyCalls.length, beforeNotify, '预算尽不发新「等人」通知');
  assert.equal(worker.liveStatus?.label, '预算尽仍改 note', '预算尽仍可改 note');
  // refused 路径不再调 setPhase（看板列不被 refused 重写；既有 needs_you 是前 3 次留下的）

  // 继续通信不被用户注意通知预算拒绝。
  const sentBefore = sent.length;
  const r4ask = await sessionsHost['sessions.message'](ctx,{to:"scheduler",kind:"ask",
    text: '再问一次',

    [actorKey]: 'eb-w'
  });
  assert.equal(r4ask.ok, true); assert.equal(r4ask.refused, undefined);
  assert.equal(sent.length, sentBefore);
  assert.equal(questionsNow().length, 2);
  assert.equal(worker.escalateBudget['session:eb-w'], 3, '通信不烧用户通知预算');
  console.log('ok: 用户通知预算与普通通信解耦');
}

// 无任务条目回落会话链 key
// Standing reviewer: spent task budget cannot swallow a dispatched PASS/FAIL.
{
  reset(); const ctx = mockCtx(); worker.orchestrated = true;
  worker.escalateBudget['session:eb-w'] = 3;
  for (let i = 0; i < 22; i++) {
    const r = await sessionsHost['sessions.message'](ctx,{to:"scheduler",kind:"ask", text: `Question ${i}`, [actorKey]: worker.id });
    assert.ok(r.messageId, `dispatched review ${i} must be delivered after task budget exhaustion`);
    assert.equal(r.kind, 'ask', '统一寄信入口使用 ask 类别');
  }
  const count = sent.length;
  const continued = await sessionsHost['sessions.message'](ctx,{to:"scheduler",kind:"ask", text: 'Continue',  [actorKey]: worker.id });
  assert.equal(continued.refused, undefined); assert.equal(sent.length, count);
  assert.equal(worker.escalateBudget['session:eb-w'], 3, 'review rate limit is independent of needs_you');
  assert.equal(questionsNow().length, 23, '不再为通信另设20条待答或小时次数限制');
  delete worker.orchestrated;
  console.log('ok: communication shares transport without extra workflow limits');
}

{
  reset();
  const ctx = mockCtx();
  const r = await sessionsHost['sessions.setStatus'](ctx, {
    sessionId: 'eb-w',
    phase: 'needs_you',
    note: '会话链计数'
  });
  assert.ok(!r.refused);
  assert.equal(worker.escalateBudget['session:eb-w'], 1, '无任务挂会话任务链');
  console.log('ok: 无任务回落会话任务链');
}

// ---------------------------------------------------------------------------
// T5 文案断言：工具描述与 workerBrief 含四要素（最后手段/一次一问/context is required/预算 3）
// ---------------------------------------------------------------------------
{
  const catalogOut = compile('main/capabilities/catalog.ts');
  const { getToolDef } = await import(pathToFileURL(catalogOut).href);
  const setDef = getToolDef('sessions.setStatus');
  const askDef = getToolDef('sessions.message');
  assert.ok(setDef && askDef);
  assert.equal(setDef.parameters.properties.note.maxLength, 10);
  assert.equal(getToolDef('sessions.create').parameters.properties.statusVocabulary, undefined);

  assert.match(setDef.description, /必须用户行动时，报「需要你」并说清等什么/);
  assert.match(setDef.parameters.properties.reason.description, /one focused question with attempts\/blocker\/evidence/);
  assert.match(setDef.description, /Budget: 3 attention notifications per session/);
  assert.match(setDef.description, /If refused, do not retry/);
  assert.doesNotMatch(askDef.description, /Budget: 3|one focused question/, '普通消息不强制用户升级工作流');
  console.log('ok: 工具描述纪律四要素');
}

{
  const { buildHostIntro, buildTaskBriefText } = await import(
    pathToFileURL(compile('shared/workerBrief.ts')).href
  );
  for (const brief of [buildHostIntro(), buildTaskBriefText('排查登录 500')]) {
    assert.match(brief, /needs_you within 60s of turn start, add reason/);
    assert.doesNotMatch(brief, /不要自行开会话|合并计数/);
  }
  console.log('ok: CLI brief preserves early escalation reason');
}

{
  const { SESSIONS_OPS_TOOL_DEFS } = await import(
    pathToFileURL(compile('main/capabilities/catalog/sessionsOps.ts')).href
  );
  const status = SESSIONS_OPS_TOOL_DEFS.find(tool => tool.name === 'sessions.setStatus');
  const { buildDefaultDispatcherAppendBody } = await import(
    pathToFileURL(compile('main/agent/systemPrompt.ts')).href
  );
  assert.deepEqual(status.parameters.properties.phase.enum, ['needs_you', 'done']);
  assert.match(status.parameters.properties.phase.description, /需要你 = needs_you，完成 = done/);
  const { SESSION_PHASE_GUIDANCE } = await import(pathToFileURL(compile('shared/workerGuidance.ts')).href);
  assert.ok(status.description.includes(SESSION_PHASE_GUIDANCE));
  assert.ok(buildDefaultDispatcherAppendBody().includes(SESSION_PHASE_GUIDANCE));
  assert.match(status.description, new RegExp('Budget: ' + ESCALATE_BUDGET_LIMIT));
  assert.match(status.description, /do not retry/);
  assert.match(status.parameters.properties.reason.description, /Required for needs_you within 60s/);
  console.log('ok: registered status schema retains escalation guidance');
}

fs.rmSync(tmp, { recursive: true, force: true });

// ── 2026-09-27 复审回归：HTTP 状态通道不得绕过预算（pty Worker 的主上报通道） ──
{
  const shellApiSrc = fs.readFileSync(
    path.join(root, 'src', 'main', 'protocol', 'shellApi.ts'),
    'utf8'
  );
  // applyLiveStatus 对 needs_you 必须先过 consumeEscalateBudget，预算尽不 setPhase
  const fnStart = shellApiSrc.indexOf('private async applyLiveStatus');
  const fnSrc = shellApiSrc.slice(fnStart, shellApiSrc.indexOf('private async handle('));
  assert.ok(fnStart >= 0, 'applyLiveStatus 存在');
  assert.match(fnSrc, /escalateBudgetKey/, 'HTTP 通道 needs_you 走 escalateBudgetKey');
  assert.match(fnSrc, /consumeEscalateBudget/, 'HTTP 通道 needs_you 消费预算');
  const consumeIdx = fnSrc.indexOf('consumeEscalateBudget');
  const phaseIdx = fnSrc.indexOf('parsed.phase && !refusedEscalate');
  assert.ok(consumeIdx >= 0 && phaseIdx > consumeIdx, '预算判定在 setPhase 之前');
  assert.match(fnSrc, /refused/, '预算尽时 refused 进响应 body（Worker 读 curl 回包可见）');
  // setStatus 工具通道：粘性预检在预算消费之前（被拦的空转不烧额度）
  const sessionsSrc = fs.readFileSync(
    path.join(root, 'src', 'main', 'capabilities', 'hosts', 'sessions.ts'),
    'utf8'
  );
  assert.match(sessionsSrc, /stickyHeld/, 'setStatus 粘性预检存在');
  // 普通寄信不再设待答上限，也不消费升级预算
  const askIdx = sessionsSrc.indexOf("'sessions.message'");
  const askEnd = sessionsSrc.indexOf('const askId', askIdx);
  const askSrc = sessionsSrc.slice(askIdx, askEnd);
  assert.doesNotMatch(askSrc, /SCHEDULER_ASK_OPEN_CAP|consumeEscalateBudget/, '消息兼容入口不叠加问答政策');
  // refused 文案由限额常量派生（改限额不撒谎）
  assert.ok(ESCALATE_REFUSED_MESSAGE.includes(`(${ESCALATE_BUDGET_LIMIT}/${ESCALATE_BUDGET_LIMIT})`));
  console.log('ok: HTTP 通道预算 + 消费顺序 + 常量派生（源码锚）');
}

console.log('[ok] escalate-budget');
