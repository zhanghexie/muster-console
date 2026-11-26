import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const temp=fs.mkdtempSync(path.resolve('.tmp/knowledge-history-'));
try{
 const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
 const {knowledgeHistorySources,readKnowledgeHistory}=await import(pathToFileURL(compile('main/memory/knowledgeHistory.ts')));
 const {knowledgeTopicGroups}=await import(pathToFileURL(compile('shared/knowledgeTopics.ts')));
 let read=0;
 const ctx={config:{get:()=>({workspaces:[{id:'a'},{id:'b'}]})},sessions:{list:()=>[{id:'old',name:'旧会话',workspaceId:'a',runtime:'pi'},{id:'foreign',name:'其他区',workspaceId:'b',runtime:'pi'}],isChatRuntime:r=>r==='pi'},agentSessions:{entries:new Map(),store:{load:()=>{read++;return [{id:'turn1',role:'user',ts:1,parts:[{kind:'text',text:'第二版：回退方案'}]},{id:'turn2',role:'assistant',ts:2,aborted:true,parts:[{kind:'text',text:'实现完成但被中止'}]}];}}}};
 ctx.agentSessions.getHistoryRange=(_sessionId,before,limit)=>{
   const messages=ctx.agentSessions.store.load();
   const end=before??messages.length,start=Math.max(0,end-limit);
   return {messages:messages.slice(start,end),before:start,total:messages.length,hasEarlier:start>0};
 };
 assert.deepEqual(knowledgeHistorySources(ctx,'a').map(s=>s.id),['old']);
 assert.throws(()=>readKnowledgeHistory(ctx,'a',{sessionId:'foreign',query:''}),/不属于/);assert.equal(read,0);
 const result=readKnowledgeHistory(ctx,'a',{sessionId:'old',query:'第二版'});assert.equal(result.messages.length,1);assert.equal(result.messages[0].at,1);
 assert.equal(result.messages[0].state,'原始记录');
 assert.equal(readKnowledgeHistory(ctx,'a',{sessionId:'old',query:'中止'}).messages[0].state,'已中止');
 const long='x'.repeat(4001);
 ctx.agentSessions.store.load=()=>[{id:'long',role:'user',ts:3,parts:[{kind:'text',text:long}]}];
 const clipped=readKnowledgeHistory(ctx,'a',{sessionId:'old',query:''}).messages[0];
 assert.equal(clipped.textTruncated,true);
 assert.equal(clipped.text,`${'x'.repeat(4000)}\n[正文超过4000字，余下内容请在原会话查看]`);
 assert.equal(result.messages[0].textTruncated,undefined);
 const history=Array.from({length:1000},(_,i)=>({id:`message-${i}`,role:i%2?'assistant':'user',createdAt:i,content:i===10||i===990?'needle':'plain'}));
 let pages=0;
 ctx.orchestrator={getHistory(){throw new Error('full history forbidden');},getHistoryRange(_workspaceId,before,limit){
   pages++;assert.ok(limit<=120);
   const end=before??history.length,start=Math.max(0,end-limit);
   return {messages:history.slice(start,end),before:start,total:history.length,hasEarlier:start>0};
 }};
 const tail=readKnowledgeHistory(ctx,'a',{sessionId:'scheduler',query:''});
 assert.equal(tail.messages.length,50);assert.equal(tail.truncated,true);assert.equal(pages,1);
 assert.equal(tail.messages[0].id,'message-950');assert.equal(tail.messages.at(-1).id,'message-999');
 pages=0;
 const sparse=readKnowledgeHistory(ctx,'a',{sessionId:'scheduler',query:'needle'});
 assert.deepEqual(sparse.messages.map(message=>message.id),['message-10','message-990']);assert.equal(sparse.truncated,false);assert.ok(pages>1);
 const guiHistory=Array.from({length:300},(_,i)=>({id:`gui-${i}`,role:i%2?'assistant':'user',ts:i,aborted:i===10,
   parts:[{kind:'text',text:i===10||i===290?'needle GUI':'plain'}]}));
 let guiPages=0;
 ctx.agentSessions.store.load=()=>{throw new Error('full GUI history forbidden');};
 ctx.agentSessions.getHistoryRange=(_sessionId,before,limit)=>{
   guiPages++;assert.ok(limit<=120);const end=before??guiHistory.length,start=Math.max(0,end-limit);
   return {messages:guiHistory.slice(start,end),before:start,total:guiHistory.length,hasEarlier:start>0};
 };
 const guiSparse=readKnowledgeHistory(ctx,'a',{sessionId:'old',query:'needle'});
 assert.deepEqual(guiSparse.messages.map(message=>message.id),['gui-10','gui-290']);assert.equal(guiSparse.messages[0].state,'已中止');
 assert.equal(guiSparse.truncated,false);assert.equal(guiPages,3);
 const record={id:'1',kind:'reusable_lesson',namespace:'worker',summary:'审批提交时核对版本',problem:'审批覆盖冲突',repoKey:'repo',branch:'main'};
 assert.equal(knowledgeTopicGroups([record,{...record,id:'2',summary:'提交审批时再次核对版本'}]).length,1);
 assert.equal(knowledgeTopicGroups([record,{...record,id:'3',namespace:'scheduler'}]).length,2);
 console.log('knowledge-history: explicit original history, scope denial, abort status and topic grouping passed');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
