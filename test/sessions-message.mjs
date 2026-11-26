/**
 * sessions.message 邮箱 + 保存回执、结束身份兼容。
 * 信件先保存，无正文直投或异常审计副本；收件回执与宿主唤醒分离。
 * O4：kind/replyTo 入参、SQLite 投递账本落账/read 语义/outbox 查询。
 * Run: node test/sessions-message.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-message-'));
const compile = createSharedCompiler(root, tmp);

const { sessionsHost } = await import(pathToFileURL(compile('main/capabilities/hosts/sessions.ts')).href);
const { ACTOR_SESSION_ID_ARG } = await import(
  pathToFileURL(compile('main/capabilities/hosts/actors.ts')).href
);
// 同一编译产物（编译器按相对路径缓存）：sessions.ts 依赖的 messageStore 与此处同模块实例
const messageStore = await import(pathToFileURL(compile('main/metaAgent/messageStore.ts')).href);
// 预发布 clean-break：邮箱直接使用 userData/agent-messages/<safeScopedKey>.sqlite。
const msgUserData = path.join(tmp, 'user-data');
fs.mkdirSync(msgUserData, { recursive: true });
messageStore.setAgentMessagesUserDataDir(msgUserData);
const ledgerFile = (wsId) => messageStore.agentMessagesFilePath(wsId);
const {
  appendAgentMessage,
  evictAgentMessages,
  parseAgentMessageLedger,
  markAgentMessagesRead,
  queryAgentMessageOutbox,
  agentMessageReplyToExists,
  isAgentMessageTargetEnded,
  resolveAgentMessageTarget,
  rememberEndedSessionRef,
  findEndedSessionRef,
  parseEndedSessionRefs,
  toEndedSessionRef,
  AGENT_MESSAGES_MAX
} = await import(pathToFileURL(compile('shared/agentMessage.ts')).href);

// 工作区根指向 tmp，邮箱实际落在注入的 userData SQLite 目录。
const wsRoot = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsRoot, '.muster'), { recursive: true });

const sent = [];
const workerA = {
  id: 'se-a',
  type: 'terminal',
  name: '改码 Worker',
  runtime: 'pi',
  workspaceId: 'ws-1',
  lifecycle: 'working',
  archived: false
};
const workerB = {
  id: 'se-b',
  type: 'terminal',
  name: '验收 Worker',
  runtime: 'pi',
  workspaceId: 'ws-1',
  lifecycle: 'idle',
  archived: false
};
const store = new Map([
  [workerA.id, workerA],
  [workerB.id, workerB]
]);
/** close() 墓碑：registry 已删、peekEnded 仍能回执 session_ended */
const endedStore = new Map();

function mockCtx() {
  const ctx = {
    orchestrator: {
      isBusy: () => false,
      send: async (message, workspaceId, _images, opts) => {
        sent.push({ kind: 'audit', message, workspaceId, host: opts?.host });
      }
    },
    sessions: {
      get: (id) => store.get(id),
      broadcastMessagesChanged: () => {},
      peek: (id) => store.get(id),
      peekEnded: (id) => endedStore.get(id),
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
    workspaces: { activePath: () => wsRoot, list: () => [{ id: 'ws-1', path: wsRoot }] },
    resolveBubbleWorkspaceId: () => 'ws-1',
    config: { get: () => ({ workspaces: ctx.workspaces.list(), agentRules: [] }) }
  };
  return ctx;
}

const actor = { [ACTOR_SESSION_ID_ARG]: 'se-a' };

const live = await sessionsHost['sessions.message'](mockCtx(), { to:'se-b', text:'报告', ...actor });
assert.equal(live.receipt,'stored'); assert.equal(live.stored,true);assert.equal(live.delivered,false);
assert.equal(sent.length,0,'正文不注入、无调度副本');
assert.equal(messageStore.readAgentMessageLedger(wsRoot,'ws-1').messages[0].read,false);
workerB.archived=true;
const archived = await sessionsHost['sessions.message'](mockCtx(), {to:'se-b',text:'归档仍保留信件',...actor});
assert.equal(archived.receipt,'stored');assert.equal(archived.wake,'disabled');workerB.archived=false;
workerB.lifecycle='exited';
const exited=await sessionsHost['sessions.message'](mockCtx(),{to:'se-b',text:'停止后可被宿主唤醒',...actor});
assert.equal(exited.receipt,'stored');assert.equal(exited.wake,'pending');workerB.lifecycle='idle';
endedStore.set('old',{id:'old',workspaceId:'ws-1',endedAt:1});
const deleted=await sessionsHost['sessions.message'](mockCtx(),{to:'old',text:'删除留档',...actor});
assert.equal(deleted.wake,'disabled');
await assert.rejects(()=>sessionsHost['sessions.message'](mockCtx(),{to:'fake',text:'x',...actor}),/不存在/);
await assert.rejects(()=>sessionsHost['sessions.message'](mockCtx(),{to:'se-b',text:'x',[ACTOR_SESSION_ID_ARG]:'missing-sender'}),/sender session does not exist/);
await assert.rejects(()=>sessionsHost['sessions.message'](mockCtx(),{to:'se-b',text:'x',kind:'spam',...actor}),/kind 非法/);
await assert.rejects(()=>sessionsHost['sessions.message'](mockCtx(),{to:'se-b',text:'x',replyTo:'m-9999',...actor}),/不存在/);
const reply=await sessionsHost['sessions.message'](mockCtx(),{to:'se-b',text:'答复',kind:'answer',replyTo:live.messageId,...actor});
assert.equal(messageStore.readAgentMessageLedger(wsRoot,'ws-1').messages.at(-1).replyTo,live.messageId);
const noScheduler=mockCtx();delete noScheduler.orchestrator;
assert.equal((await sessionsHost['sessions.message'](noScheduler,{to:'se-b',text:'不依赖调度',...actor})).receipt,'stored');
const broken=ledgerFile('ws-broken');fs.mkdirSync(broken,{recursive:true});
store.set('broken',{id:'broken',workspaceId:'ws-broken'});
await assert.rejects(()=>sessionsHost['sessions.message'](mockCtx(),{to:'broken',text:'保存失败必须报错',...actor}),/索引读取失败/);
assert.equal(sent.length,0);
// Legacy parsing and rolling helper now preserve every receipt and reply anchor.
const ledger=messageStore.readAgentMessageLedger(wsRoot,'ws-1');
assert.equal(queryAgentMessageOutbox(ledger,{actorId:'stranger'}).total,0);
assert.equal(queryAgentMessageOutbox(ledger,{hostView:true}).unread,ledger.messages.length);
assert.equal(markAgentMessagesRead(ledger,[live.messageId],42).messages[0].readAt,42);
assert.equal(agentMessageReplyToExists(ledger,live.messageId),true);
const all=Array.from({length:AGENT_MESSAGES_MAX+30},(_,i)=>({...ledger.messages[0],id:`m-${i+1}`}));
assert.equal(evictAgentMessages(all).length,230);
assert.equal(parseAgentMessageLedger({messages:all}).messages.length,230);
const added=appendAgentMessage({schemaVersion:1,seq:2,messages:[]},{from:'a',to:'b',text:'x',ts:1,receipt:'stored'});
assert.equal(added.entry.id,'m-3');assert.equal(added.entry.read,false);
console.log('ok: 保存回执、禁止正文注入、结束身份、无调度与写失败边界');
{
  assert.equal(isAgentMessageTargetEnded({}), false);
  assert.equal(isAgentMessageTargetEnded({ lifecycle: 'working' }), false);
  assert.equal(isAgentMessageTargetEnded({ status: 'running' }), false);
  assert.equal(isAgentMessageTargetEnded({ archived: true }), true);
  assert.equal(isAgentMessageTargetEnded({ lifecycle: 'exited' }), true);
  assert.equal(isAgentMessageTargetEnded({ status: 'exited' }), true);
  assert.equal(
    isAgentMessageTargetEnded({ status: 'running', lifecycle: 'exited' }),
    true,
    'GUI project 可能把 status 盖成 running，lifecycle 仍算结束'
  );

  const liveHit = resolveAgentMessageTarget(
    { id: 'se-live', lifecycle: 'idle' },
    { id: 'se-dead' }
  );
  assert.equal(liveHit.ended, false);
  assert.equal(liveHit.target.id, 'se-live');
  const archivedHit = resolveAgentMessageTarget({ id: 'se-a', archived: true }, undefined);
  assert.equal(archivedHit.ended, true);
  const tombHit = resolveAgentMessageTarget(undefined, { id: 'se-gone', workspaceId: 'ws-1' });
  assert.equal(tombHit.ended, true);
  assert.equal(tombHit.target.id, 'se-gone');
  const miss = resolveAgentMessageTarget(undefined, undefined);
  assert.equal(miss.target, undefined);
  assert.equal(miss.ended, false);

  const a = toEndedSessionRef({ id: 'x', name: 'X', archived: true }, 10);
  const b = toEndedSessionRef({ id: 'y', lifecycle: 'exited' }, 20);
  let refs = rememberEndedSessionRef([], a);
  refs = rememberEndedSessionRef(refs, b);
  refs = rememberEndedSessionRef(refs, toEndedSessionRef({ id: 'x', name: 'X2' }, 30));
  assert.equal(refs.length, 2);
  assert.equal(findEndedSessionRef(refs, 'x')?.name, 'X2', '同 id 覆盖并挪到最新');
  assert.equal(findEndedSessionRef(refs, 'nope'), undefined);
  const evicted = rememberEndedSessionRef(
    Array.from({ length: 200 }, (_, i) => toEndedSessionRef({ id: `old-${i}` }, i)),
    toEndedSessionRef({ id: 'new' }, 999)
  );
  assert.equal(evicted.length, 200);
  assert.equal(evicted.at(-1).id, 'new');
  assert.equal(findEndedSessionRef(evicted, 'old-0'), undefined, '超限淘汰最老');
  assert.deepEqual(parseEndedSessionRefs('bad'), []);
  assert.equal(parseEndedSessionRefs([{ id: '', name: 'x' }, { id: 'ok', endedAt: 1 }]).length, 1);
}
console.log('ok: ended 判定纯函数 + 墓碑滚动');

// ---------------------------------------------------------------------------
// 8. messageStore：单写者串行追加 + 原子写（盘上真源可解析）
// ---------------------------------------------------------------------------
{
  const entries = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      messageStore.appendAgentMessageToStore(wsRoot, 'ws-1', {
        from: 'se-a',
        to: 'se-b',
        kind: 'notice',
        text: `并发 ${i}`,
        ts: 5_000 + i,
        receipt: 'delivered'
      })
    )
  );
  const ids = new Set(entries.map((e) => e.id));
  assert.equal(ids.size, 8, '并发追加 id 不重复（串行链）');
  const finalLedger = messageStore.readAgentMessageLedger(wsRoot, 'ws-1');
  assert.equal(finalLedger.seq, Number(entries[entries.length - 1].id.slice(2)));
  // replyTo 不存在 → store 侧抛错
  await assert.rejects(
    () =>
      messageStore.appendAgentMessageToStore(wsRoot, 'ws-1', {
        from: 'se-a',
        to: 'se-b',
        text: 'x',
        ts: 1,
        receipt: 'delivered',
        replyTo: 'm-987654'
      }),
    (e) => /m-987654/.test(e.message)
  );
  // 只读查询入口
  const out = messageStore.queryAgentMessageOutboxFromStore(wsRoot, 'ws-1', { actorId: 'se-b' });
  assert.ok(out.total > 0);
  assert.ok(out.messages.every((m) => m.from === 'se-b' || m.to === 'se-b'));
}
console.log('ok: messageStore 串行追加/原子写/查询');

// Parent and scheduler questions share the durable mailbox and reply anchors.
{
  messageStore.setAgentMessagesUserDataDir(path.join(tmp, 'parent-scheduler-mail'));
  const { runAsSchedulerTool } = await import(pathToFileURL(compile('main/agent/agentScope.ts')).href);
  workerB.parentSessionId = workerA.id;
  const ctx = mockCtx();
  const archived = [];
  ctx.sessions.setArchived = (id, value) => archived.push({ id, value });
  const own = sessionsHost['sessions.setArchived'](ctx, { sessionIds: [workerB.id], archived: true, [ACTOR_SESSION_ID_ARG]: workerA.id });
  assert.equal(own.count, 1);
  const denied = sessionsHost['sessions.setArchived'](ctx, { sessionIds: [workerA.id], archived: true, [ACTOR_SESSION_ID_ARG]: workerB.id });
  assert.equal(denied.count, 0); assert.match(denied.failed[0].error, /direct child sessions/);
  assert.deepEqual(archived, [{ id: workerB.id, value: true }]);
  workerB.subagentCharacterId = 'pixel';
  const question = await sessionsHost['sessions.message'](ctx, {
    to: 'parent', text: '长问题' + 'x'.repeat(6000), kind: 'ask', [ACTOR_SESSION_ID_ARG]: workerB.id
  });
  assert.ok(messageStore.readAgentMessageLedger(wsRoot, 'ws-1').messages.some(mail => mail.id === question.messageId && mail.from === workerB.id && mail.to === workerA.id));
  delete workerB.subagentCharacterId;
  const storedSender = messageStore.readAgentMessageLedger(wsRoot, 'ws-1').messages.find(mail => mail.id === question.messageId).sourceAgent;
  assert.equal(storedSender.characterId, 'pixel', 'sender avatar survives changes to the live session');
  const answer = await sessionsHost['sessions.message'](ctx, {
    to: workerB.id, text: '按新接口执行', kind: 'answer', replyTo: question.messageId, ...actor
  });
  const ledger = messageStore.readAgentMessageLedger(wsRoot, 'ws-1');
  assert.equal(ledger.messages.find(m => m.id === answer.messageId).to, workerB.id, '答案必须寄给提问的子会话');
  assert.equal(ledger.messages.find(mail => mail.id === answer.messageId).replyTo, question.messageId, 'answer keeps its durable reply anchor');
  await assert.rejects(() => sessionsHost['sessions.message'](ctx, { to: 'parent', text: '顶层不能伪造父', ...actor }), /no parent session/);
  const schedulerQuestion = await sessionsHost['sessions.message'](ctx, { to: 'scheduler', text: '需要裁定', kind: 'ask', ...actor });
  const schedulerAnswer = await runAsSchedulerTool(() => sessionsHost['sessions.message'](ctx, {
    to: workerA.id, text: '继续', kind: 'answer', replyTo: schedulerQuestion.messageId
  }));
  assert.equal(messageStore.readAgentMessageLedger(wsRoot, 'ws-1').messages.find(m => m.id === schedulerAnswer.messageId).from, 'orchestrator:ws-1');
  assert.equal(sent.length, 0, '问题与答复保存后均不直接插话');
}

messageStore.resetMessageStoreChainsForTest();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] sessions-message');
