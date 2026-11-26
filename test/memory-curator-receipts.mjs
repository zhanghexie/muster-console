import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'memory-curator-receipts-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const load=async file=>import(pathToFileURL(compile(file)));
const {KnowledgeStore}=await load('main/memory/knowledgeStore.ts');
const {CuratorQueue}=await load('main/memory/curator/queue.ts');
const {MemoryCuratorRuntime}=await load('main/memory/curator/runtime.ts');
const lesson={kind:'reusable_lesson',summary:'卸载清理订阅',problem:'多次挂载产生重复监听',action:'卸载调用unsubscribe',rationale:'循环挂载卸载检查监听器恢复原数',applicability:['React'],exceptions:[],expectedFutureUse:'避免回调累积'};
const candidate=id=>({id,eventId:id,namespace:'worker',origin:'worker',text:'清理订阅经验',sourceText:'循环挂载卸载检查监听器恢复原数',evidence:[{id:`e:${id}`,source:'fixture',eventTime:1,verification:'test'}],createdAt:1});
const waitFor=async predicate=>{const end=Date.now()+2500;while(!predicate()){if(Date.now()>end)throw new Error('receipt recovery timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
const runtimes=[];let store;
try{
  for(const laterDeleted of [false,true])for(const crashedAttempt of [1,3]){
    let now=100;
    const id=`${laterDeleted?'deleted-after-commit':'committed-before-crash'}:${crashedAttempt}`,job=candidate(id),directory=path.join(temp,id.replaceAll(':','-'));
    const queue=new CuratorQueue(temp,directory,()=>now);queue.enqueue(job);
    for(let attempt=0;attempt<crashedAttempt;attempt++){queue.claim(1,10);now+=20;}
    store=new KnowledgeStore(path.join(temp,`${id.replaceAll(':','-')}-knowledge`));
    const receipt=store.commitCuratorDecision({operationId:`memory:${id}`,candidateId:id,policyVersion:'fixture',decision:'save',draft:lesson,sourceQuote:job.sourceText,reason:'可靠观察',reviewedDeletionIds:[],deletionComparisons:[]},job);
    if(laterDeleted)store.deleteKnowledge(receipt.record.id,receipt.record.revision);
    // Abrupt process exit leaves the queue running while the separate knowledge transaction is committed.
    queue.close();store.close();store=new KnowledgeStore(path.join(temp,`${id.replaceAll(':','-')}-knowledge`));now=1000;
    let model=0,writes=0,lookups=0;
    const runtime=new MemoryCuratorRuntime({workspaceId:id,root:temp,directory,now:()=>now,
      receipt(c){lookups++;return store.curatorReceipt(c.id);},
      createSession:async()=>{model++;throw new Error('recovered receipt must not request Pi');},
      references:()=>({records:[],deleted:[]}),commit(){writes++;throw new Error('recovered receipt must not execute a new decision');}});
    runtimes.push(runtime);runtime.requestDrain();await waitFor(()=>!runtime.snapshot().running&&runtime.snapshot().pending===0);
    assert.equal(model,0);assert.equal(writes,0);assert.equal(lookups,1);assert.equal(runtime.snapshot().failed,0);
    assert.deepEqual(runtime.snapshot().messages,[],'recovery occurs before prompt/transcript creation');
    assert.equal(store.curatorReceipt(id).operationId,receipt.operationId);
    if(laterDeleted){assert.equal(store.list().records[0].status,'rejected');assert.equal(store.deletedKnowledge({namespace:'worker'}).length,1,'acknowledging an old receipt never resurrects deleted knowledge');}
    await runtime.stop();runtimes.pop();store.close();store=undefined;
    const verified=new CuratorQueue(temp,directory);assert.equal(verified.db.prepare('SELECT state FROM candidates WHERE id=?').get(id).state,'done');verified.close();
  }
  let exhaustedNow=100;
  const exhaustedDirectory=path.join(temp,'exhausted-without-receipt'),exhaustedQueue=new CuratorQueue(temp,exhaustedDirectory,()=>exhaustedNow);
  exhaustedQueue.enqueue(candidate('no-committed-receipt'));
  for(let attempt=0;attempt<3;attempt++){exhaustedQueue.claim(1,10);exhaustedNow+=20;}
  exhaustedQueue.close();exhaustedNow=1000;let excessModels=0;
  const exhausted=new MemoryCuratorRuntime({workspaceId:'exhausted',root:temp,directory:exhaustedDirectory,now:()=>exhaustedNow,
    receipt:()=>undefined,createSession:async()=>{excessModels++;throw new Error('fourth attempt forbidden');},references:()=>({records:[],deleted:[]}),commit(){throw new Error('unexpected commit');}});
  runtimes.push(exhausted);exhausted.requestDrain();await waitFor(()=>!exhausted.snapshot().running&&exhausted.snapshot().pending===0);
  assert.equal(exhausted.snapshot().failed,1);assert.equal(excessModels,0,'receipt recovery cannot authorize a fourth model attempt');
  console.log('memory-curator-receipts: cross-ledger crash recovery settles durable receipts without Pi, new writes or deletion resurrection');
}finally{
  for(const runtime of runtimes)await runtime.stop();store?.close();
  const relative=path.relative(scratch,temp);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))fs.rmSync(temp,{recursive:true,force:true});
}
