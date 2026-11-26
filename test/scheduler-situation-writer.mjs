/**
 * SITUATION.md 态势快照写入器（R-12/R-11）测试：采集容错（缺哪段省略哪段）、
 * 现采现写、fail-open、30s trailing 节流合并。
 * 数据源全用桩：任务表用真实临时盘文件，邮箱用真实 SQLite 行表与不可变正文文件，
 * 会话表/事件深度用注入桩。
 * 运行: node test/scheduler-situation-writer.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-situation-'));
const compile = createSharedCompiler(root, tmp);

const writer = await import(pathToFileURL(compile('main/orchestrator/situationWriter.ts')).href);
const store = await import(pathToFileURL(compile('main/metaAgent/schedulerMemoryStore.ts')).href);
const messageStore = await import(pathToFileURL(compile('main/metaAgent/messageStore.ts')).href);
const { readMailbox } = await import(pathToFileURL(compile('main/messages/read.ts')).href);
const delegateQueue = await import(pathToFileURL(compile('main/tasks/delegateQueue.ts')).href);
const events = await import(pathToFileURL(compile('main/orchestrator/events.ts')).href);

const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ws-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ud-'));
messageStore.setAgentMessagesUserDataDir(userData);

// 旧任务表种子：退役数据不应重新进入态势快照。
fs.mkdirSync(path.join(wsRoot, '.muster'), { recursive: true });
fs.writeFileSync(
  path.join(wsRoot, '.muster', 'tasks.json'),
  JSON.stringify({
    schemaVersion: 1,
    tasks: [
      { id: 't-1', title: '修复登录', status: 'in_progress', assignee: 's-1', dependsOn: [], locks: [], revision: 1, updatedBy: 'host', updatedAt: 5, priority: 1 },
      { id: 't-2', title: '已完成的旧任务', status: 'done', dependsOn: [], locks: [], revision: 1, updatedBy: 'host', updatedAt: 4 }
    ]
  })
);

// SQLite 行表混存：调度来信、其他收件人、宿主事件。快照只数调度普通未读来信。
// 通过真实写入口种子，确保测试覆盖「正文文件先落盘，再提交索引行」的当前合同。
for (const input of [
  { id: 'm-1', from: 's-1', to: 'scheduler', kind: 'ask', text: 'q', ts: 1, receipt: 'stored' },
  { id: 'm-2', from: 's-1', to: 'orchestrator:ws-a', kind: 'notice', text: 'n', ts: 2, receipt: 'stored' },
  { id: 'm-3', from: 'orchestrator:ws-a', to: 's-1', kind: 'notice', text: 'outgoing', ts: 3, receipt: 'stored' },
  { id: 'm-4', from: 's-1', to: 'host', kind: 'notice', text: 'human', ts: 4, receipt: 'stored' },
  { id: 'm-5', from: 'host', to: 'orchestrator:ws-a', kind: 'notice', text: 'native event', ts: 5, receipt: 'stored',
    meta: { hostNotification: { kind: 'event', eventId: 'event' } } },
  { id: 'm-6', from: 'host', to: 'scheduler', kind: 'notice', text: 'old fact', ts: 6, receipt: 'stored',
    meta: { eventId: 'legacy', subscriptionIds: ['sub'], digest: true } },
  { id: 'm-7', from: 'host', to: 'orchestrator:ws-a', kind: 'notice', text: 'old app event', ts: 7, receipt: 'stored',
    meta: { notificationKey: 'app:legacy' } }
]) await messageStore.appendAgentMessageToStore(wsRoot, 'ws-a', input);
await messageStore.markAgentMessagesReadInStore(wsRoot, 'ws-a', ['m-2']);

// 会话桩：ws-a 两个 needs_you Worker + 一个 idle；ws-b 的 listByWorkspace 抛错（源失败）
const needsYou = (id, name) => ({
  id,
  name,
  workspaceId: 'ws-a',
  type: 'terminal',
  launchKind: 'pty',
  phase: { value: 'needs_you', source: 'model', ts: 1 },
  hidden: false,
  archived: false
});
const sessionsById = new Map([
  ['s-1', needsYou('s-1', '改码W')],
  ['s-2', needsYou('s-2', '验UI')],
  ['s-3', { id: 's-3', name: '闲的', workspaceId: 'ws-a', type: 'terminal', launchKind: 'pty', phase: { value: 'idle', source: 'model' } }]
]);

function makeCtx(over = {}) {
  return {
    config: {
      get: () => ({
        workspaces: [
          { id: 'ws-a', name: 'Alpha', path: path.join(tmp, 'source-default'), controlRoot: wsRoot },
          { id: 'ws-b', name: 'Beta', path: path.join(wsRoot, 'b') }
        ],
        workspace: wsRoot,
        activeWorkspaceId: 'ws-a'
      })
    },
    workspaces: { list: () => [{ id: 'ws-a', path: wsRoot }, { id: 'ws-b', path: path.join(wsRoot, 'b') }] },
    sessions: {
      get: (id) => sessionsById.get(id),
      listByWorkspace: (ws) => {
        if (ws === 'ws-b') throw new Error('boom');
        return [...sessionsById.values()];
      }
    },
    ...over
  };
}

// 事件深度桩：ws-a 挂 3 条 pending
events.bindOrchestratorEventPump({ peek: (ws) => (ws === 'ws-a' ? [{}, {}, {}] : []) });

try {
  // ---------- 1) 采集：各源就位 + 单源失败省略 ----------
  {
    const ctx = makeCtx();
    delegateQueue.enqueueDelegate(ctx, 'ws-a', { isolate: false, task: '排队中的活' });
    const data = writer.collectSchedulerSituationData(ctx, 'ws-a');

    assert.equal(data.tasks, undefined, '已退役的共享任务表不重新进入态势快照');

    const a = data.workspaces.find((w) => w.name === 'Alpha');
    assert.deepEqual(a.needsYouNames.sort(), ['改码W', '验UI'], 'needs_you 名单（看板口径）');
    assert.equal(a.delegateQueued, 1);
    assert.equal(a.outboxUnread, 1, '只数调度普通未读来信，排除已读、其他收件人和新旧宿主事件');
    const inbox = await readMailbox(ctx, { includeBody: false }, { id: 'orchestrator:ws-a', hostView: false, workspaceId: 'ws-a' });
    assert.equal(inbox.unread, a.outboxUnread, '快照和调度 readMessages 的收件口径一致');
    assert.equal(a.eventQueueDepth, 3, '事件队列深度来自泵 peek');

    const b = data.workspaces.find((w) => w.name === 'Beta');
    assert.equal(b.needsYouNames, undefined, 'ws-b 会话源失败 → 名单段省略');
    assert.equal(b.delegateQueued, 0, '其余字段照常');
    console.log('ok: collectSchedulerSituationData（容错+省略）');
  }

  // ---------- 2) 现采现写：SITUATION.md 落盘 + 内容抽查 ----------
  {
    const r = writer.writeSchedulerSituationNow(makeCtx(), 'ws-a');
    assert.deepEqual(r, { ok: true });
    const md = store.readSchedulerSituation(wsRoot);
    assert.match(md, /# Situation snapshot/);
    assert.doesNotMatch(md, /t-1|修复登录/, '不注入旧任务表内容');
    assert.match(md, /- Alpha: needs you: 2 \(.*\) · queued delegations 1 · scheduler unread mail 1 · pending events 3/);
    assert.match(md, /- Beta: queued delegations 0/, 'Beta 缺名单段但其余照常');

    // fail-open：config 抛错不炸
    const bad = writer.writeSchedulerSituationNow({ config: { get: () => { throw new Error('x'); } }, sessions: {} }, 'ws-a');
    assert.deepEqual(bad, { ok: false });
    console.log('ok: writeSchedulerSituationNow（+fail-open）');
  }

  // ---------- 3) 30s trailing 节流：窗口内多信号合并一次写 ----------
  {
    writer.resetSchedulerSituationThrottleForTests();
    const fired = [];
    const timers = [];
    writer.bindSchedulerSituationContext(makeCtx());
    const fakeSetTimeout = (fn, ms) => {
      timers.push({ fn, ms });
      return { id: timers.length, unref: () => {} };
    };

    writer.noteSchedulerSituationChanged('ws-a', { setTimeoutFn: fakeSetTimeout });
    writer.noteSchedulerSituationChanged('ws-a', { setTimeoutFn: fakeSetTimeout });
    writer.noteSchedulerSituationChanged('ws-a', { setTimeoutFn: fakeSetTimeout });
    assert.equal(timers.length, 1, '窗口内多次信号只排一个定时器');
    assert.equal(timers[0].ms, writer.SITUATION_REFRESH_THROTTLE_MS, '缺省 30s');

    // 触发前改盘（旧快照），fire 后应为新采集内容
    fs.rmSync(path.join(wsRoot, '.muster', 'scheduler', 'SITUATION.md'), { force: true });
    timers[0].fn();
    assert.equal(timers.length, 1, 'fire 后未再自动排新定时器');
    assert.match(store.readSchedulerSituation(wsRoot), /# Situation snapshot/, 'fire 时现采现写');

    // fire 后新信号 → 新定时器（下一窗口）
    writer.noteSchedulerSituationChanged('ws-a', { setTimeoutFn: fakeSetTimeout });
    assert.equal(timers.length, 2);
    console.log('ok: noteSchedulerSituationChanged 节流');
  }

  // ---------- 4) 未登记工作区不得借 cfg.workspace 读取其它区任务 ----------
  {
    const data = writer.collectSchedulerSituationData(
      { config: { get: () => ({ workspaces: [], workspace: wsRoot, activeWorkspaceId: 'ws-a' }) }, sessions: { listByWorkspace: () => [], get: () => undefined } },
      'ws-a'
    );
    assert.equal(data.workspaces, undefined, '无工作区 → 概况节省略');
    assert.equal(data.tasks, undefined, '无工作区身份时不读取活动目录任务');
    console.log('ok: 概况节省略');
  }

  // ---------- 5) 还原即红锚：缺事件泵 → 深度回落 0（不炸） ----------
  {
    events.bindOrchestratorEventPump(null);
    const data = writer.collectSchedulerSituationData(makeCtx(), 'ws-a');
    assert.equal(data.workspaces.find((w) => w.name === 'Alpha').eventQueueDepth, 0);
  }

  // ---------- 6) 收信/已读落盘后刷新所有概况；不等下一次事件泵翻转 ----------
  {
    writer.bindSchedulerSituationContext(null);
    writer.resetSchedulerSituationThrottleForTests();
    const ctx = makeCtx({ sessions: { get: () => undefined, listByWorkspace: () => [], broadcastMessagesChanged() {} } });
    const timers = [];
    writer.bindSchedulerSituationContext(ctx, { setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref() {} };
    } });
    const input = { id: 'm-8', from: 's-1', to: 'orchestrator:ws-a', text: 'new letter', ts: 10, receipt: 'stored' };
    await messageStore.appendAgentMessageToStore(wsRoot, 'ws-a', input);
    assert.equal(timers.length, 2, '每份态势含所有工作区，收信后为两份快照各排一次刷新');
    assert.ok(timers.every(timer => timer.ms === writer.SITUATION_REFRESH_THROTTLE_MS));
    for (const timer of timers.splice(0)) timer.fn();
    for (const dir of [wsRoot, path.join(wsRoot, 'b')]) {
      assert.match(store.readSchedulerSituation(dir), /Alpha:.*unread mail 2/);
    }
    const received = await readMailbox(ctx, {}, { id: 'orchestrator:ws-a', hostView: false, workspaceId: 'ws-a' });
    assert.equal(received.unread, 0, '实际读信响应已反映本批已读');
    assert.equal(timers.length, 2, '只有已读回执也会触发快照刷新');
    await messageStore.markAgentMessagesReadInStore(wsRoot, 'ws-a', ['m-1', input.id]);
    await messageStore.appendAgentMessageToStore(wsRoot, 'ws-a', input);
    assert.equal(timers.length, 2, '重复已读和幂等寄信不重复排刷新');
    for (const timer of timers.splice(0)) timer.fn();
    for (const dir of [wsRoot, path.join(wsRoot, 'b')]) {
      assert.match(store.readSchedulerSituation(dir), /Alpha:.*unread mail 0/);
    }
    writer.bindSchedulerSituationContext(null);
    await messageStore.appendAgentMessageToStore(wsRoot, 'ws-a', { ...input, id: 'm-9' });
    assert.equal(timers.length, 0, '解绑后不遗留账本监听');
    console.log('ok: mailbox append/read receipts refresh every situation snapshot');
  }
} finally {
  events.bindOrchestratorEventPump(null);
  writer.bindSchedulerSituationContext(null);
  writer.resetSchedulerSituationThrottleForTests();
  delegateQueue.resetDelegateQueueForTests();
}

console.log('scheduler-situation-writer: all ok');
