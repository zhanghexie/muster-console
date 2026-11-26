import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';

const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'memory-curator-completion-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const load=async file=>import(pathToFileURL(compile(file)));
const {MemoryCuratorRuntime}=await load('main/memory/curator/runtime.ts');
const {CuratorQueue}=await load('main/memory/curator/queue.ts');
const {KnowledgeStore}=await load('main/memory/knowledgeStore.ts');
const originalSettle=CuratorQueue.prototype.settle;
const originalSetTimeout=globalThis.setTimeout;
const quote='原始观察：卸载会释放订阅，循环挂载后回调恢复初始数量。';
const candidate=id=>({id,eventId:`event:${id}`,namespace:'worker',origin:'worker',text:`订阅经验 ${id}`,searchKeys:['订阅清理'],sourceText:quote,
  evidence:[{id:`e:${id}`,source:'fixture',eventTime:1,verification:'unverified'}],createdAt:1});
const lesson=id=>({kind:'reusable_lesson',summary:`卸载释放订阅 ${id}`,problem:'重复挂载累计回调',action:'卸载时取消订阅',rationale:quote,
  applicability:['React组件'],exceptions:[],expectedFutureUse:'避免重复事件响应'});
const waitFor=async(predicate,label)=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error(`timeout: ${label}`);await new Promise(resolve=>setTimeout(resolve,5));}};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const fixtures=[];
function fixture(name,ids,run,patch={}){
  const directory=path.join(temp,name),store=new KnowledgeStore(path.join(temp,`${name}-knowledge`));
  const queue=new CuratorQueue(temp,directory,()=>1000);for(const id of ids)queue.enqueue(candidate(id));queue.close();
  const f={directory,store,calls:[],writes:[],signals:[],lookups:0};
  const runtime=new MemoryCuratorRuntime({workspaceId:name,root:temp,directory,now:()=>1000,policyVersion:'fixture',
    references:(c,query)=>store.curatorReferences(query,{namespace:c.namespace,repoKey:c.repoKey,branch:c.branch}),
    receipt(c){f.lookups++;return store.curatorReceipt(c.id);},
    commit(c,d,assertCurrent){f.writes.push(c.id);return store.commitCuratorDecision(d,{...c,now:1000,assertCurrent});},
    createSession:async input=>({id:name,async run(job,signal){f.calls.push(job);f.signals.push(signal);const tools=Object.fromEntries(input.tools.map(tool=>[tool.name,tool]));
      const request=()=>{input.beforeModelRequest?.();input.onEvent({type:'model-start'});signal.throwIfAborted();};
      await run({f,job,signal,tools,input,request});
    },async abort(){},dispose(){}}),...patch});
  f.runtime=runtime;fixtures.push(f);return f;
}
async function save(tools,id,signal){
  await tools.memory_search.execute({candidateId:id,query:'订阅'},signal);
  return tools.memory_commit.execute({candidateId:id,decision:'save',draft:lesson(id),sourceQuote:quote,reason:'原始观察支持此条件',deletionComparisons:[]},signal);
}
async function discard(tools,id,signal){
  await tools.memory_search.execute({candidateId:id,query:'已有记忆'},signal);
  return tools.memory_commit.execute({candidateId:id,decision:'discard',sourceQuote:'',reason:'只读查询',deletionComparisons:[]},signal);
}
try{
  const partial=fixture('partial',['a','b','c'],async({job,signal,tools,input,request})=>{
    request();const ids=(await tools.memory_candidates.execute({},signal)).map(c=>c.id);
    if(job.kind==='candidate'){assert.deepEqual(ids,['a','b','c']);await save(tools,'a',signal);await save(tools,'b',signal);input.onEvent({type:'text-delta',text:'两条已经处理。'});}
    else{assert.equal(job.kind,'repair');assert.deepEqual(ids,['c']);await assert.rejects(()=>save(tools,'a',signal),/不属于|已有真实/);input.onEvent({type:'text-delta',text:'已完成。'});}
  });
  partial.runtime.requestDrain();await waitFor(()=>!partial.runtime.snapshot().running,'partial result');
  assert.equal(partial.calls.length,2);assert.deepEqual(partial.writes,['a','b']);assert.equal(partial.store.list().active,2);
  assert.equal(partial.runtime.snapshot().failed,1);assert.match(partial.runtime.snapshot().error,/已确认 2\/3.*剩余 1/);
  assert.doesNotMatch(partial.runtime.snapshot().error,/未更改知识/);assert.equal(partial.runtime.inspect({state:'done'}).total,2);
  assert.ok(partial.runtime.snapshot().messages.some(message=>message.parts.some(part=>part.kind==='text'&&part.text==='两条已经处理。')),'completed prose and actual saved results are retained');

  const none=fixture('none',['none-a','none-b'],async({input,request})=>{request();input.onEvent({type:'text-delta',text:'两条已完成'});});
  none.runtime.requestDrain();await waitFor(()=>!none.runtime.snapshot().running,'all receipts missing');
  assert.equal(none.calls.length,2);assert.equal(none.runtime.snapshot().failed,2);assert.match(none.runtime.snapshot().error,/已确认 0\/2.*剩余 2/);
  assert.equal(none.writes.length,0);assert.equal(none.store.list().records.length,0);

  const repaired=fixture('repaired',['repair-a','repair-b'],async({job,signal,tools,request})=>{
    request();if(job.kind==='candidate')await save(tools,'repair-a',signal);
    else{assert.deepEqual((await tools.memory_candidates.execute({},signal)).map(c=>c.id),['repair-b']);await save(tools,'repair-b',signal);}
  });
  repaired.runtime.requestDrain();await waitFor(()=>!repaired.runtime.snapshot().running,'repair completes');
  assert.deepEqual(repaired.writes,['repair-a','repair-b']);assert.equal(repaired.calls.length,2);assert.equal(repaired.runtime.snapshot().failed,0);assert.equal(repaired.runtime.snapshot().error,undefined);

  const afterCommit=fixture('after-commit-error',['after-commit'],async({signal,tools,request})=>{request();await save(tools,'after-commit',signal);throw new Error('fixture provider failed after commit');});
  afterCommit.runtime.requestDrain();await waitFor(()=>!afterCommit.runtime.snapshot().running,'settled results survive a later provider error');
  assert.equal(afterCommit.calls.length,1);assert.equal(afterCommit.runtime.snapshot().failed,0);assert.equal(afterCommit.runtime.snapshot().error,undefined);assert.deepEqual(afterCommit.writes,['after-commit']);

  for(const closeInitially of [true,false]){
    const id=`read-only-${closeInitially}`;
    const query=fixture(id,[],async({job,tools,signal,input,request})=>{request();
      input.onEvent({type:'text-delta',text:'当前没有适用记忆。'});
      if(closeInitially||job.kind==='repair')await discard(tools,id,signal);
    },{userCandidate:text=>({...candidate(id),origin:'user',explicit:true,sourceText:text,userText:text,
      evidence:[{id,source:'memory-curator-user',eventTime:1,verification:'user_confirmed'}]})});
    assert.equal((await query.runtime.send('请查询目前适用的记忆')).accepted,true);await waitFor(()=>!query.runtime.snapshot().running,id);
    assert.equal(query.calls.length,closeInitially?1:2);assert.equal(query.runtime.snapshot().pending,0);assert.equal(query.runtime.snapshot().failed,0);
    assert.equal(query.store.curatorReceipt(id).decision,'discard');assert.equal(query.store.list().records.length,0,'a read-only request has a real close receipt without saving the question');
    if(!closeInitially)assert.equal(query.calls[1].kind,'repair');
  }

  let loseAck=true;CuratorQueue.prototype.settle=function(claim,result){if(claim.candidate.id==='ack-loss'&&loseAck){loseAck=false;throw new Error('fixture queue acknowledgement lost');}return originalSettle.call(this,claim,result);};
  const ack=fixture('ack-loss',['ack-loss'],async({signal,tools,request})=>{request();await assert.rejects(()=>save(tools,'ack-loss',signal),/acknowledgement lost/);});
  ack.runtime.requestDrain();await waitFor(()=>!ack.runtime.snapshot().running,'post-turn receipt reconciliation');CuratorQueue.prototype.settle=originalSettle;
  assert.equal(ack.calls.length,1,'the durable receipt is acknowledged before any repair model call');assert.deepEqual(ack.writes,['ack-loss']);
  assert.equal(ack.runtime.snapshot().failed,0);assert.equal(ack.runtime.inspect({state:'done'}).total,1);assert.equal(ack.store.db.prepare('SELECT COUNT(*) n FROM curator_receipts').get().n,1);

  const invalid=fixture('invalid',['invalid'],async()=>{throw new Error('invalid receipt must be rejected before Pi');},{receipt:()=>({candidateId:'invalid',operationId:'not-a-complete-receipt'})});
  invalid.runtime.requestDrain();await waitFor(()=>!invalid.runtime.snapshot().running,'invalid persistent receipt');
  assert.equal(invalid.calls.length,0);assert.equal(invalid.runtime.snapshot().failed,1);assert.match(invalid.runtime.snapshot().error,/回执格式无效/);

  let actualRequests=0;
  const bounded=fixture('shared-requests',['shared-requests'],async({request})=>{request();actualRequests++;request();actualRequests++;},{maxModelRequests:3});
  bounded.runtime.requestDrain();await waitFor(()=>!bounded.runtime.snapshot().running,'shared model budget');
  assert.equal(bounded.calls.length,2);assert.equal(actualRequests,3,'repair uses the remaining initial batch budget rather than another free allocation');
  assert.equal(bounded.runtime.inspect({state:'deferred'}).total,1);assert.equal(bounded.runtime.withMaintenance(db=>db.prepare('SELECT defer_single FROM candidates').get().defer_single),1);
  await bounded.runtime.setPaused(true);

  const repairEntered=deferred(),deadlineCallbacks=[];
  globalThis.setTimeout=(callback,ms,...args)=>{if(ms===123456)deadlineCallbacks.push(callback);return originalSetTimeout(callback,ms,...args);};
  const deadline=fixture('shared-deadline',['shared-deadline'],async({job,request})=>{request();if(job.kind==='repair'){repairEntered.resolve();await new Promise(()=>{});}},{timeoutMs:123456});
  deadline.runtime.requestDrain();await repairEntered.promise;globalThis.setTimeout=originalSetTimeout;
  assert.equal(deadlineCallbacks.length,1,'creating Pi and the repair share one batch deadline timer');assert.equal(deadline.signals[0],deadline.signals[1]);
  deadlineCallbacks[0]();await waitFor(()=>!deadline.runtime.snapshot().running,'original batch deadline aborts repair');
  assert.equal(deadline.runtime.inspect({state:'deferred'}).total,1);assert.match(deadline.runtime.snapshot().error,/时间预算/);await deadline.runtime.setPaused(true);

  const receiptEntered=deferred(),receiptDeadline=[];let receiptReads=0;
  globalThis.setTimeout=(callback,ms,...args)=>{if(ms===123457)receiptDeadline.push(callback);return originalSetTimeout(callback,ms,...args);};
  const slowReceipt=fixture('receipt-deadline',['receipt-deadline'],async({request})=>{request();},{timeoutMs:123457,receipt(){
    if(++receiptReads===1)return undefined;receiptEntered.resolve();return new Promise(()=>{});
  }});
  slowReceipt.runtime.requestDrain();await receiptEntered.promise;globalThis.setTimeout=originalSetTimeout;
  assert.equal(receiptDeadline.length,1);receiptDeadline[0]();await waitFor(()=>!slowReceipt.runtime.snapshot().running,'receipt lookup respects the batch deadline');
  assert.equal(slowReceipt.calls.length,1);assert.equal(slowReceipt.runtime.inspect({state:'deferred'}).total,1);await slowReceipt.runtime.setPaused(true);

  const pauseEntered=deferred();let lateCommit,beforeLate;
  const paused=fixture('pause-repair',['pause-a','pause-b'],async({job,signal,tools,input,request})=>{
    request();if(job.kind==='candidate'){await save(tools,'pause-a',signal);return;}
    await tools.memory_search.execute({candidateId:'pause-b',query:'订阅'},signal);
    lateCommit=()=>tools.memory_commit.execute({candidateId:'pause-b',decision:'save',draft:lesson('pause-b'),sourceQuote:quote,reason:'late',deletionComparisons:[]});
    beforeLate=input.beforeModelRequest;pauseEntered.resolve();await new Promise(()=>{});
  });
  paused.runtime.requestDrain();await pauseEntered.promise;await paused.runtime.setPaused(true);
  await assert.rejects(lateCommit,/暂停|停止|过期|换代|当前没有可处理的记忆任务/);assert.throws(beforeLate,/暂停|过期|换代/);
  assert.deepEqual(paused.writes,['pause-a']);assert.equal(paused.runtime.snapshot().pending,1);assert.equal(paused.runtime.snapshot().failed,0);

  const evidence=fixture('shared-evidence',['shared-evidence'],async({job,signal,tools,request})=>{request();
    if(job.kind==='candidate')for(let index=0;index<24;index++)await tools.memory_evidence.execute({candidateId:'shared-evidence',evidenceId:'source',query:'没有这个原文'},signal);
    else await assert.rejects(()=>tools.memory_evidence.execute({candidateId:'shared-evidence',evidenceId:'source',query:'原始观察'},signal),/预算已用尽/);
  });
  evidence.runtime.requestDrain();await waitFor(()=>!evidence.runtime.snapshot().running,'shared evidence budget');assert.equal(evidence.calls.length,2);assert.equal(evidence.runtime.snapshot().failed,1);
  console.log('memory-curator-completion: truthful partial results, one bounded repair, durable receipt reconciliation, read-only closure, shared budgets and cancellation passed');
}finally{
  globalThis.setTimeout=originalSetTimeout;CuratorQueue.prototype.settle=originalSettle;
  for(const fixture of fixtures){await fixture.runtime.stop();fixture.store.close();}
  const relative=path.relative(scratch,temp);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))fs.rmSync(temp,{recursive:true,force:true});
}
