/** Durable mail, recipient receipts, batched idle host wake; no external model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after, afterEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-'));
const compile = createSharedCompiler(root, tmp);
const load = rel => import(pathToFileURL(compile(rel)).href);
const store = await load('main/metaAgent/messageStore.ts');
const { deliverAgentMessage } = await load('main/messages/deliver.ts');
const { readMailbox } = await load('main/messages/read.ts');
const { MailboxWakes, attachMailboxWakes, flushMailboxWake } = await load('main/messages/wake.ts');
const { sendMailboxWake } = await load('main/messages/transport.ts');
const { runAsSchedulerTool, runAsAgentSession, isSchedulerInvocation, currentAgentSessionId } = await load('main/agent/agentScope.ts');
const disposers=[];
afterEach(()=>{for(const off of disposers.splice(0))off();});
let seq = 0;
function world() {
  const dir = path.join(tmp, `world-${++seq}`); fs.mkdirSync(dir);
  store.setAgentMessagesUserDataDir(dir);
  const people = new Map(['a','b','c'].map(id => [id, { id, name: id, runtime: 'pi', workspaceId: 'ws', lifecycle: 'idle' }]));
  const wakes = [], listeners = [], schedulerEvents = [];
  let busy = true, accepted = true;
  const ctx = {
    sessions: { get: id => people.get(id), peek: id => people.get(id), peekEnded: id => id === 'deleted' ? { id, workspaceId: 'ws' } : undefined,
      broadcastMessagesChanged() {}, isChatRuntime: () => true,
      onLifecycle(fn) { listeners.push(fn); return () => {}; } },
    workspaces: { list: () => [{id:'ws', path:dir}, {id:'other',path:dir}], activePath: () => dir },
    resolveBubbleWorkspaceId: () => 'ws',
    agentSessions: { isOpen: () => true, isBusy: () => busy,
      send: async (...args) => { if (!accepted) return {ok:false,error:'offline'}; wakes.push(args); return {ok:true}; } },
    orchestrator: { isBusy: () => busy, onEvent(fn) { schedulerEvents.push(fn); return () => {}; },
      async send(text, ws, images, opts) { if(opts.beforeStart?.()) { wakes.push([ws,text,opts]); opts.onAccepted?.(); } } }
  };
  disposers.push(attachMailboxWakes(ctx));
  const actor = (id, hostView=false) => ({id,hostView,workspaceId:'ws'});
  const send = (text, extra={}) => deliverAgentMessage(ctx,{from:'a',to:'b',text,workspaceId:'ws',...extra});
  const read = (args={}, id='b', host=false) => readMailbox(ctx,args,actor(id,host));
  const ledger = () => store.readAgentMessageLedger(dir,'ws');
  return {ctx,dir,people,wakes,listeners,schedulerEvents,send,read,ledger,
    busy: value => busy=value, accept: value => accepted=value};
}

test('real child result mail commits before one idempotent semantic result fact', async () => {
  const w = world(); w.people.get('a').parentSessionId = 'b';
  const first = await w.send('child result body stays in the mailbox', { kind: 'handoff', idempotencyKey: 'child-result' });
  const retried = await w.send('child result body stays in the mailbox', { kind: 'handoff', idempotencyKey: 'child-result' });
  assert.equal(first.messageId, retried.messageId);
  const files = fs.readdirSync(path.join(w.dir, 'sessions')).filter(name => name.endsWith('.ndjson'));
  const events = files.flatMap(name => fs.readFileSync(path.join(w.dir, 'sessions', name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  const results = events.filter(event => event.type === 'semantic.subagent.result.committed');
  assert.equal(results.length, 1);
  assert.equal(results[0].correlationId, first.messageId);
  assert.equal(results[0].payload.result.mailId, first.messageId);
  assert.equal(results[0].payload.result.from, 'a');
  assert.equal(JSON.stringify(results).includes('child result body stays'), false, 'semantic facts do not duplicate private mail bodies');
  assert.equal(w.ledger().messages.length, 1);
});

test('scheduler eligibility cannot acknowledge a failed append, and admission does not await model completion', async () => {
  const w = world(); w.busy(false);
  w.ctx.orchestrator.send = async (_text, _ws, _images, opts) => { assert.equal(opts.beforeStart(), true); throw new Error('durable append failed'); };
  await assert.rejects(sendMailboxWake(w.ctx, 'orchestrator:ws', 'ws', 'notice', 'failed-append', () => true), /durable append failed/);
  let release;
  w.ctx.orchestrator.send = async (_text, _ws, _images, opts) => { assert.equal(opts.beforeStart(), true); opts.onAccepted(); return new Promise(resolve => { release = resolve; }); };
  assert.equal(await sendMailboxWake(w.ctx, 'orchestrator:ws', 'ws', 'notice', 'accepted-turn', () => true), true);
  assert.equal(typeof release, 'function', 'receipt settled while the actual model turn remains pending'); release();
});

test('full long mail survives a full input queue; explicit body paging and recipient-only read receipt', async () => {
  const w=world(); const body=('完整报告\n"\\\t'.repeat(1200))+'尾部证据';
  const results=await Promise.all(Array.from({length:12},(_,i)=>w.send(i===11?body:`进度${i}`)));
  assert.equal(results.length,12); assert.ok(results.every(r=>r.receipt==='stored'&&!r.read));
  assert.equal(w.wakes.length,0,'running models receive no queued or steered mail');
  const last=results.at(-1), header=w.ledger().messages.at(-1);
  assert.ok(header.text.length<=240); assert.equal(header.bodyChars,body.length);
  const list=await w.read({includeBody:false}); assert.equal(list.total,12); assert.equal(list.unread,12);
  assert.ok(list.messages.every(m=>m.read===false&&m.text===undefined));
  await w.read({messageId:last.messageId},'a'); await w.read({messageId:last.messageId},'host',true);
  assert.equal(w.ledger().messages.at(-1).read,false);
  let text='',offset=0;
  do { const page=await w.read({messageId:last.messageId,bodyOffset:offset,length:1300});
    assert.ok(JSON.stringify(page).length<7000); text+=page.text; offset=page.nextOffset;
  } while(offset!==null);
  assert.equal(text,body); assert.ok(w.ledger().messages.at(-1).readAt>0);
  const sent=await w.read({box:'sent'},'a'); assert.equal(sent.messages.find(m=>m.id===last.messageId).read,true);
  await assert.rejects(()=>w.read({messageId:last.messageId},'c'),/不属于/);
});

test('default read returns unread bodies and explicit preview never consumes',async()=>{
  const w=world();await w.send('正文默认可读');
  const preview=await w.read({includeBody:false});assert.equal(preview.messages[0].text,undefined);assert.equal(w.ledger().messages[0].read,false);
  const first=await w.read();assert.equal(first.messages[0].text,'正文默认可读');assert.equal(w.ledger().messages[0].read,true);
  const next=await w.read();assert.equal(next.messages.length,0);
});

test('idempotent retry persists one immutable letter; conflicting retry is explicit', async()=>{
  const w=world(); const a=await w.send('结果',{idempotencyKey:'result-1'});
  const b=await w.send('结果',{idempotencyKey:'result-1'});
  assert.equal(a.messageId,b.messageId);assert.equal(w.ledger().messages.length,1);
  await assert.rejects(()=>w.send('changed',{idempotencyKey:'result-1'}),/不同内容/);
  assert.equal(w.ledger().messages[0].text,'结果');
});

test('busy defers wake, idle batches once, unread ignored notification is not repeated after stop or reattach',async()=>{
  const w=world(), n=new MailboxWakes(w.ctx);
  for(let i=0;i<12;i++)await w.send(`进度${i}`);
  await n.flush('b','ws'); assert.equal(w.wakes.length,0);
  w.busy(false);await n.flush('b','ws');
  assert.equal(w.wakes.length,1);assert.match(w.wakes[0][1],/12 封/);
  assert.equal(w.wakes[0][3].host,true);assert.equal(w.wakes[0][3].requireIdle,true);
  assert.doesNotMatch(w.wakes[0][1],/进度/);assert.ok(w.ledger().messages.every(m=>m.notifiedAt&&!m.read));
  await n.flush('b','ws');n.dispose();
  const reattached=new MailboxWakes(w.ctx);await reattached.flush('b','ws');assert.equal(w.wakes.length,1);
  await w.send('新一封');await reattached.flush('b','ws');assert.equal(w.wakes.length,2);reattached.dispose();
});

test('read while busy cancels stale wake; archive/delete retain mail without wake',async()=>{
  const w=world(), n=new MailboxWakes(w.ctx);const first=await w.send('读过的');
  await w.read({messageId:first.messageId});w.busy(false);await n.flush('b','ws');assert.equal(w.wakes.length,0);
  w.people.get('b').archived=true;const saved=await w.send('归档收信');assert.equal(saved.wake,'disabled');
  await n.flush('b','ws');assert.equal(w.wakes.length,0);
  const dead=await w.send('删除仍可留档',{to:'deleted'});assert.equal(dead.receipt,'stored');assert.equal(dead.wake,'disabled');
  await n.flush('deleted','ws');assert.equal(w.wakes.length,0);n.dispose();
});

test('wake failure never loses or falsely reads mail; retry updates the same metadata',async()=>{
  const w=world(),n=new MailboxWakes(w.ctx);w.busy(false);w.accept(false);await w.send('最终报告');
  await n.flush('b','ws');let m=w.ledger().messages[0];assert.match(m.wakeError,/offline/);assert.equal(m.read,false);assert.equal(m.notifiedAt,undefined);
  const pending = (await w.read({ box: 'sent' }, 'a')).messages[0];
  assert.equal(pending.wakeError, 'offline');
  assert.equal('wakeDeferred' in pending, false);
  w.accept(true);await n.flush('b','ws');m=w.ledger().messages[0];assert.ok(m.notifiedAt);assert.equal(m.wakeError,undefined);assert.equal(w.ledger().messages.length,1);n.dispose();
});

test('busy scheduler defers without an error; unread mail retries and read mail exposes only its read receipt', async () => {
  const w = world(), recipient = 'orchestrator:ws';
  const send = (text, idempotencyKey) => w.send(text, { to: 'scheduler', idempotencyKey });
  const flush = () => flushMailboxWake(w.ctx, recipient, 'ws');
  const sent = async args => (await w.read({ box: 'sent', ...args }, 'a')).messages;
  const first = await send('read in the existing turn', 'busy-mail');
  assert.equal(first.wake, 'pending');
  await flush();
  const deferred = { reason: '调度正忙', retryWhileUnread: true };
  const pending = (await sent())[0];
  assert.deepEqual(pending.wakeDeferred, deferred);
  assert.equal('wakeError' in pending, false);
  assert.deepEqual((await sent({ includeBody: true }))[0].wakeDeferred, deferred);
  assert.deepEqual((await w.read({ messageId: first.messageId }, 'a')).wakeDeferred, deferred);
  assert.equal((await send('read in the existing turn', 'busy-mail')).wake, 'deferred');

  const opened = (await w.read({}, recipient)).messages[0];
  const replayed = await w.read({ messageId: first.messageId }, recipient);
  for (const result of [opened, replayed, (await sent())[0], (await send('read in the existing turn', 'busy-mail'))]) {
    assert.equal(result.read, true);
    assert.ok(result.readAt);
    for (const key of ['wake', 'wakeDeferred', 'wakeError', 'wakeUncertain', 'notifiedAt', 'deliveryMethod']) {
      assert.equal(key in result, false, key);
    }
  }
  w.busy(false);
  await flush();
  assert.equal(w.wakes.length, 0, 'reading the mail cancels its pending wake');

  w.busy(true);
  const second = await send('leave this one unread', 'retry-mail');
  await flush();
  assert.deepEqual((await sent()).find(message => message.id === second.messageId).wakeDeferred, deferred);
  w.busy(false);
  for (let attempt = 0; attempt < 250 && !w.ledger().messages.find(message => message.id === second.messageId).notifiedAt; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(w.wakes.length, 1, 'timer retry wakes the scheduler without a lifecycle event');
  const notified = (await sent()).find(message => message.id === second.messageId);
  assert.equal(notified.read, false);
  assert.ok(notified.notifiedAt);
  assert.equal('wakeDeferred' in notified, false);
  assert.equal('wakeError' in notified, false);
  const readAfterWake = await w.read({ messageId: second.messageId }, recipient);
  assert.equal(readAfterWake.read, true);
  assert.equal('notifiedAt' in readAfterWake, false);
});

test('a scheduler admission exception remains visible only until the recipient reads the mail', async () => {
  const w = world();
  w.busy(false);
  w.ctx.orchestrator.send = async (_text, _ws, _images, options) => options.onSkipped(new Error('durable append failed'));
  const saved = await w.send('real error', { to: 'scheduler' });
  await flushMailboxWake(w.ctx, 'orchestrator:ws', 'ws');
  const [pending] = (await w.read({ box: 'sent' }, 'a')).messages;
  assert.equal(pending.wakeError, 'durable append failed');
  assert.equal('wakeDeferred' in pending, false);
  const opened = await w.read({ messageId: saved.messageId }, 'orchestrator:ws');
  assert.equal(opened.read, true);
  assert.equal('wakeError' in opened, false);
});

test('legacy deferrals are shown as retryable and old read mail hides delivery errors', async () => {
  const w = world();
  const old = await w.send('legacy deferral', { to: 'scheduler' });
  const failure = await w.send('legacy exception', { to: 'scheduler' });
  await store.updateAgentMessageWakeInStore(w.dir, 'ws', [old.messageId], { error: '当前接入尚未就绪或未确认空闲，等待状态变化' });
  await store.updateAgentMessageWakeInStore(w.dir, 'ws', [failure.messageId], { error: 'old failure', uncertain: true });
  await store.markAgentMessagesReadInStore(w.dir, 'ws', [failure.messageId]);
  store.resetMessageStoreChainsForTest();
  const messages = (await w.read({ box: 'sent' }, 'a')).messages;
  const pending = messages.find(m => m.id === old.messageId);
  assert.equal(pending.wakeDeferred.retryWhileUnread, true);
  assert.equal('wakeError' in pending, false);
  const opened = messages.find(m => m.id === failure.messageId);
  assert.equal(opened.read, true);
  assert.equal('wakeError' in opened, false);
  assert.equal('wakeUncertain' in opened, false);
});

test('deferred gate admission rechecks actual unread mail; arrival during admission is a later batch',async()=>{
  const w=world();let admit,resolve;
  const n=new MailboxWakes(w.ctx,async(_ctx,_id,_ws,_text,_mid,needed)=>new Promise(r=>{admit=needed;resolve=r;}));
  const mail=await w.send('old');const pending=n.flush('b','ws');for(let i=0;i<100&&!admit;i++)await new Promise(r=>setTimeout(r,2));assert.equal(typeof admit,'function','durable admission reaches the sender within its bounded wait');
  await w.read({messageId:mail.messageId});assert.equal(admit(),false);resolve(false);await pending;
  assert.equal(w.ledger().messages[0].notifiedAt,undefined);n.dispose();
});

test('scheduler alias owns a workspace mailbox, not host-wide private mail access',async()=>{
  const w=world(); const mail=await w.send('调度问题',{to:'scheduler'});
  assert.equal(mail.target,'orchestrator:ws');
  await w.send('other scheduler',{to:'orchestrator:other'});
  // Trusted scope, just as the capability executor does for scheduler invocations.
  const result=await runAsSchedulerTool(()=>w.read({includeBody:false},'host',true));
  assert.equal(result.total,1);assert.equal(result.messages[0].to,'orchestrator:ws');
});

test('host wake does not inherit a scheduler or worker sender tool identity',async()=>{
  const w=world();await w.send('letter');
  const n=new MailboxWakes(w.ctx,async()=>{
    assert.equal(isSchedulerInvocation(),false);assert.equal(currentAgentSessionId(),undefined);return true;
  });
  await runAsSchedulerTool(()=>runAsAgentSession('a',()=>n.flush('b','ws')));
  assert.ok(w.ledger().messages[0].notifiedAt);n.dispose();
});

test('cross-workspace reply anchors and sent receipts use the same mailbox store',async()=>{
  const w=world();w.people.get('b').workspaceId='other';
  const letter=await w.send('跨区问候');assert.equal(letter.mailboxWorkspaceId,'other');
  const inbox=await w.read({includeBody:false});assert.equal(inbox.total,1);
  await w.read({messageId:letter.messageId});
  const reply=await deliverAgentMessage(w.ctx,{from:'b',to:'a',text:'答复',kind:'answer',replyToHandle:letter.messageId,workspaceId:'other'});
  assert.equal(reply.mailboxWorkspaceId,'ws');assert.equal((await w.read({box:'sent'},'a')).messages[0].read,true);
});

test('closed destination workspace retains mail without borrowing active workspace storage or waking',async()=>{
  const w=world();w.people.get('b').workspaceId='closed';
  const legacy=path.join(w.dir,'.muster');fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy,'messages.json'),JSON.stringify({messages:[{id:'m-1',from:'private',to:'other',kind:'notice',text:'active workspace private',ts:1,receipt:'delivered'}]}));
  const mail=await w.send('for closed workspace');assert.equal(mail.wake,'disabled');
  assert.equal(store.readAgentMessageLedger('', 'closed').messages.length, 1);
  assert.equal(fs.existsSync(path.join(legacy,'messages.json')),true,'pre-release clean-break does not read or delete legacy mailbox files');
});

test('more than 200 mails are retained; corrupt indexes fail closed; bodies remain readable',async()=>{
  const w=world();
  for(let i=0;i<205;i++)await store.appendAgentMessageToStore(w.dir,'ws',{from:'a',to:'b',text:`mail${i}`,ts:i,receipt:'stored'});
  assert.equal(w.ledger().messages.length,205);assert.equal(w.ledger().messages[0].text,'mail0');
  const file=store.agentMessagesFilePath('ws');fs.writeFileSync(file,'{broken');
  await assert.rejects(()=>w.send('must not overwrite'),/索引读取失败/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});

test('common runtime transport resumes stopped CLI without selecting, blocked/starting never receives Enter',async()=>{
  const w=world();const target=w.people.get('b');target.lifecycle='exited';let running=false,respawns=0,selects=0,writes=[];
  w.ctx.sessions.isChatRuntime=()=>false;w.ctx.pty={isRunning:()=>running,captureWriter:()=>({write:(_id,s)=>{writes.push(s);return true;}})};
  w.ctx.sessions.respawn=async()=>{respawns++;running=true;target.lifecycle='idle';};
  w.ctx.sessions.getCliWorkspaceContext=()=>undefined;w.ctx.sessions.injectStrategy=async()=>undefined;w.ctx.sessions.pasteInput=async()=>false;
  w.ctx.sessions.select=()=>selects++;w.ctx.config={get:()=>({})};
  assert.equal(await sendMailboxWake(w.ctx,'b','ws','【宿主收信提醒】有新信','wake',()=>true),true);
  assert.equal(respawns,1);assert.equal(selects,0);assert.deepEqual(writes,['【宿主收信提醒】有新信','\r']);
  for(const lifecycle of ['blocked','starting','working']){target.lifecycle=lifecycle;assert.equal(await sendMailboxWake(w.ctx,'b','ws','new','id',()=>true),false);}
  assert.equal(writes.length,2);
});

test('lifecycle wiring wakes idle sessions but never manufactures child completion/result letters',async()=>{
  const w=world();w.busy(false);const off=attachMailboxWakes(w.ctx);
  w.listeners[0](w.people.get('b'),'working','idle');
  await new Promise(r=>setTimeout(r,150));assert.equal(w.wakes.length,0);assert.equal(w.ledger().messages.length,0);off();
});

test('legacy letters backfill identity once and stay stable after sender rename or removal',async()=>{
  const w=world();
  w.people.get('a').name='老王'; w.people.get('a').subagentCharacterId='pixel';
  await store.appendAgentMessageToStore(w.dir,'ws',{from:'a',to:'b',text:'旧信无快照',ts:1,receipt:'stored'});
  assert.equal(w.ledger().messages[0].sourceAgent,undefined);
  const first=await w.read({messageId:w.ledger().messages[0].id});
  assert.deepEqual(first.sourceAgent,{sessionId:'a',name:'老王',characterId:'pixel'});
  assert.equal(w.ledger().messages[0].sourceAgent.name,'老王','F-05：回填身份一次性固化落盘');
  w.people.get('a').name='新名';
  const second=await w.read({messageId:first.id});
  assert.equal(second.sourceAgent.name,'老王','F-05：发送者改名后旧信身份不变');
  w.people.delete('a');
  const third=await w.read({messageId:first.id});
  assert.deepEqual(third.sourceAgent,{sessionId:'a',name:'老王',characterId:'pixel'},'F-05：发送者删除后仍读固化快照，不回落会话现状');
});

test('receive path persists legacy backfill too; snapshotted letters are never rewritten',async()=>{
  const w=world();
  w.people.get('a').name='老王';
  await store.appendAgentMessageToStore(w.dir,'ws',{from:'a',to:'b',text:'旧信二',ts:1,receipt:'stored'});
  const batch=await w.read({includeBody:true});
  assert.equal(batch.messages[0].sourceAgent.name,'老王');
  assert.equal(w.ledger().messages[0].sourceAgent.name,'老王','F-05：批量收信同样固化回填');
  const fresh=await w.send('新信带快照');
  assert.equal(w.ledger().messages.find(m=>m.id===fresh.messageId).sourceAgent.name,'老王','发送时快照当前身份');
  w.people.get('a').name='再改名';
  const reread=await w.read({messageId:fresh.messageId});
  assert.equal(reread.sourceAgent.name,'老王','已带快照的信不随改名漂移，也不被回填改写');
  assert.equal(w.ledger().messages.find(m=>m.id===fresh.messageId).sourceAgent.name,'老王');
});

test('sourceAgent backfill persistence fails closed on a broken index without corrupting it',async()=>{
  const w=world();
  await store.appendAgentMessageToStore(w.dir,'ws',{from:'a',to:'b',text:'x',ts:1,receipt:'stored'});
  const file=store.agentMessagesFilePath('ws');
  fs.writeFileSync(file,'{broken');
  await assert.rejects(()=>store.persistAgentMessageSourceAgentInStore(w.dir,'ws','m-1',{sessionId:'a',name:'a'}),/索引读取失败/);
  assert.equal(fs.readFileSync(file,'utf8'),'{broken','固化失败不破坏原文件（读取侧回落现行为）');
});

test('scheduler mailbox wakes through needs_you and waits for a pending question',async()=>{
  const still=()=>true;
  const mkCtx=over=>{
    const sends=[];
    const ctx={
      sessions:{get:()=>undefined,peek:()=>undefined,broadcastMessagesChanged(){},isChatRuntime:()=>false},
      workspaces:{list:()=>[{id:'ws',path:tmp}]},
      orchestrator:{isBusy:()=>false,async send(_text,_ws,_img,opts){sends.push(opts);const admitted=opts?.beforeStart?.();if(admitted)opts.onAccepted?.();return admitted;}},
      ...over
    };
    return {ctx,sends};
  };
  // 两本账都空 → 正常进入 orchestrator.send（beforeStart 放行）
  {
    const {ctx,sends}=mkCtx({});
    assert.equal(await sendMailboxWake(ctx,'orchestrator:ws','ws','提醒','m-1',still),true,'无人等待时照常派发并接受');
    assert.equal(sends.length,1);
  }
  // C2：askQuestion 卡挂起（无 C1）→ decline（false），不进 send
  {
    const {ctx,sends}=mkCtx({orchestrator:{isBusy:()=>false,getHumanWait:() => ({workspaceId:'ws',reason:'askQuestion',questionId:'q1',since:1}),async send(_t,_w,_i,opts){sends.push('sent');const admitted=opts?.beforeStart?.();if(admitted)opts.onAccepted?.();return admitted;}}});
    assert.equal(await sendMailboxWake(ctx,'orchestrator:ws','ws','提醒','m-2',still),false,'C2 ask 卡挂起时唤醒被拒');
    assert.equal(sends.length,0,'不拉起自治回合');
  }
  // 调度相位为 needs_you 时仍请求唤醒。
  {
    const {ctx,sends}=mkCtx({schedulerStatus:{get:()=>({workspaceId:'ws',phase:'needs_you',ts:1})}});
    assert.equal(await sendMailboxWake(ctx,'orchestrator:ws','ws','提醒','m-3',still),true);
    assert.equal(sends.length,1);
    assert.equal(sends[0].schedulerWake,true);
  }
  // C1 非 needs_you → 照常派发
  {
    const {ctx,sends}=mkCtx({schedulerStatus:{get:()=>({workspaceId:'ws',phase:'idle',ts:1})}});
    assert.equal(await sendMailboxWake(ctx,'orchestrator:ws','ws','提醒','m-4',still),true,'调度未等人时照常派发并接受');
    assert.equal(sends.length,1);
  }
});

after(async()=>{store.resetMessageStoreChainsForTest();await new Promise(resolve=>setTimeout(resolve,250));fs.rmSync(tmp,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
