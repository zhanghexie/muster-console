import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';

const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'memory-curator-budget-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const load=async file=>import(pathToFileURL(compile(file)));
const {CuratorBudgetError,curatorContextBudget,curatorRequestLimit}=await load('main/memory/curator/budget.ts');
const {MemoryCuratorRuntime}=await load('main/memory/curator/runtime.ts');
const {CuratorQueue}=await load('main/memory/curator/queue.ts');
const {CuratorRequestError}=await load('main/memory/curator/retry.ts');
const candidate=id=>({id,eventId:`event:${id}`,namespace:'worker',origin:'worker',text:`候选 ${id}`,sourceText:'原始观察确认已取消订阅',
  evidence:[{id:`e:${id}`,source:'fixture',eventTime:1,verification:'unverified'}],createdAt:1});
const waitFor=async(predicate,label)=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error(`timeout: ${label}`);await new Promise(resolve=>setTimeout(resolve,5));}};
const runtimes=[];let observer;
try{
  assert.equal(curatorRequestLimit(undefined),32);assert.equal(curatorRequestLimit(Infinity),32);assert.equal(curatorRequestLimit(10000),64);assert.equal(curatorRequestLimit(0),1);
  const small=curatorContextBudget({contextWindow:8192}),normal=curatorContextBudget(),large=curatorContextBudget({contextWindow:1_000_000});
  assert.equal(normal.contextWindow,128000);assert.equal(curatorContextBudget({contextWindow:NaN}).contextWindow,128000);
  assert.ok(small.inputCharacters<normal.inputCharacters);assert.ok(normal.inputCharacters<large.inputCharacters);assert.ok(large.rotateCharacters>64000);
  assert.ok(large.inputCharacters<(large.contextWindow-large.outputTokens)*0.75,'output and protocol reserves precede the conservative input boundary');
  assert.ok(normal.rotateCharacters<normal.inputCharacters);

  let now=1000,defaultLimit;
  const receipts=new Map(),commit=(c,d,assertCurrent)=>{assertCurrent();const receipt={candidateId:c.id,operationId:d.operationId,policyVersion:d.policyVersion,decision:d.decision,
    disposition:'discarded',affected:[],reason:'fixture completed',at:now};receipts.set(c.id,receipt);return receipt;};
  const base={workspaceId:'w',root:temp,now:()=>now,references:()=>({records:[],deleted:[]}),commit,receipt:c=>receipts.get(c.id)};
  const complete=async(input,signal)=>{const tools=Object.fromEntries(input.tools.map(tool=>[tool.name,tool])),items=await tools.memory_candidates.execute({},signal);
    for(const item of items){await tools.memory_search.execute({candidateId:item.id,query:'订阅'},signal);await tools.memory_commit.execute({candidateId:item.id,decision:'discard',sourceQuote:'',reason:'fixture completed',deletionComparisons:[]},signal);}
  };
  const defaults=new MemoryCuratorRuntime({...base,directory:path.join(temp,'defaults'),createSession:async input=>{defaultLimit=input.maxModelRequests;return {id:'defaults',async run(_job,signal){
    for(let index=0;index<32;index++){input.onEvent({type:'model-start'});signal.throwIfAborted();}await complete(input,signal);
  },async abort(){},dispose(){}};}});runtimes.push(defaults);
  defaults.enqueue(candidate('default'));await waitFor(()=>!defaults.snapshot().running&&defaults.snapshot().pending===0,'default budget');assert.equal(defaultLimit,32);assert.equal(defaults.snapshot().failed,0);

  for(const [name,options] of [['default',{}],['clamped',{timeoutMs:1e9,maxModelRequests:1e9}]]){
    let entered;const ready=new Promise(resolve=>{entered=resolve;}),directory=path.join(temp,`timeout-${name}`);let limit;
    const runtime=new MemoryCuratorRuntime({...base,...options,directory,createSession:async input=>{limit=input.maxModelRequests;return {id:name,async run(){entered();await new Promise(()=>{});},async abort(){},dispose(){}};}});runtimes.push(runtime);
    runtime.enqueue(candidate(`timeout-${name}`));await ready;observer=new DatabaseSync(path.join(directory,'curator.sqlite'));
    assert.equal(observer.prepare('SELECT lease_until FROM candidates').get().lease_until,now+610000,'the processing lease reserves the ten-minute timeout plus shutdown margin');
    assert.equal(limit,name==='default'?32:64);observer.close();observer=undefined;await runtime.setPaused(true);
  }

  const directory=path.join(temp,'split'),queue=new CuratorQueue(temp,directory,()=>now);
  for(const id of ['a','b','c'])queue.enqueue(candidate(id));queue.close();
  const batches=[],writes=[],options={...base,directory,maxBatch:100,commit(c,d,assertCurrent){writes.push(c.id);return commit(c,d,assertCurrent);},
    createSession:async input=>({id:`split:${batches.length}`,async run(_job,signal){const tools=Object.fromEntries(input.tools.map(tool=>[tool.name,tool])),items=await tools.memory_candidates.execute({},signal);
      batches.push(items.map(item=>item.id));
      if(items.length>1){assert.equal(items.length,3);await tools.memory_search.execute({candidateId:'a',query:'订阅'},signal);await tools.memory_commit.execute({candidateId:'a',decision:'discard',sourceQuote:'',reason:'fixture completed',deletionComparisons:[]},signal);throw new CuratorBudgetError('requests');}
      if(items[0].id==='b')throw new CuratorBudgetError('context');await complete(input,signal);
    },async abort(){},dispose(){}})};
  let runtime=new MemoryCuratorRuntime(options);runtimes.push(runtime);runtime.requestDrain();await waitFor(()=>!runtime.snapshot().running&&batches.length===1,'initial split');
  assert.deepEqual(batches,[['a','b','c']]);assert.deepEqual(writes,['a']);
  assert.deepEqual(runtime.inspect({state:'deferred'}).items.map(item=>item.id).sort(),['b','c']);
  assert.ok(runtime.withMaintenance(db=>db.prepare("SELECT COUNT(*) n FROM candidates WHERE state='deferred' AND defer_single=1").get().n)===2);
  await runtime.stop();runtimes.pop();runtime=new MemoryCuratorRuntime(options);runtimes.push(runtime);
  runtime.snapshot();assert.equal(batches.length,1,'reopening does not automatically request a model');
  now+=1001;runtime.requestDrain();await waitFor(()=>receipts.has('c')&&!runtime.snapshot().running,'single retries');
  assert.deepEqual(batches,[['a','b','c'],['b'],['c']],'the persisted split never repeats the original three-candidate batch');
  now+=1001;runtime.requestDrain();await waitFor(()=>!runtime.snapshot().running&&runtime.snapshot().failed===1,'finite final retry');
  assert.deepEqual(batches,[['a','b','c'],['b'],['c'],['b']]);assert.deepEqual(writes,['a','c'],'settled receipts never reappear in continuation work');
  assert.equal(runtime.snapshot().pending,0);assert.equal(runtime.inspect({state:'failed'}).items[0].attempts,3);
  runtime.requestDrain();await new Promise(resolve=>setTimeout(resolve,15));assert.equal(batches.length,4);
  await runtime.stop();runtimes.pop();runtime=new MemoryCuratorRuntime(options);runtimes.push(runtime);runtime.requestDrain();
  assert.equal(batches.length,4,'an upgrade or restart does not retry an old exhausted failure');

  for(const kind of ['requests','context','time'])for(const ErrorType of [Error,CuratorRequestError]){
    const id=`forged-${kind}-${ErrorType.name}`;let forgedCalls=0;
    const forged=new MemoryCuratorRuntime({...base,directory:path.join(temp,id),createSession:async()=>{forgedCalls++;throw new ErrorType(new CuratorBudgetError(kind).message);}});runtimes.push(forged);
    const generation=forged.snapshot().generation;forged.enqueue(candidate(id));await waitFor(()=>!forged.snapshot().running,'untrusted budget wording');
    assert.equal(forged.snapshot().failed,1);assert.equal(forged.snapshot().pending,0);assert.equal(forgedCalls,1,'provider/model text cannot mint the host budget continuation capability');
    assert.equal(forged.snapshot().generation,generation,'budget wording cannot rotate the context');
    assert.equal(forged.withMaintenance(db=>db.prepare('SELECT defer_single FROM candidates').get().defer_single),0,'budget wording cannot enable the persistent single retry path');
  }
  console.log('memory-curator-budget: defaults, configured context scaling, host-only budget failures, durable single-candidate continuation, receipts and finite attempts passed');
}finally{
  observer?.close();for(const runtime of runtimes)await runtime.stop();
  const relative=path.relative(scratch,temp);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))fs.rmSync(temp,{recursive:true,force:true});
}
