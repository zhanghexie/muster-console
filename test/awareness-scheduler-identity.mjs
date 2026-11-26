/**
 * 感知面写/订阅：调度 Agent 与 Worker 同权（可写自己公示 / 可订 / 可注册），
 * Worker 边界不变（只写自己、不能自审）。无身份宿主直调仍拒。
 * 运行: node test/awareness-scheduler-identity.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-sched-id-'));
const compile = createSharedCompiler(root, tmp);

const { awarenessHost } = await import(
  pathToFileURL(compile('main/capabilities/hosts/awareness.ts')).href
);
const { dispatchRuntimeFacts } = await import(
  pathToFileURL(compile('main/awareness/dispatch.ts')).href
);
const { RuntimeAwarenessStore } = await import(
  pathToFileURL(compile('main/awareness/store.ts')).href
);
const { ACTOR_SESSION_ID_ARG } = await import(
  pathToFileURL(compile('main/capabilities/hosts/actors.ts')).href
);
const { runAsSchedulerTool } = await import(
  pathToFileURL(compile('main/agent/agentScope.ts')).href
);
const { projectSessionFacts } = await import(
  pathToFileURL(compile('shared/runtimeFactsQuery.ts')).href
);
const { observeHost } = await import(pathToFileURL(compile('main/sessions/observe.ts')).href);
const { setAgentMessagesUserDataDir, readAgentMessageLedger, readAgentMessageBody } = await import(
  pathToFileURL(compile('main/metaAgent/messageStore.ts')).href
);
setAgentMessagesUserDataDir(path.join(tmp, 'mail-user-data'));

const now = 1_700_000_000_000;
const orchId = 'orchestrator:ws-1';
const workerA = {
  id: 'se-a',
  type: 'terminal',
  name: '改码',
  runtime: 'pi',
  workspaceId: 'ws-1',
  lifecycle: 'working',
  archived: false
};
const sessionStore = new Map([[workerA.id, workerA]]);
const sent = [];
const orchSent = [];

function mockCtx(awareness, opts = {}) {
  const wsRoot = opts.wsRoot ?? fs.mkdtempSync(path.join(tmp, 'ws-'));
  return {
    awareness,
    sessions: {
      list: () => [...sessionStore.values()],
      get: (id) => sessionStore.get(id),
      broadcastMessagesChanged() {}
    },
    agentSessions: {
      isOpen: () => true,
      open: () => {},
      send: async (id, task) => {
        sent.push({ kind: 'inject', id, task });
        return { ok: true };
      }
    },
    orchestrator: {
      isBusy: () => true,
      observe: () => ({ createdAt: now, updatedAt: now, busy: true, lastReply: null }),
      send: async (text, wsId, _images, _opts) => {
        orchSent.push({ text, wsId });
      }
    },
    workspaces: {
      activePath: () => wsRoot,
      list: () => [{ id: 'ws-1', path: wsRoot }]
    },
    resolveBubbleWorkspaceId: () => 'ws-1',
    config: { get: () => ({ workspaces: [{ id: 'ws-1', path: wsRoot }], agentRules: [] }) },
    notify: { push: () => ({ id: 'n1' }) },
    ui: {}
  };
}

function identityMissing(fn, re) {
  assert.throws(fn, (e) => {
    assert.match(e.message, re);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 无身份宿主直调仍拒；调度调用链可写/可订/可注册
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'host-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);

  identityMissing(
    () => awarenessHost['share.set'](ctx, { text: '宿主直调' }),
    /会话身份/
  );
  identityMissing(
    () => awarenessHost['events.subscribe'](ctx, { kinds: 'session.phase' }),
    /会话身份/
  );
  await assert.rejects(
    () => awarenessHost['events.register'](ctx, { id: 'no-id', description: 'x', why: 'y' }),
    (e) => {
      assert.match(e.message, /会话身份/);
      return true;
    }
  );

  const set = await runAsSchedulerTool(() =>
    awarenessHost['share.set'](ctx, { text: '调度公示：盯合入' })
  );
  assert.equal(set.ok, true);
  assert.equal(set.entry.sessionId, orchId);
  assert.equal(set.entry.workspaceId, 'ws-1');
  assert.equal(set.entry.sessionName, '调度');

  const observed = await observeHost(ctx, { sessionId: orchId });
  assert.equal(observed.sessionId, orchId);
  assert.match(observed.summary.text, /盯合入/, '统一观察仍能读取调度自身公示');

  const sub = await runAsSchedulerTool(() =>
    awarenessHost['events.subscribe'](ctx, { kinds: 'session.phase' })
  );
  assert.equal(sub.ok, true);
  assert.equal(sub.subscription.subscriberSessionId, orchId);

  const reg = await runAsSchedulerTool(() =>
    awarenessHost['events.register'](ctx, {
      id: 'sched-ready',
      description: '调度提出的事件',
      why: '验证调度身份可注册'
    })
  );
  assert.equal(reg.ok, true);
  assert.equal(reg.event.proposerSessionId, orchId);
  assert.ok(reg.event.emitters.includes(orchId));

  const approvedOwn = await runAsSchedulerTool(() =>
    awarenessHost['events.review'](ctx, { id: 'sched-ready', decision: 'approve' })
  );
  assert.equal(approvedOwn.event.status, 'approved');
  const emitted = await runAsSchedulerTool(() =>
    awarenessHost['events.emit'](ctx, { id: 'sched-ready', summary: '调度发射' })
  );
  assert.equal(emitted.ok, true);
  assert.equal(emitted.fact.sessionId, orchId);
  await assert.rejects(
    () =>
      awarenessHost['events.emit'](ctx, {
        id: 'sched-ready',
        [ACTOR_SESSION_ID_ARG]: 'se-a'
      }),
    (e) => {
      assert.match(e.message, /不是该事件的登记发射方/);
      return true;
    }
  );
  console.log('ok: 调度可写/可订/可注册/可发射；无身份仍拒');
}

// ---------------------------------------------------------------------------
// Worker 边界：只写自己、不能冒充调度、不能自审
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'bound-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);

  const own = await awarenessHost['share.set'](ctx, {
    text: 'Worker 自己的公示',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  assert.equal(own.entry.sessionId, 'se-a');

  identityMissing(
    () =>
      awarenessHost['share.set'](ctx, {
        text: '冒充调度',
        sessionId: orchId,
        [ACTOR_SESSION_ID_ARG]: 'se-a'
      }),
    /其他会话/
  );

  await awarenessHost['events.register'](ctx, {
    id: 'worker-ready',
    description: 'Worker 提出',
    why: '自审应拒',
    [ACTOR_SESSION_ID_ARG]: 'se-a'
  });
  identityMissing(
    () =>
      awarenessHost['events.review'](ctx, {
        id: 'worker-ready',
        decision: 'approve',
        [ACTOR_SESSION_ID_ARG]: 'se-a'
      }),
    /不能审核自己/
  );

  const approved = await runAsSchedulerTool(() =>
    awarenessHost['events.review'](ctx, { id: 'worker-ready', decision: 'approve' })
  );
  assert.equal(approved.event.status, 'approved');
  assert.equal(approved.event.reviewedBy, 'scheduler');
  console.log('ok: Worker 只写自己 / 不能自审；调度仍可审');
}

// ---------------------------------------------------------------------------
// 调度订阅命中保存事件邮件，忙时不插话，且不会被 prune 掉
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'push-'));
  const awareness = new RuntimeAwarenessStore(dir);
  const ctx = mockCtx(awareness);
  orchSent.length = 0;
  sent.length = 0;

  await runAsSchedulerTool(() =>
    awarenessHost['events.subscribe'](ctx, { kinds: 'session.phase' })
  );
  const phaseFact = projectSessionFacts({
    id: 'se-a',
    name: '改码',
    workspaceId: 'ws-1',
    phase: { value: 'needs_you', ts: now }
  })[0];

  const hit = await dispatchRuntimeFacts(ctx, [phaseFact], { now: now + 10_000, debounceMs: 0 });
  assert.equal(hit.delivered, 1);
  const mail = readAgentMessageLedger('', 'ws-1').messages.at(-1);
  assert.equal(mail.to, orchId);
  assert.equal(mail.receipt, 'stored');
  assert.equal(mail.read, false);
  const body = JSON.parse(readAgentMessageBody('', 'ws-1', mail));
  assert.equal(body.type, 'event-notification');
  assert.equal(body.eventType, 'session.phase');
  assert.equal(orchSent.length, 0, '订阅正文不得直接插入忙调度');
  assert.equal(sent.length, 0, '订阅正文不得直接插入 Worker');
  assert.equal(awareness.listSubscriptions().some(s => s.subscriberSessionId === orchId), true);
  console.log('ok: 调度订阅保存邮箱，保留身份与未读回执');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] awareness-scheduler-identity');
