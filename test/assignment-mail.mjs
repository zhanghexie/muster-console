/** Application task/review consumers retain workspace scope and durable-mail semantics. */
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const root=process.cwd(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'assignment-mail-'));
let resetMessageStore;
try {
 const compile=createSharedCompiler(root,tmp),load=p=>import(pathToFileURL(compile(p)).href);
 const {sendSessionMail}=await load('main/messages/assignment.ts');
 const {setAgentMessagesUserDataDir,readAgentMessageLedger,readAgentMessageBody,resetMessageStoreChainsForTest}=await load('main/metaAgent/messageStore.ts');
 resetMessageStore=resetMessageStoreChainsForTest;
 setAgentMessagesUserDataDir(path.join(tmp,'userdata'));
 const management=path.join(tmp,'management'),source=path.join(tmp,'source');fs.mkdirSync(management);fs.mkdirSync(source);
 const session={id:'s',name:'Worker',workspaceId:'w',runtime:'pi',type:'terminal',lifecycle:'working',cwd:source};
 let directSends=0;
 const ctx={resolveBubbleWorkspaceId:()=> 'other',sessions:{get:id=>id==='s'?session:undefined,list:()=>[session],isChatRuntime:()=>true,broadcastMessagesChanged(){}},
  agentSessions:{isBusy:()=>true,send:async()=>{directSends++;return {ok:true};}},
  workspaces:{list:()=>[{id:'w',path:source,controlRoot:management}]}};
 const input={sessionId:'s',text:'补充任务与审阅意见',from:'human',idempotencyKey:'review-one'};
 const saved=await sendSessionMail(ctx,input);assert.equal(saved.stored,true);assert.equal(saved.receipt,'stored');
 await sendSessionMail(ctx,input);
 const rows=readAgentMessageLedger(management,'w').messages;
 assert.equal(rows.length,1,'重复寄信只保存一次');assert.equal(rows[0].from,'human');assert.equal(rows[0].to,'s');assert.equal(rows[0].read,false);
 assert.equal(readAgentMessageBody(management,'w',rows[0]),input.text);assert.equal(directSends,0,'忙时只存信，不直接注入或排业务正文');
 session.workspaceId='missing';await assert.rejects(sendSessionMail(ctx,{sessionId:'s',text:'must not deliver'}),/workspace not found/);
 assert.equal(readAgentMessageLedger(management,'w').messages.length,1,'失效工作区先拒绝，无保存副作用');
 console.log('assignment-mail: OK (workspace scope, busy preservation, stored receipts, idempotency, invalid target fails before save)');
}finally{resetMessageStore?.();fs.rmSync(tmp,{recursive:true,force:true});}
