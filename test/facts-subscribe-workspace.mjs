import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const root=process.cwd(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'events-mailbox-'));
const compile=createSharedCompiler(root,tmp),load=p=>import(pathToFileURL(compile(p)).href);
try{
 const {awarenessHost}=await load('main/capabilities/hosts/awareness.ts');
 const {dispatchRuntimeFacts}=await load('main/awareness/dispatch.ts');
 const {RuntimeAwarenessStore}=await load('main/awareness/store.ts');
 const {setAgentMessagesUserDataDir,readAgentMessageLedger,readAgentMessageBody}=await load('main/metaAgent/messageStore.ts');
 setAgentMessagesUserDataDir(path.join(tmp,'user'));
 const workers=[{id:'a',name:'A',workspaceId:'w',lifecycle:'working',type:'terminal'},{id:'b',name:'B',workspaceId:'w',lifecycle:'working',type:'terminal'},{id:'c',name:'C',workspaceId:'other',lifecycle:'working',type:'terminal'}];
 const awareness=new RuntimeAwarenessStore(path.join(tmp,'awareness'));
 const ctx={awareness,sessions:{list:()=>workers,get:id=>workers.find(s=>s.id===id),broadcastMessagesChanged(){},isChatRuntime:()=>true},agentSessions:{isBusy:()=>true},workspaces:{list:()=>[{id:'w',path:tmp},{id:'other',path:tmp}]},resolveBubbleWorkspaceId:()=> 'other'};
 const sub=awarenessHost['events.subscribe'](ctx,{__actorSessionId:'a',kinds:['session.phase']});
 assert.equal(sub.subscription.query.workspaceId,'w');
 awarenessHost['events.subscribe'](ctx,{__actorSessionId:'a',kinds:['session.phase'],q:'needs_you'});
 const emit=(id,workspaceId='w',kind='session.phase',sessionId='b')=>({id,kind,sessionId,workspaceId,ts:Date.now(),summary:'phase=needs_you',data:{value:'needs_you'},source:'event'});
 const dispatch=f=>dispatchRuntimeFacts(ctx,f,{debounceMs:0,hourlyLimit:1000});
 const event=emit('one');assert.equal((await dispatch([event])).delivered,1);
 let rows=readAgentMessageLedger(tmp,'w').messages;assert.equal(rows.length,1);assert.equal(rows[0].to,'a');assert.equal(rows[0].read,false);
 const body=JSON.parse(readAgentMessageBody(tmp,'w',rows[0]));assert.equal(body.sourceEventId,'one');assert.equal(body.eventType,'session.phase');
 await dispatch([event]);assert.equal(readAgentMessageLedger(tmp,'w').messages.length,1,'retry never duplicates event mail');
 assert.equal((await dispatch([emit('wrong','other')])).delivered,0);
 // 事件面收敛（防回声窗 noticeScope 已废除）：activity/lifecycle 常规翻转对订阅方一律不投递
 awarenessHost['events.subscribe'](ctx,{__actorSessionId:'a',kinds:['session.lifecycle']});
 assert.equal((await dispatch([emit('notice-work','w','session.lifecycle')])).delivered,0,'lifecycle flips are off the subscription surface');
 const idle=emit('notice-end','w','session.lifecycle');idle.data={lifecycle:'idle'};assert.equal((await dispatch([idle])).delivered,0);
 assert.equal((await dispatch([emit('real-next','w','session.lifecycle')])).delivered,0,'business lifecycle stays suppressed too');
 assert.equal((await dispatch([emit('act','w','session.activity')])).delivered,0,'activity flips are off the subscription surface');
 const before=readAgentMessageLedger(tmp,'w').messages.length;
 awarenessHost['events.unsubscribe'](ctx,{__actorSessionId:'a',id:sub.subscription.id});awareness.clearSubscriptions('a');
 await dispatch([emit('after-unsubscribe')]);assert.equal(readAgentMessageLedger(tmp,'w').messages.length,before);
 assert.throws(()=>awarenessHost['events.subscribe'](ctx,{__actorSessionId:'a',kinds:['event.unapproved']}),/未批准/);
 console.log('events-mailbox: OK (actor workspace, overlap dedupe, durable body, retries, event surface narrowed, unsubscribe, approval)');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
