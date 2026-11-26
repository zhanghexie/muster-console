/**
 * 内置订阅：默认不订、命中注入、防抖、限频。
 * 运行: node test/facts-subscribe.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-subscribe-'));
const compile = createSharedCompiler(root, tmp);

const {
  FACT_SUBSCRIBE_DEBOUNCE_MS,
  FACT_SUBSCRIBE_HOURLY_LIMIT,
  emptySubscribeLedger,
  matchSubscriptions,
  decideSubscribeDelivery,
  normalizeSubscribeQuery
} = await import(pathToFileURL(compile('shared/runtimeFactsSubscribe.ts')).href);

const { projectSessionFacts } = await import(
  pathToFileURL(compile('shared/runtimeFactsQuery.ts')).href
);

const { RuntimeAwarenessStore } = await import(
  pathToFileURL(compile('main/awareness/store.ts')).href
);

const { awarenessHost } = await import(
  pathToFileURL(compile('main/capabilities/hosts/awareness.ts')).href
);
const { dispatchRuntimeFacts: dispatchActual } = await import(
  pathToFileURL(compile('main/awareness/dispatch.ts')).href
);
const { ACTOR_SESSION_ID_ARG } = await import(
  pathToFileURL(compile('main/capabilities/hosts/actors.ts')).href
);

const {setAgentMessagesUserDataDir,readAgentMessageLedger}=await import(pathToFileURL(compile('main/metaAgent/messageStore.ts')).href);
setAgentMessagesUserDataDir(path.join(tmp,'user'));
let eventNumber=0;
const dispatchRuntimeFacts=(ctx,facts,opts)=>dispatchActual(ctx,facts.map(f=>({...f,id:f.id+':'+(++eventNumber),ts:opts?.now??f.ts})),opts);
const now = 1_700_000_000_000;
const phaseFact = projectSessionFacts({
  id: 'se-a',
  name: '改码',
  workspaceId: 'ws-1',
  phase: { value: 'needs_you', ts: now }
})[0];

const subB = {
  id: 'sub-b',
  subscriberSessionId: 'se-b',
  query: normalizeSubscribeQuery({ kinds: 'session.phase' }),
  createdAt: now
};

// ---------------------------------------------------------------------------
// 默认不订：空订阅表不匹配
// ---------------------------------------------------------------------------
{
  assert.equal(matchSubscriptions([], phaseFact).length, 0);
  console.log('ok: 默认不订');
}

// ---------------------------------------------------------------------------
// 查询过滤：kinds / sessionId
// ---------------------------------------------------------------------------
{
  const hit = matchSubscriptions([subB], phaseFact);
  assert.equal(hit.length, 1);
  const missKind = matchSubscriptions(
    [{ ...subB, query: normalizeSubscribeQuery({ kinds: 'git.integrate' }) }],
    phaseFact
  );
  assert.equal(missKind.length, 0);
  const missSid = matchSubscriptions(
    [{ ...subB, query: normalizeSubscribeQuery({ kinds: 'session.phase', sessionId: 'se-z' }) }],
    phaseFact
  );
  assert.equal(missSid.length, 0);
  console.log('ok: 查询过滤');
}

// ---------------------------------------------------------------------------
// 不推自己 / 防抖 / 限频
// ---------------------------------------------------------------------------
{
  const self = { ...subB, subscriberSessionId: 'se-a' };
  assert.equal(decideSubscribeDelivery(self, phaseFact, emptySubscribeLedger(), now).reason, 'self');

  const ledger = emptySubscribeLedger();
  assert.equal(decideSubscribeDelivery(subB, phaseFact, ledger, now).ok, true);
  assert.equal(
    decideSubscribeDelivery(subB, phaseFact, ledger, now + FACT_SUBSCRIBE_DEBOUNCE_MS - 1).reason,
    'debounce'
  );
  assert.equal(
    decideSubscribeDelivery(subB, phaseFact, ledger, now + FACT_SUBSCRIBE_DEBOUNCE_MS).ok,
    true
  );

  const capped = emptySubscribeLedger();
  for (let i = 0; i < FACT_SUBSCRIBE_HOURLY_LIMIT; i++) {
    const r = decideSubscribeDelivery(subB, phaseFact, capped, now + i * (FACT_SUBSCRIBE_DEBOUNCE_MS + 1));
    assert.equal(r.ok, true, `第 ${i + 1} 条应放行`);
  }
  const over = decideSubscribeDelivery(
    subB,
    phaseFact,
    capped,
    now + FACT_SUBSCRIBE_HOURLY_LIMIT * (FACT_SUBSCRIBE_DEBOUNCE_MS + 1)
  );
  assert.equal(over.reason, 'subscriber_limit');
  console.log('ok: 自己/防抖/订阅方限频');
}

{
  const ledger = emptySubscribeLedger();
  for (let i = 0; i < FACT_SUBSCRIBE_HOURLY_LIMIT; i++) {
    const other = { ...subB, id: `sub-${i}`, subscriberSessionId: `se-sub-${i}` };
    assert.equal(
      decideSubscribeDelivery(other, phaseFact, ledger, now + i * (FACT_SUBSCRIBE_DEBOUNCE_MS + 1)).ok,
      true
    );
  }
  const extra = { ...subB, id: 'sub-extra', subscriberSessionId: 'se-extra' };
  const over = decideSubscribeDelivery(
    extra,
    phaseFact,
    ledger,
    now + FACT_SUBSCRIBE_HOURLY_LIMIT * (FACT_SUBSCRIBE_DEBOUNCE_MS + 1)
  );
  assert.equal(over.reason, 'emitter_limit');
  console.log('ok: 发射方限频');
}



// ---------------------------------------------------------------------------
// 落盘：关闭即删
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'store-'));
  const store = new RuntimeAwarenessStore(dir);
  const added = store.addSubscription({
    subscriberSessionId: 'se-b',
    query: normalizeSubscribeQuery({ kinds: 'session.phase' })
  });
  assert.equal('id' in added && added.id.startsWith('sub-'), true);
  assert.equal(store.listSubscriptions('se-b').length, 1);
  const again = new RuntimeAwarenessStore(dir);
  assert.equal(again.listSubscriptions('se-b').length, 1);
  again.clearSubscriptions('se-b');
  assert.equal(again.listSubscriptions().length, 0);
  console.log('ok: 订阅落盘与关闭即删');
}

// ---------------------------------------------------------------------------
// Host：订阅命中注入 / 默认不订 / 防抖 / 限频 / 已结束不投
// ---------------------------------------------------------------------------
const sent = [];
const workerA = {
  id: 'se-a',
  type: 'terminal',
  name: '改码',
  runtime: 'pi',
  workspaceId: 'ws-1',
  lifecycle: 'working',
  archived: false
};
const workerB = {
  id: 'se-b',
  type: 'terminal',
  name: '验收',
  runtime: 'pi',
  workspaceId: 'ws-1',
  lifecycle: 'idle',
  archived: false
};
const sessionStore = new Map([
  [workerA.id, workerA],
  [workerB.id, workerB]
]);

function mockCtx(awareness) {
  return {
    awareness,
    sessions: {
      broadcastMessagesChanged() {},
      list: () => [...sessionStore.values()],
      get: (id) => sessionStore.get(id),
      resolveSessionRef: ({ sessionId }) => ({ id: sessionId }),
      isChatRuntime: () => true,
      select: () => {},
      clearDonePhase: () => {},
      setLiveStatus: () => {},
      ensureStatusToken: () => {},
      setOrchestrated: () => {}
    },
    agentSessions: {
      isBusy: () => true,
      isOpen: () => true,
      open: () => {},
      send: async (id, task) => {
        sent.push({ kind: 'inject', id, task });
        return { ok: true };
      }
    },
    workspaces: { activePath: () => 'E:/ws', list: () => [{ id: 'ws-1', path: 'E:/ws' }] },
    resolveBubbleWorkspaceId: () => 'ws-1',
    config: { get: () => ({ workspaces: [{ id: 'ws-1', path: 'E:/ws' }], agentRules: [] }) }
  };
}

{
  const dir = fs.mkdtempSync(path.join(tmp, 'host-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);
  sent.length = 0;
  workerB.archived = false;
  workerB.lifecycle = 'idle';

  const none = await dispatchRuntimeFacts(ctx, [phaseFact], { now, debounceMs: 0 });
  assert.equal(none.delivered, 0, '默认不订不得注入');
  assert.equal(sent.length, 0);

  const sub = await awarenessHost['events.subscribe'](ctx, {
    kinds: 'session.phase',
    [ACTOR_SESSION_ID_ARG]: 'se-b'
  });
  assert.equal(sub.ok, true);
  assert.equal(sub.subscription.query.kinds[0], 'session.phase');

  sent.length = 0;
  const hit = await dispatchRuntimeFacts(ctx, [phaseFact], { now: now + 10_000, debounceMs: 0 });
  assert.equal(hit.delivered, 1);
  assert.equal(sent.length, 0, '正文通过邮箱保存');
  assert.equal(readAgentMessageLedger('', 'ws-1').messages.at(-1).to, 'se-b');

  sent.length = 0;
  const debounced = await dispatchRuntimeFacts(ctx, [phaseFact], {
    now: now + 10_000 + 100,
    debounceMs: 2000
  });
  assert.equal(debounced.delivered, 0);
  assert.equal(sent.length, 0, '防抖窗口内不得再注入');

  sent.length = 0;
  for (let i = 0; i < FACT_SUBSCRIBE_HOURLY_LIMIT; i++) {
    await dispatchRuntimeFacts(ctx, [phaseFact], {
      now: now + 20_000 + i * 3000,
      debounceMs: 2000,
      hourlyLimit: FACT_SUBSCRIBE_HOURLY_LIMIT
    });
  }
  sent.length = 0;
  const limited = await dispatchRuntimeFacts(ctx, [phaseFact], {
    now: now + 20_000 + FACT_SUBSCRIBE_HOURLY_LIMIT * 3000,
    debounceMs: 2000,
    hourlyLimit: FACT_SUBSCRIBE_HOURLY_LIMIT
  });
  assert.equal(limited.delivered, 0, '超每小时上限不得注入');
  assert.equal(sent.length, 0);

  await awarenessHost['events.unsubscribe'](ctx, {
    id: sub.subscription.id,
    [ACTOR_SESSION_ID_ARG]: 'se-b'
  });
  sent.length = 0;
  const afterUnsub = await dispatchRuntimeFacts(ctx, [phaseFact], {
    now: now + 400_000,
    debounceMs: 0
  });
  assert.equal(afterUnsub.delivered, 0, '退订后不再注入');

  const sub2 = await awarenessHost['events.subscribe'](ctx, {
    kinds: 'session.phase',
    [ACTOR_SESSION_ID_ARG]: 'se-b'
  });
  workerB.archived = true;
  sent.length = 0;
  const ended = await dispatchRuntimeFacts(ctx, [phaseFact], { now: now + 500_000, debounceMs: 0 });
  assert.equal(ended.delivered, 0, '已结束不得注入');
  assert.equal(sent.length, 0);
  await awarenessHost['events.unsubscribe'](ctx, {
    id: sub2.subscription.id,
    [ACTOR_SESSION_ID_ARG]: 'se-b'
  });
  workerB.archived = false;

  assert.throws(
    () => awarenessHost['events.subscribe'](ctx, { kinds: 'session.phase' }),
    (e) => {
      assert.match(e.message, /会话身份/);
      return true;
    }
  );
  console.log('ok: host 命中注入 / 默认不订 / 防抖 / 限频 / 已结束');
}

// ---------------------------------------------------------------------------
// X1-F03：eventId 排除 ts 的语义键——同值重报（ts 不同）只产生一封信；值变化才新信
// 用独立发射者 se-x / 收件人 se-dedup（账本按 workspaceId 全局共享，隔离前序块的信）
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'dedup-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);
  sessionStore.set('se-dedup', {
    id: 'se-dedup', type: 'terminal', name: '去重观察', runtime: 'pi',
    workspaceId: 'ws-1', lifecycle: 'idle', archived: false
  });
  await awarenessHost['events.subscribe'](ctx, {
    kinds: 'session.phase',
    [ACTOR_SESSION_ID_ARG]: 'se-dedup'
  });
  const lettersOf = () =>
    readAgentMessageLedger('', 'ws-1').messages.filter((m) => m.to === 'se-dedup' && m.meta?.eventId);
  const emit = (value, ts) =>
    projectSessionFacts({ id: 'se-x', name: '改码', workspaceId: 'ws-1', phase: { value, ts } })[0];

  // 第一次：needs_you → 一封信
  const r1 = await dispatchRuntimeFacts(ctx, [emit('needs_you', now)], { now, debounceMs: 0 });
  assert.equal(r1.delivered, 1);
  assert.equal(lettersOf().length, 1, '首次相位投递一封信');

  // 第二次：同值 needs_you、不同 ts、防抖已过 → 幂等去重，不再产生新信
  const r2 = await dispatchRuntimeFacts(ctx, [emit('needs_you', now + 120_000)], { now: now + 120_000, debounceMs: 0 });
  assert.equal(r2.delivered, 1, '同值重报按已投递记账（不重复存信）');
  assert.equal(lettersOf().length, 1, 'X1-F03：同值重报不产生第二封信');

  // 值真正变化（needs_you → done）→ 新语义键 → 新信
  const r3 = await dispatchRuntimeFacts(ctx, [emit('done', now + 240_000)], { now: now + 240_000, debounceMs: 0 });
  assert.equal(r3.delivered, 1);
  assert.equal(lettersOf().length, 2, '值变化照常投新信');
  assert.notEqual(lettersOf()[0].meta.eventId, lettersOf()[1].meta.eventId, '不同值事件键不同');
  console.log('ok: X1-F03 同值重报只产生一封信');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] facts-subscribe');
