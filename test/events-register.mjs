/**
 * 自定义事件注册/审核：pending → 审过可订可发；拒绝即关；Worker 不能自审；限频。
 * 运行: node test/events-register.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'events-register-'));
const compile = createSharedCompiler(root, tmp);
const { setAgentMessagesUserDataDir, readAgentMessageLedger } = await import(pathToFileURL(compile('main/metaAgent/messageStore.ts')).href);
setAgentMessagesUserDataDir(path.join(tmp, 'user'));

const {
  EVENT_ID_RE,
  normalizeEventId,
  normalizeEventText,
  authorizeEventReview,
  authorizeEventEmit,
  applyEventReview,
  decideEventEmit,
  emptyEventEmitLedger,
  customEventKind,
  projectCustomEventFact,
  pruneStaleEventEmitters
} = await import(pathToFileURL(compile('shared/runtimeEvents.ts')).href);

const { FACT_SUBSCRIBE_DEBOUNCE_MS, FACT_SUBSCRIBE_HOURLY_LIMIT } = await import(
  pathToFileURL(compile('shared/runtimeFactsSubscribe.ts')).href
);

const { RuntimeAwarenessStore } = await import(pathToFileURL(compile('main/awareness/store.ts')).href);
const { awarenessHost } = await import(
  pathToFileURL(compile('main/capabilities/hosts/awareness.ts')).href
);
const { ACTOR_SESSION_ID_ARG } = await import(
  pathToFileURL(compile('main/capabilities/hosts/actors.ts')).href
);
const { runAsSchedulerTool } = await import(
  pathToFileURL(compile('main/agent/agentScope.ts')).href
);
const { CATALOG_VERSION, getToolDef, WORKER_TOOL_ALLOWLIST, isWorkerAllowedTool } = await import(
  pathToFileURL(compile('main/capabilities/catalog.ts')).href
);

const now = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 纯函数：id / 审核身份 / 发射权限
// ---------------------------------------------------------------------------
{
  assert.equal(EVENT_ID_RE.test('build-ready'), true);
  assert.equal(normalizeEventId('Build-Ready').ok, true);
  assert.equal(normalizeEventId('Build-Ready').id, 'build-ready');
  assert.equal(normalizeEventId('session.phase').code, 'invalid');
  assert.equal(normalizeEventId('').code, 'empty');
  assert.equal(normalizeEventText('').code, 'empty');
  assert.equal(normalizeEventText('x'.repeat(501)).code, 'too_long');

  const self = authorizeEventReview({
    actorRole: 'worker',
    actorId: 'se-a',
    proposerSessionId: 'se-a'
  });
  assert.equal(self.code, 'self');
  const otherWorker = authorizeEventReview({
    actorRole: 'worker',
    actorId: 'se-b',
    proposerSessionId: 'se-a'
  });
  assert.equal(otherWorker.code, 'worker');
  const human = authorizeEventReview({
    actorRole: 'host',
    proposerSessionId: 'se-a'
  });
  assert.equal(human.ok, true);
  assert.equal(human.role, 'human');
  const sched = authorizeEventReview({
    actorRole: 'host',
    proposerSessionId: 'se-a',
    isScheduler: true
  });
  assert.equal(sched.role, 'scheduler');

  const pending = {
    id: 'build-ready',
    description: '构建完成',
    why: '让验收会话知道',
    status: 'pending',
    proposerSessionId: 'se-a',
    emitters: ['se-a'],
    createdAt: now
  };
  assert.equal(authorizeEventEmit(pending, 'se-a').code, 'pending');
  const approved = applyEventReview(pending, 'approve', { role: 'scheduler' }, now);
  assert.equal(approved.status, 'approved');
  assert.equal(authorizeEventEmit(approved, 'se-a').ok, true);
  assert.equal(authorizeEventEmit(approved, 'se-b').code, 'not_emitter');
  const rejected = applyEventReview(pending, 'reject', { role: 'human' }, now);
  assert.equal(rejected.status, 'rejected');
  assert.equal(authorizeEventEmit(rejected, 'se-a').code, 'rejected');

  const ledger = emptyEventEmitLedger();
  assert.equal(decideEventEmit('build-ready', 'se-a', ledger, now).ok, true);
  assert.equal(
    decideEventEmit('build-ready', 'se-a', ledger, now + FACT_SUBSCRIBE_DEBOUNCE_MS - 1).reason,
    'debounce'
  );
  for (let i = 1; i < FACT_SUBSCRIBE_HOURLY_LIMIT; i++) {
    assert.equal(
      decideEventEmit('build-ready', 'se-a', ledger, now + i * (FACT_SUBSCRIBE_DEBOUNCE_MS + 1)).ok,
      true
    );
  }
  assert.equal(
    decideEventEmit(
      'build-ready',
      'se-a',
      ledger,
      now + FACT_SUBSCRIBE_HOURLY_LIMIT * (FACT_SUBSCRIBE_DEBOUNCE_MS + 1)
    ).reason,
    'emitter_limit'
  );
  console.log('ok: 纯函数 id/审核/发射/限频');
}

assert.equal(customEventKind('build-ready'), 'event.build-ready');
assert.equal(projectCustomEventFact({
  id: 'build-ready',
  description: '构建完成',
  sessionId: 'se-a',
  now
}).kind, 'event.build-ready');

// ---------------------------------------------------------------------------
// Catalog / 白名单：review 不进 Worker
// ---------------------------------------------------------------------------
{
  assert.ok(Number(CATALOG_VERSION.split('.')[1] || 0) >= 37, `Catalog 版本随 R-18b 多仓组 bump（≥1.37，当前 ${CATALOG_VERSION}）`);
  for (const id of ['events.register', 'events.review', 'events.emit']) {
    assert.ok(getToolDef(id), `应有 ${id}`);
    assert.equal(getToolDef(id).dangerous, false);
  }
  assert.equal(WORKER_TOOL_ALLOWLIST.includes('events.register'), true);
  assert.equal(WORKER_TOOL_ALLOWLIST.includes('events.emit'), true);
  assert.equal(WORKER_TOOL_ALLOWLIST.includes('events.review'), false);
  assert.equal(isWorkerAllowedTool('events.review'), false);
  // 描述断言按意图守卫（Worker 不能审核）：catalog 描述已随事件面收敛改英文，兼容中英两版
  assert.match(getToolDef('events.review').description, /Workers cannot review|不在 Worker 白名单/);
  console.log('ok: catalog / Worker 不能调 review');
}

const sent = [];
const notified = [];
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

function mockCtx(awareness, opts = {}) {
  const wsRoot = opts.wsRoot ?? fs.mkdtempSync(path.join(tmp, 'ws-'));
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
    workspaces: {
      activePath: () => wsRoot,
      list: () => [{ id: 'ws-1', path: wsRoot }]
    },
    resolveBubbleWorkspaceId: () => 'ws-1',
    config: { get: () => ({ workspaces: [{ id: 'ws-1', path: wsRoot }], agentRules: [] }) },
    notify: {
      push: (item) => {
        notified.push(item);
        return { id: 'n1', ...item };
      }
    },
    ui: opts.ui ?? {}
  };
}

// ---------------------------------------------------------------------------
// 注册 → pending 落盘 + notify；未批准不能订/发
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'host-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);
  notified.length = 0;

  const reg = await awarenessHost['events.register'](ctx, {
    id: 'build-ready',
    description: '隔离树构建完成',
    why: '验收会话要立刻知道',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  assert.equal(reg.ok, true);
  assert.equal(reg.event.status, 'pending');
  assert.equal(reg.kind, 'event.build-ready');
  const pendingFile = path.join(
    ctx.workspaces.activePath(),
    '.muster',
    'events',
    'pending',
    'build-ready.json'
  );
  assert.equal(fs.existsSync(pendingFile), true, 'pending 目录落 .muster');
  assert.equal(notified.length, 1);
  assert.match(notified[0].text, /build-ready/);

  assert.throws(
    () =>
      awarenessHost['events.subscribe'](ctx, {
        kinds: 'event.build-ready',
        [ACTOR_SESSION_ID_ARG]: 'se-b'
      }),
    (e) => {
      assert.match(e.message, /未批准/);
      return true;
    }
  );
  await assert.rejects(
    () =>
      awarenessHost['events.emit'](ctx, {
        id: 'build-ready',
        [ACTOR_SESSION_ID_ARG]: 'se-a'
      }),
    (e) => {
      assert.match(e.message, /尚未批准|未批准/);
      return true;
    }
  );
  console.log('ok: 注册 pending + 未批准不能订/发 + notify');
}

// ---------------------------------------------------------------------------
// Worker 不能自审；调度审过 → 可订可发；拒绝即关
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'review-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);

  await awarenessHost['events.register'](ctx, {
    id: 'review-ready',
    description: '待验收',
    why: '互验',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });

  assert.throws(
    () =>
      awarenessHost['events.review'](ctx, {
        id: 'review-ready',
        decision: 'approve',
        [ACTOR_SESSION_ID_ARG]: 'se-a'
      }),
    (e) => {
      assert.match(e.message, /不能审核自己/);
      return true;
    }
  );
  assert.throws(
    () =>
      awarenessHost['events.review'](ctx, {
        id: 'review-ready',
        decision: 'approve',
        [ACTOR_SESSION_ID_ARG]: 'se-b'
      }),
    (e) => {
      assert.match(e.message, /不能审核自定义事件/);
      return true;
    }
  );

  const approved = await runAsSchedulerTool(() =>
    awarenessHost['events.review'](ctx, { id: 'review-ready', decision: 'approve' })
  );
  assert.equal(approved.event.status, 'approved');
  assert.equal(approved.event.reviewedBy, 'scheduler');
  assert.equal(
    fs.existsSync(
      path.join(ctx.workspaces.activePath(), '.muster', 'events', 'approved', 'review-ready.json')
    ),
    true
  );

  const sub = await awarenessHost['events.subscribe'](ctx, {
    kinds: 'event.review-ready',
    [ACTOR_SESSION_ID_ARG]: 'se-b'
  });
  assert.equal(sub.ok, true);
  sent.length = 0;
  const emitted = await awarenessHost['events.emit'](ctx, {
    id: 'review-ready',
    summary: '可以验收了',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  assert.equal(emitted.ok, true);
  assert.equal(emitted.fact.kind, 'event.review-ready');
  assert.equal(emitted.delivered, 1);
  const letters = readAgentMessageLedger('', 'ws-1').messages;
  assert.equal(letters.at(-1).to, 'se-b');
  assert.equal(letters.at(-1).meta.eventId.length, 64);
  assert.equal(sent.length, 0, '事件正文只存信，不直接注入');

  await assert.rejects(
    () =>
      awarenessHost['events.emit'](ctx, {
        id: 'review-ready',
        [ACTOR_SESSION_ID_ARG]: 'se-b'
      }),
    (e) => {
      assert.match(e.message, /登记发射方/);
      return true;
    }
  );
  console.log('ok: Worker 不能自审；调度批准后可订可发');
}

{
  const dir = fs.mkdtempSync(path.join(tmp, 'reject-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);
  await awarenessHost['events.register'](ctx, {
    id: 'nope',
    description: '不该过',
    why: '测试拒绝',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  const rejected = await runAsSchedulerTool(() =>
    awarenessHost['events.review'](ctx, { id: 'nope', decision: 'reject' })
  );
  assert.equal(rejected.event.status, 'rejected');
  await assert.rejects(
    () =>
      awarenessHost['events.emit'](ctx, {
        id: 'nope',
        [ACTOR_SESSION_ID_ARG]: 'se-a'
      }),
    (e) => {
      assert.match(e.message, /已拒绝/);
      return true;
    }
  );
  assert.throws(
    () =>
      awarenessHost['events.subscribe'](ctx, {
        kinds: 'event.nope',
        [ACTOR_SESSION_ID_ARG]: 'se-b'
      }),
    (e) => {
      assert.match(e.message, /未批准/);
      return true;
    }
  );
  console.log('ok: 拒绝即关');
}

// ---------------------------------------------------------------------------
// 人走确认框：批准 / 拒绝 / 超时仍 pending
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'human-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness, {
    ui: { confirm: async () => ({ confirmed: true }) }
  });
  const reg = await awarenessHost['events.register'](ctx, {
    id: 'human-ok',
    description: '人批',
    why: '确认框',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  assert.equal(reg.event.status, 'approved');
  assert.equal(reg.event.reviewedBy, 'human');

  const ctxReject = mockCtx(awareness, {
    ui: { confirm: async () => ({ confirmed: false, cancelledBy: 'button' }) }
  });
  const denied = await awarenessHost['events.register'](ctxReject, {
    id: 'human-no',
    description: '人拒',
    why: '确认框',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  assert.equal(denied.event.status, 'rejected');

  const ctxTimeout = mockCtx(awareness, {
    ui: { confirm: async () => ({ confirmed: false, cancelledBy: 'timeout' }) }
  });
  const timed = await awarenessHost['events.register'](ctxTimeout, {
    id: 'human-wait',
    description: '超时',
    why: '仍 pending',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  assert.equal(timed.event.status, 'pending', '确认超时不得关单，留给调度审');
  console.log('ok: 人走确认框');
}

// ---------------------------------------------------------------------------
// 发射限频（host 层）
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'rate-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);
  await awarenessHost['events.register'](ctx, {
    id: 'rate-me',
    description: '限频',
    why: '测',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  await runAsSchedulerTool(() =>
    awarenessHost['events.review'](ctx, { id: 'rate-me', decision: 'approve' })
  );
  await awarenessHost['events.emit'](ctx, {
    id: 'rate-me',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  await assert.rejects(
    () =>
      awarenessHost['events.emit'](ctx, {
        id: 'rate-me',
        [ACTOR_SESSION_ID_ARG]: 'se-a'
      }),
    (e) => {
      assert.match(e.message, /过快/);
      return true;
    }
  );
  console.log('ok: 发射防抖');
}

// ---------------------------------------------------------------------------
// R-16：emitters 悬空清理——纯函数 + 注册表落盘 + 启动接线
// 还原（prune 不过滤/不接线）→ 「悬空清/在册留/合成 id 留」断言转红
// ---------------------------------------------------------------------------
{
  // 纯函数：悬空清、在册留、orchestrator:<ws> 合成 id 留
  const alive = new Set(['se-a', 'orchestrator:ws-1']);
  assert.deepEqual(
    pruneStaleEventEmitters(['se-a', 'se-gone', 'orchestrator:ws-1', 'orchestrator:ws-gone'], alive),
    ['se-a', 'orchestrator:ws-1', 'orchestrator:ws-gone'],
    '悬空清、在册留；合成 id 一律保留（不进 sessions.list，无从判活）'
  );
  assert.deepEqual(pruneStaleEventEmitters(['se-gone'], alive), [], '清到空也无妨（无人能发≠删注册）');
  assert.deepEqual(pruneStaleEventEmitters([], alive), []);

  // 注册表：pending/approved 两种状态的 emitters 都改写落盘；注册本身与未变条目不动
  const { EventRegistry } = await import(
    pathToFileURL(compile('main/awareness/eventRegistry.ts')).href
  );
  const wsRoot = fs.mkdtempSync(path.join(tmp, 'prune-'));
  const registry = new EventRegistry();
  const mk = (id, status, emitters) => ({
    id,
    description: `${id} 描述`,
    why: '测',
    status,
    proposerSessionId: 'se-a',
    emitters,
    createdAt: now,
    workspaceId: 'ws-1'
  });
  registry.register(wsRoot, mk('ev-mixed', 'approved', ['se-a', 'se-gone', 'orchestrator:ws-1']));
  registry.register(wsRoot, mk('ev-pending', 'pending', ['se-gone']));
  registry.register(wsRoot, mk('ev-clean', 'approved', ['se-a']));

  const changed = registry.pruneStaleEmitters(wsRoot, ['se-a', 'orchestrator:ws-1']);
  assert.deepEqual(changed.sort(), ['ev-mixed', 'ev-pending'], '只报被清理的事件');
  const mixed = registry.get(wsRoot, 'ev-mixed');
  assert.equal(mixed.status, 'approved', '注册状态不动');
  assert.deepEqual(mixed.emitters, ['se-a', 'orchestrator:ws-1'], '悬空 id 从落盘文件里清掉');
  assert.deepEqual(registry.get(wsRoot, 'ev-pending').emitters, [], 'pending 也清（注册保留）');
  assert.ok(registry.get(wsRoot, 'ev-pending'), '清空的注册不删文件');
  assert.deepEqual(registry.get(wsRoot, 'ev-clean').emitters, ['se-a'], '无悬空条目原样');
  assert.deepEqual(registry.pruneStaleEmitters(wsRoot, ['se-a', 'orchestrator:ws-1']), [], '幂等');

  // 启动接线守卫：index.ts 装配点必须在启动 sweep 同处调 pruneStaleEmitters
  const indexSrc = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(
    indexSrc,
    /pruneStaleEmitters\(root,\s*aliveEventIds\)/,
    '启动时必须按工作区清 events emitters 悬空 id'
  );
  assert.match(
    indexSrc,
    /listAliveAwarenessSessionIds\(/,
    'alive 集必须走 listAliveAwarenessSessionIds（含 orchestrator 合成 id）'
  );
  console.log('ok: R-16 emitters 悬空清理（纯函数/注册表/启动接线）');
}

// ---------------------------------------------------------------------------
// F-06：同 id 并发注册串行化——后到方看到先写结果，不互相覆盖、不双方各自 ok
// 还原（去掉 registerSerialized 串行链 / 宿主不走临界区）→ 本块转红
// ---------------------------------------------------------------------------
{
  // 注册表层：临界区内的异步缝（确认框等 await）不再放大成覆盖写
  const { EventRegistry } = await import(
    pathToFileURL(compile('main/awareness/eventRegistry.ts')).href
  );
  const wsRoot = fs.mkdtempSync(path.join(tmp, 'serialize-'));
  const registry = new EventRegistry();
  const mkEntry = (proposer) => ({
    id: 'race-gap',
    description: '并发注册',
    why: '测',
    status: 'pending',
    proposerSessionId: proposer,
    emitters: [proposer],
    createdAt: now,
    workspaceId: 'ws-1'
  });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const race = (proposer, gapMs) =>
    registry.registerSerialized(wsRoot, 'race-gap', async (existing) => {
      if (existing) return { created: false, event: existing };
      await delay(gapMs); // 临界区内的异步缝
      const entry = mkEntry(proposer);
      registry.register(wsRoot, entry);
      return { created: true, event: entry };
    });
  const [first, second] = await Promise.all([race('se-a', 25), race('se-b', 5)]);
  assert.equal(first.created, true, '先到方正常写入');
  assert.equal(second.created, false, '后到方排队等先写方落盘后再判重');
  assert.equal(second.event.proposerSessionId, 'se-a', '后到方拿到的是先写内容');
  assert.equal(registry.get(wsRoot, 'race-gap').proposerSessionId, 'se-a', '先写内容不被后写覆盖');
  console.log('ok: F-06 注册临界区串行（异步缝不放大成覆盖写）');
}
{
  // 宿主工具层：并发同 id 注册只落先到方一个 pending，必有一方 existed:true
  const dir = fs.mkdtempSync(path.join(tmp, 'register-race-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);
  notified.length = 0;
  const [ra, rb] = await Promise.all([
    awarenessHost['events.register'](ctx, {
      id: 'race-same',
      description: 'A 提出',
      why: 'w',
      [ACTOR_SESSION_ID_ARG]: 'se-a'
    }),
    awarenessHost['events.register'](ctx, {
      id: 'race-same',
      description: 'B 提出',
      why: 'w',
      [ACTOR_SESSION_ID_ARG]: 'se-b'
    })
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  const pendingFile = path.join(
    ctx.workspaces.activePath(),
    '.muster',
    'events',
    'pending',
    'race-same.json'
  );
  const stored = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.equal(stored.proposerSessionId, 'se-a', '只落先到方的内容，后写不覆盖');
  const existed = [ra, rb].find((r) => r.existed === true);
  assert.ok(existed, '并发同 id 必有一方看到先写结果（existed:true）');
  assert.equal(existed.event.proposerSessionId, 'se-a');
  assert.equal(
    notified.filter((n) => String(n.text).includes('race-same')).length,
    1,
    '待审通知只发一次'
  );
  console.log('ok: F-06 并发同 id 注册后到方看到先写结果');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] events-register');
