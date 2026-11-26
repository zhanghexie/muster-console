/**
 * 调度角色默认订阅集：新工作区自动挂 / 幂等 / 退订后不复活。
 * 运行: node test/orchestrator-default-subscribe.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-default-sub-'));
const compile = createSharedCompiler(root, tmp);
const {setAgentMessagesUserDataDir,readAgentMessageLedger}=await import(pathToFileURL(compile('main/metaAgent/messageStore.ts')).href);setAgentMessagesUserDataDir(path.join(tmp,'user'));

const {
  ORCHESTRATOR_DEFAULT_SUBSCRIBE_KINDS,
  ORCHESTRATOR_DEFAULT_PHASE_Q,
  buildOrchestratorDefaultQuery,
  planOrchestratorDefaultSubscriptions,
  subscriptionCoversDefault,
  normalizeSubscribeQuery,
  matchSubscriptions,
  FACT_SUBSCRIBE_MAX_PER_SESSION
} = await import(pathToFileURL(compile('shared/runtimeFactsSubscribe.ts')).href);

const { orchestratorSessionId } = await import(
  pathToFileURL(compile('shared/runtimeFacts.ts')).href
);

const { projectSessionFacts } = await import(
  pathToFileURL(compile('shared/runtimeFactsQuery.ts')).href
);

const { RuntimeAwarenessStore } = await import(
  pathToFileURL(compile('main/awareness/store.ts')).href
);

const { ensureSchedulerDefaultSubscriptions } = await import(
  pathToFileURL(compile('main/awareness/defaults.ts')).href
);

const { awarenessHost } = await import(
  pathToFileURL(compile('main/capabilities/hosts/awareness.ts')).href
);

const { dispatchRuntimeFacts } = await import(
  pathToFileURL(compile('main/awareness/dispatch.ts')).href
);

const { ACTOR_SESSION_ID_ARG } = await import(
  pathToFileURL(compile('main/capabilities/hosts/actors.ts')).href
);

const { runAsSchedulerTool } = await import(
  pathToFileURL(compile('main/agent/agentScope.ts')).href
);

const now = 1_700_000_000_000;
const ws1 = 'ws-new';
const ws2 = 'ws-other';
const orch1 = orchestratorSessionId(ws1);
const orch2 = orchestratorSessionId(ws2);

function kindsOf(subs) {
  return subs.map((s) => (s.query.kinds ?? []).join(',')).sort();
}

// ---------------------------------------------------------------------------
// 纯函数：空表要挂 3 条；已覆盖跳过；已播种空操作
// ---------------------------------------------------------------------------
{
  assert.deepEqual(
    [...ORCHESTRATOR_DEFAULT_SUBSCRIBE_KINDS],
    ['pipeline.verdict', 'session.phase']
  );
  const phaseQ = buildOrchestratorDefaultQuery('session.phase', ws1);
  assert.deepEqual(phaseQ.kinds, ['session.phase']);
  assert.equal(phaseQ.workspaceId, ws1);
  assert.equal(phaseQ.q, ORCHESTRATOR_DEFAULT_PHASE_Q);

  const empty = planOrchestratorDefaultSubscriptions({
    subscriberSessionId: orch1,
    workspaceId: ws1,
    existing: [],
    seeded: false
  });
  assert.equal(empty.reason, 'add');
  assert.deepEqual(empty.kindsToAdd, ['pipeline.verdict', 'session.phase']);

  const seeded = planOrchestratorDefaultSubscriptions({
    subscriberSessionId: orch1,
    workspaceId: ws1,
    existing: [],
    seeded: true
  });
  assert.equal(seeded.reason, 'already_seeded');
  assert.deepEqual(seeded.kindsToAdd, []);

  const existingVerdict = {
    id: 'sub-1',
    subscriberSessionId: orch1,
    query: normalizeSubscribeQuery({ kinds: 'pipeline.verdict', workspaceId: ws1 }),
    createdAt: now
  };
  const partial = planOrchestratorDefaultSubscriptions({
    subscriberSessionId: orch1,
    workspaceId: ws1,
    existing: [existingVerdict],
    seeded: false
  });
  assert.equal(partial.reason, 'add');
  assert.deepEqual(partial.kindsToAdd, ['session.phase']);

  const broader = {
    id: 'sub-all',
    subscriberSessionId: orch1,
    query: normalizeSubscribeQuery({ workspaceId: ws1 }),
    createdAt: now
  };
  assert.equal(subscriptionCoversDefault(broader, 'pipeline.verdict', ws1), true);
  const covered = planOrchestratorDefaultSubscriptions({
    subscriberSessionId: orch1,
    workspaceId: ws1,
    existing: [broader],
    seeded: false
  });
  assert.equal(covered.reason, 'already_covered');
  assert.deepEqual(covered.kindsToAdd, []);
  console.log('ok: 纯函数规划 / 覆盖 / 已播种');
}

// ---------------------------------------------------------------------------
// 新工作区自动挂默认集；Worker 不受影响
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'new-'));
  const store = new RuntimeAwarenessStore(dir);
  const r = ensureSchedulerDefaultSubscriptions(store, [ws1], now);
  assert.equal(r.length, 1);
  assert.equal(r[0].added.length, 2);
  const mine = store.listSubscriptions(orch1);
  assert.equal(mine.length, 2);
  assert.deepEqual(kindsOf(mine), ['pipeline.verdict', 'session.phase']);
  const phase = mine.find((s) => s.query.kinds?.[0] === 'session.phase');
  assert.equal(phase.query.q, ORCHESTRATOR_DEFAULT_PHASE_Q);
  assert.equal(phase.query.workspaceId, ws1);
  assert.equal(store.listSubscriptions('se-worker').length, 0);
  assert.equal(store.isDefaultSeeded(orch1), true);
  console.log('ok: 新工作区自动挂默认集');
}

// ---------------------------------------------------------------------------
// 幂等：再确保不加条；已有等价订阅不重复挂
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'idemp-'));
  const store = new RuntimeAwarenessStore(dir);
  store.addSubscription({
    subscriberSessionId: orch1,
    query: normalizeSubscribeQuery({ kinds: 'pipeline.verdict', workspaceId: ws1 }),
    createdAt: now
  });
  const first = store.ensureOrchestratorDefaults(ws1, now);
  assert.equal(first.reason, 'add');
  assert.equal(first.added.length, 1);
  assert.equal(store.listSubscriptions(orch1).length, 2);

  const second = store.ensureOrchestratorDefaults(ws1, now + 1);
  assert.equal(second.reason, 'already_seeded');
  assert.equal(second.added.length, 0);
  assert.equal(store.listSubscriptions(orch1).length, 2);

  const again = ensureSchedulerDefaultSubscriptions(store, [ws1], now + 2);
  assert.equal(again[0].added.length, 0);
  console.log('ok: 幂等 / 已有不重复挂');
}

// ---------------------------------------------------------------------------
// 回归（2026-09-22 评审）：中途撞订阅上限不得标 seeded——否则默认集永久残缺。
// 还原即红：把 store.ensureOrchestratorDefaults 里「加完才落 seeded」改回
// 「无条件落 seeded」即挂。
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'limit-'));
  const store = new RuntimeAwarenessStore(dir);
  for (let i = 0; i < FACT_SUBSCRIBE_MAX_PER_SESSION; i++) {
    const r = store.addSubscription({
      subscriberSessionId: orch1,
      // kinds 填未知值会被归一化丢弃（空 kinds = 全匹配）；workspaceId 错开才不会
      // 被判成「已覆盖默认集」
      query: normalizeSubscribeQuery({ kinds: 'pipeline.verdict', workspaceId: `ws-filler-${i}` }),
      createdAt: now + i
    });
    assert.ok('id' in r, `填充订阅 ${i} 应成功`);
  }
  const blocked = store.ensureOrchestratorDefaults(ws1, now);
  assert.equal(blocked.reason, 'add', '计划确实要补默认集（不是已覆盖）');
  assert.equal(blocked.added.length, 0, '限额在顶：默认集一条也加不进');
  assert.equal(store.isDefaultSeeded(orch1), false, '没加成不能标 seeded');

  // 腾出容量后再 ensure：默认集补齐并落 seeded
  for (const sub of store.listSubscriptions(orch1)) {
    store.removeSubscription(sub.id, orch1);
  }
  const retried = store.ensureOrchestratorDefaults(ws1, now + 1);
  assert.equal(retried.reason, 'add');
  assert.equal(retried.added.length, ORCHESTRATOR_DEFAULT_SUBSCRIBE_KINDS.length);
  assert.equal(store.isDefaultSeeded(orch1), true, '补齐后才落 seeded');
  console.log('ok: 限额截断不标 seeded / 容量恢复后补齐');
}

// ---------------------------------------------------------------------------
// 退订后不复活（含落盘重开）
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'unsub-'));
  const store = new RuntimeAwarenessStore(dir);
  store.ensureOrchestratorDefaults(ws1, now);
  const phase = store.listSubscriptions(orch1).find((s) => s.query.kinds?.[0] === 'session.phase');
  assert.ok(phase);
  assert.equal(store.removeSubscription(phase.id, orch1), true);
  assert.equal(store.listSubscriptions(orch1).length, 1);

  const after = store.ensureOrchestratorDefaults(ws1, now + 10);
  assert.equal(after.reason, 'already_seeded');
  assert.equal(after.added.length, 0);
  assert.equal(store.listSubscriptions(orch1).length, 1);

  const reopened = new RuntimeAwarenessStore(dir);
  assert.equal(reopened.isDefaultSeeded(orch1), true);
  const afterReload = reopened.ensureOrchestratorDefaults(ws1, now + 20);
  assert.equal(afterReload.added.length, 0);
  assert.equal(reopened.listSubscriptions(orch1).length, 1);
  console.log('ok: 退订后不复活');
}

// ---------------------------------------------------------------------------
// 跨工作区各自一份；外区事实不命中
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'multi-'));
  const store = new RuntimeAwarenessStore(dir);
  ensureSchedulerDefaultSubscriptions(store, [ws1, ws2], now);
  assert.equal(store.listSubscriptions(orch1).length, 2);
  assert.equal(store.listSubscriptions(orch2).length, 2);
  assert.ok(store.listSubscriptions(orch1).every((s) => s.query.workspaceId === ws1));
  assert.ok(store.listSubscriptions(orch2).every((s) => s.query.workspaceId === ws2));

  const foreignPhase = projectSessionFacts({
    id: 'se-a',
    name: '改码',
    workspaceId: ws2,
    phase: { value: 'needs_you', ts: now }
  })[0];
  const hits1 = matchSubscriptions(store.listSubscriptions(orch1), foreignPhase);
  assert.equal(hits1.length, 0, '外区 needs_you 不得打到本区调度');
  const hits2 = matchSubscriptions(store.listSubscriptions(orch2), foreignPhase);
  assert.equal(hits2.length, 1);
  console.log('ok: 跨工作区各自一份');
}

// ---------------------------------------------------------------------------
// 相位噪音：idle 不命中默认集，needs_you 命中
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'noise-'));
  const store = new RuntimeAwarenessStore(dir);
  store.ensureOrchestratorDefaults(ws1, now);
  const subs = store.listSubscriptions(orch1);

  const idle = projectSessionFacts({
    id: 'se-a',
    name: '改码',
    workspaceId: ws1,
    phase: { value: 'idle', ts: now }
  })[0];
  assert.equal(matchSubscriptions(subs, idle).length, 0, 'idle 不得打到默认相位订');

  const needsYou = projectSessionFacts({
    id: 'se-a',
    name: '改码',
    workspaceId: ws1,
    phase: { value: 'needs_you', ts: now }
  })[0];
  assert.equal(matchSubscriptions(subs, needsYou).length, 1);

  console.log('ok: needs_you 才推相位');
}

// ---------------------------------------------------------------------------
// Host：播种后调度能收到推送；events.unsubscribe 后退订生效
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'host-'));
  const store = new RuntimeAwarenessStore(dir);
  store.ensureOrchestratorDefaults(ws1, now);
  const orchSent = [];
  const workerA = {
    id: 'se-a',
    type: 'terminal',
    name: '改码',
    runtime: 'pi',
    workspaceId: ws1,
    lifecycle: 'working',
    archived: false
  };
  const ctx = {
    awareness: store,
    sessions: {
      broadcastMessagesChanged() {},
      list: () => [workerA],
      get: (id) => (id === workerA.id ? workerA : undefined)
    },
    agentSessions: { isOpen: () => true, open: () => {}, send: async () => ({ ok: true }) },
    orchestrator: {
      isBusy:()=>true,
      send: async (text, wsId) => {
        orchSent.push({ text, wsId });
      }
    },
    workspaces: { activePath: () => 'E:/ws', list: () => [{ id: ws1, path: 'E:/ws' }] },
    resolveBubbleWorkspaceId: () => ws1,
    config: { get: () => ({ workspaces: [{ id: ws1, path: 'E:/ws' }], agentRules: [] }) }
  };

  const needsYou = projectSessionFacts({
    id: 'se-a',
    name: '改码',
    workspaceId: ws1,
    phase: { value: 'needs_you', ts: now }
  })[0];
  const hit = await dispatchRuntimeFacts(ctx, [needsYou], { now: now + 10_000, debounceMs: 0 });
  assert.equal(hit.delivered, 1);
  assert.equal(orchSent.length, 0);
  assert.equal(readAgentMessageLedger('',ws1).messages.at(-1).to,orch1);

  const phase = store.listSubscriptions(orch1).find((s) => s.query.kinds?.[0] === 'session.phase');
  const unsub = await runAsSchedulerTool(() =>
    awarenessHost['events.unsubscribe'](ctx, { id: phase.id })
  );
  assert.equal(unsub.ok, true);
  orchSent.length = 0;
  const after = await dispatchRuntimeFacts(ctx, [needsYou], { now: now + 20_000, debounceMs: 0 });
  assert.equal(after.delivered, 0);
  assert.equal(orchSent.length, 0);

  store.ensureOrchestratorDefaults(ws1, now + 30_000);
  orchSent.length = 0;
  const still = await dispatchRuntimeFacts(ctx, [needsYou], { now: now + 40_000, debounceMs: 0 });
  assert.equal(still.delivered, 0, '播种后再 ensure 不得把退订的相位订回来');
  console.log('ok: host 推送 / 退订 / 不复活');
}

// Worker 显式订阅仍可用（默认集不替 Worker 挂）
{
  const dir = fs.mkdtempSync(path.join(tmp, 'worker-'));
  const store = new RuntimeAwarenessStore(dir);
  ensureSchedulerDefaultSubscriptions(store, [ws1], now);
  const worker = {
    id: 'se-b',
    type: 'terminal',
    name: '验收',
    runtime: 'pi',
    workspaceId: ws1,
    lifecycle: 'idle',
    archived: false
  };
  const ctx = {
    awareness: store,
    sessions: {
      list: () => [worker],
      get: (id) => (id === worker.id ? worker : undefined)
    },
    workspaces: { list: () => [{ id: ws1, path: 'E:/ws' }] },
    resolveBubbleWorkspaceId: () => ws1,
    config: { get: () => ({ workspaces: [{ id: ws1, path: 'E:/ws' }], agentRules: [] }) }
  };
  const sub = await awarenessHost['events.subscribe'](ctx, {
    kinds: 'session.phase',
    [ACTOR_SESSION_ID_ARG]: 'se-b'
  });
  assert.equal(sub.ok, true);
  assert.equal(store.listSubscriptions('se-b').length, 1);
  assert.equal(store.listSubscriptions(orch1).length, 2);
  console.log('ok: Worker 仍须显式订阅');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] orchestrator-default-subscribe');
