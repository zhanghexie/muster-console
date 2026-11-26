/** Active receive over ordinary tools: budgets, durable cursors and cancellation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after, afterEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mailbox-receive-'));
const compile=createSharedCompiler(root,tmp);
const load=rel=>import(pathToFileURL(compile(rel)).href);
const store=await load('main/metaAgent/messageStore.ts');
const {readMailbox}=await load('main/messages/read.ts');
const {deliverAgentMessage}=await load('main/messages/deliver.ts');
const {attachMailboxWakes}=await load('main/messages/wake.ts');
const {runAsSchedulerTool}=await load('main/agent/agentScope.ts');
let seq=0;
const disposers=[];
afterEach(()=>{for(const off of disposers.splice(0))off();});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
function world(){
  const dir=path.join(tmp,`w${++seq}`);fs.mkdirSync(dir);store.setAgentMessagesUserDataDir(dir);
  const people=new Map(['a','b','c'].map(id=>[id,{id,name:id,runtime:'pi',workspaceId:'ws',createdAt:1,lifecycle:'working'}]));
  const hooks={lifecycle:new Set(),phase:new Set(),removed:new Set(),scheduler:new Set()};
  const hook=key=>fn=>{hooks[key].add(fn);return()=>hooks[key].delete(fn);};
  const replies=new Map();let busy=true;
  const ctx={sessions:{get:id=>people.get(id),peek:id=>people.get(id),isChatRuntime:()=>true,broadcastMessagesChanged(){},
    onLifecycle:hook('lifecycle'),onPhaseFlip:hook('phase'),onSessionRemoved:hook('removed')},
    workspaces:{list:()=>[{id:'ws',path:dir},{id:'other',path:dir}]},resolveBubbleWorkspaceId:()=> 'ws',
    agentSessions:{isOpen:()=>true,isBusy:id=>id==='b'||busy,observe:id=>({busy,retry:null,updatedAt:1,lastReply:replies.get(id)??null})},
    orchestrator:{isBusy:()=>busy,onEvent:hook('scheduler'),observe:()=>({busy,createdAt:1,updatedAt:1,lastReply:replies.get('scheduler')??null})}};
  disposers.push(attachMailboxWakes(ctx));
  const actor=id=>({id,hostView:false,workspaceId:'ws'});
  const read=(args={},signal,id='b')=>readMailbox(ctx,args,actor(id),signal);
  const send=(text,extra={})=>deliverAgentMessage(ctx,{from:'a',to:'b',text,workspaceId:'ws',...extra});
  const ledger=(ws='ws')=>store.readAgentMessageLedger(dir,ws);
  const finish=(id,status='completed')=>{busy=false;const s=people.get(id);if(s)s.lifecycle='idle';
    replies.set(id,{messageId:`reply-${id}`,status,finishedAt:Date.now(),text:'final',createdAt:1,totalChars:5,truncated:false});
    for(const fn of hooks.lifecycle)fn(s,'working','idle');};
  return {ctx,dir,people,hooks,replies,read,send,ledger,finish,busy:value=>busy=value};
}

test('existing mail returns immediately; bulk reads only returned recipient bodies within total budget',async()=>{
  const w=world();await w.send('first');await w.send('second');await w.send('third');
  const start=Date.now();const r=await w.read({includeBody:true,unreadOnly:true,limit:2,maxChars:4000});
  assert.ok(Date.now()-start<1000);assert.equal(r.reason,'mail');assert.deepEqual(r.messages.map(m=>m.text),['first','second']);
  assert.match(r.note, /host\.sessions\.observe/);
  assert.ok(JSON.stringify(r).length<=4000);assert.deepEqual(w.ledger().messages.map(m=>m.read),[true,true,false]);
  const next=await w.read({includeBody:true,cursor:r.nextCursor});assert.deepEqual(next.messages.map(m=>m.text),['third']);
  assert.equal(w.ledger().messages[2].read,true);
});

test('unread counts reflect newly opened bodies; cursor continuation can include earlier read mail',async()=>{
  const w=world();
  for(let i=0;i<36;i++) await w.send(`letter ${i}`);
  const oldRead=w.ledger().messages.slice(8,16).map(m=>m.id);
  await store.markAgentMessagesReadInStore(w.dir,'ws',oldRead);
  const preview=await w.read({includeBody:false});assert.equal(preview.unread,28);
  const first=await w.read({limit:8,maxChars:10000});
  assert.equal(first.messages.length,8);assert.equal(first.unread,20);
  const continued=await w.read({cursor:first.nextCursor,limit:8,maxChars:10000});
  assert.deepEqual(continued.messages.map(m=>m.id),oldRead);
  assert.equal(continued.unread,20,'opening earlier read bodies cannot decrement unread again');
  const next=await w.read({unreadOnly:true,limit:3});assert.equal(next.messages.length,3);assert.equal(next.unread,17);
  assert.equal(w.ledger().messages.filter(m=>!m.read).length,17,'response agrees with persisted read receipts');
});

test('JSON character budget and partial-body cursor preserve an escaped long report and unread overflow',async()=>{
  const w=world(),body=('长报告\n\t"\\😀'.repeat(1600))+'end';
  await w.send(body,{subject:'S'.repeat(200)});await w.send('keep unread');
  let cursor='start',text='',pages=0;
  do{
    const r=await w.read({includeBody:true,cursor,maxChars:4000,limit:1});
    assert.ok(JSON.stringify(r).length<=4000);assert.equal(r.messages.length,1);
    const m=r.messages[0];text+=m.text;pages++;cursor=r.nextCursor;
    assert.equal(w.ledger().messages[1].read,false,'excluded body never gets marked read');
    if(m.nextOffset===null)break;
    assert.ok(m.nextOffset>m.offset);assert.equal(w.ledger().messages[0].read,true,'opened is not fully processed');
  }while(pages<100);
  assert.equal(text,body);assert.ok(pages>1);
  const next=await w.read({includeBody:true,cursor});assert.equal(next.messages[0].text,'keep unread');
});

test('old cursors replay read bodies after lost response; next cursor survives store reinitialization and new arrivals',async()=>{
  const w=world();await w.send('one',{idempotencyKey:'one'});await w.send('two');
  const first=await w.read({includeBody:true,cursor:'start',limit:1});
  assert.match(first.note,/保存 nextCursor 续收，复用 cursor 可重放/);
  const replay=await w.read({includeBody:true,cursor:first.cursor,unreadOnly:true,limit:1});
  assert.equal(replay.messages[0].id,first.messages[0].id);assert.equal(replay.messages[0].text,'one');
  store.resetMessageStoreChainsForTest();store.setAgentMessagesUserDataDir(w.dir);
  await w.send('one',{idempotencyKey:'one'});assert.equal(w.ledger().messages.length,2);
  await w.send('three');
  const next=await w.read({includeBody:true,cursor:first.nextCursor});assert.deepEqual(next.messages.map(m=>m.text),['two','three']);
  await assert.rejects(()=>w.read({includeBody:true,cursor:first.nextCursor},undefined,'c'),/游标无效/);
  await assert.rejects(()=>w.read({includeBody:true,box:'sent',cursor:first.nextCursor}),/游标无效/);
});

test('stable ordering preserves sequence prefixes across workspaces and backwards timestamps',async()=>{
  const w=world();
  for(const [ws,ts,text] of [['ws',100,'a'],['ws',1,'b'],['other',50,'c']])
    await store.appendAgentMessageToStore(w.dir,ws,{from:'a',to:'b',text,ts,receipt:'stored'});
  let cursor='start';const seen=[];
  for(let i=0;i<3;i++){const r=await w.read({includeBody:true,cursor,limit:1});seen.push(r.messages[0].text);cursor=r.nextCursor;}
  assert.deepEqual(seen,['c','a','b']);assert.equal(new Set(seen).size,3);
});

test('ignores legacy journal files and preserves corrupt SQLite data', async () => {
  const w = world();
  const legacy = store.legacyAgentMessagesFilePath(w.dir);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const legacyText = JSON.stringify({ schemaVersion: 1, seq: 90, messages: [{ id: 'm-90', text: 'old' }] });
  fs.writeFileSync(legacy, legacyText);
  assert.equal(w.ledger().messages.length, 0);
  await w.send('first SQLite message');
  assert.equal((await w.read({ includeBody: true })).messages[0].text, 'first SQLite message');
  assert.equal(fs.readFileSync(legacy, 'utf8'), legacyText);

  const file = store.agentMessagesFilePath('ws');
  const corrupt = Buffer.from('invalid SQLite file');
  fs.writeFileSync(file, corrupt);
  await assert.rejects(() => w.send('no overwrite'), /SQLite mailbox header is invalid/);
  assert.deepEqual(fs.readFileSync(file), corrupt);
});

test('cancellation before the queued receipt write prevents marking a planned body read',async()=>{
  const w=world();const mail=await w.send('not yet returned');
  for(const args of [{includeBody:true},{messageId:mail.messageId}]){
    const controller=new AbortController();const planned=w.read(args,controller.signal);controller.abort();
    await assert.rejects(()=>planned,/取消/);assert.equal(w.ledger().messages[0].read,false);
  }
});

test('tiny budget fails before marking read; preview/sender reads leave receipt untouched',async()=>{
  const w=world();await w.send('budget');
  await assert.rejects(()=>w.read({includeBody:true,maxChars:20}),/预算/);assert.equal(w.ledger().messages[0].read,false);
  const preview=await w.read({includeBody:false});assert.equal(preview.messages[0].text,undefined);assert.equal(w.ledger().messages[0].read,false);
  const sender=await w.read({box:'sent',includeBody:true},undefined,'a');assert.equal(sender.messages[0].text,'budget');
  assert.equal(w.ledger().messages[0].read,false);
});

// The issue #4 real 30.5-second wait migrated to the waitFor fake-clock matrix.
test('removed wait arguments fail with the waitFor migration guidance', async()=>{
  const w=world();
  await assert.rejects(()=>w.read({waitMs:0}),/waitMs is removed: waiting moved to host\.waitFor/);
  await assert.rejects(()=>w.read({watchSessionIds:['a']}),/watchSessionIds is removed: waiting moved to host\.waitFor/);
  await w.send('still readable');
  assert.equal((await w.read()).messages[0].text,'still readable');
});

test('scheduler reads its own mailbox',async()=>{
  const w=world();await w.send('scheduler mail',{to:'scheduler'});
  const own=await runAsSchedulerTool(()=>readMailbox(w.ctx,{includeBody:true},{id:'host',hostView:true,workspaceId:'ws'}));
  assert.equal(own.messages[0].text,'scheduler mail');
});
