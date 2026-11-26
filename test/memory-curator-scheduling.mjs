import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';

const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'memory-curator-scheduling-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const {CuratorQueue,curatorSourceInformation}=await import(pathToFileURL(compile('main/memory/curator/queue.ts')));
const {MemoryCuratorRuntime}=await import(pathToFileURL(compile('main/memory/curator/runtime.ts')));
const raw='挂载卸载循环观察：清理订阅后回调数量恢复，React 19 条件下没有累计。';
const candidate=(id,extra={})=>({id,eventId:`note:${id}`,namespace:'worker',origin:'worker',text:'清理组件订阅；仅适用于组件卸载',
  sourceText:raw,userText:'记录这个观察',evidence:[{id:`note:${id}`,source:'memory.note',eventTime:100,verification:'unverified',
    observation:'user_input',contentHash:'a'.repeat(64),excerpt:'记录这个观察'}],createdAt:100,...extra});
const waitFor=async(predicate,label)=>{const end=Date.now()+2500;while(!predicate()){if(Date.now()>end)throw new Error(`timeout: ${label}`);await new Promise(resolve=>setTimeout(resolve,5));}};
let queue,runtime;
try{
  let now=100;const directory=path.join(temp,'queue');queue=new CuratorQueue(temp,directory,()=>now);
  const first=candidate('first',{});
  assert.equal(queue.enqueue(first).queued,true);
  const repeat=queue.enqueue(candidate('second',{}));
  assert.equal(repeat.queued,false);assert.equal(repeat.candidateId,first.id,'a different turn reuses the original information identity');
  const claim=queue.claim(1,1000)[0];queue.defer(claim,'原始依据暂不可用');
  const due=queue.nextWakeAt();
  assert.equal(queue.enqueue(candidate('third',{})).queued,false);
  assert.equal(queue.nextWakeAt(),due,'a new turn cannot bring a deferred job forward or reset attempts');
  assert.equal(queue.db.prepare('SELECT attempts FROM candidates WHERE id=?').get(first.id).attempts,1);
  queue.close();queue=new CuratorQueue(temp,directory,()=>now);
  assert.equal(queue.enqueue(candidate('after-reopen',{})).queued,false,'information identity survives reopening');
  assert.equal(queue.enqueue(candidate('new-source',{sourceText:raw+' 后续观察发现 StrictMode 下仍然重复。'})).queued,true,
    'changed original text is new information even when evidence hashes are unchanged');
  assert.equal(queue.enqueue(candidate('new-condition',{text:first.text+'；不适用于独立服务'})).queued,true);
  assert.equal(queue.enqueue(candidate('new-policy',{}),'candidate','memory-curator-v2:automatic').queued,true);
  assert.equal(queue.enqueue(candidate('different-scope',{namespace:'scheduler'})).queued,true);
  for(const id of ['human-remember-one','human-remember-two'])assert.equal(queue.enqueue(candidate(id,{origin:'user',explicit:true})).queued,true,'a repeated remember instruction is fresh authorization');
  for(const id of ['human-action-one','human-action-two'])assert.equal(queue.enqueue(candidate(id,{origin:'user'}),'user').queued,true,'human delete/restore/query requests are distinct');
  const tool=(id)=>{const c=candidate(id,{sourceText:`用户原话：\n记录这个观察\n\n工具 call-${id} bash 状态=ok\n原始结果：${raw}`,
    evidence:[{id:`note:${id}:tool:call-${id}`,source:'bash',eventTime:100,verification:'unverified',observation:'tool_output',contentHash:'b'.repeat(64),excerpt:raw}]});
    return {...c,hostInformationHash:curatorSourceInformation(c)};};
  const toolOne=tool('call-one'),toolTwo=tool('call-two');
  assert.equal(queue.enqueue(toolOne).queued,true);assert.equal(queue.enqueue(toolTwo).queued,false,'temporary host call labels are not new observations');
  assert.throws(()=>queue.enqueue({...tool('bad-binding'),sourceText:'changed source with stale host identity'}),/身份与内容不匹配/);
  const cliOne=candidate('cli-one',{sourceText:'CLI混合摘录：原始运行结果A'});cliOne.hostInformationHash=curatorSourceInformation(cliOne);
  const cliTwo=candidate('cli-two',{sourceText:'CLI混合摘录：原始运行结果B'});cliTwo.hostInformationHash=curatorSourceInformation(cliTwo);
  assert.equal(queue.enqueue(cliOne).queued,true);assert.equal(queue.enqueue(cliTwo).queued,true,'new CLI source content remains distinguishable');
  queue.db.exec("DELETE FROM candidate_information; DELETE FROM meta WHERE key='informationIndexVersion'");queue.close();queue=new CuratorQueue(temp,directory,()=>now);
  assert.equal(queue.enqueue(candidate('migration-repeat',{})).queued,false,'existing persisted jobs are indexed without another Pi decision');
  queue.close();queue=undefined;

  // Defensive maintenance seam: production retention currently does not delete queue jobs.
  // Delete one completed original row, rather than dropping or reconstructing its index table.
  const seamDirectory=path.join(temp,'maintenance-seam');queue=new CuratorQueue(temp,seamDirectory,()=>now);
  const original=candidate('maintenance-original');assert.equal(queue.enqueue(original).queued,true);
  queue.settle(queue.claim(1,1000)[0],{disposition:'discarded',reason:'fixture completed'});
  assert.equal(queue.enqueue(candidate('while-original-exists')).candidateId,original.id,'a completed original still suppresses equivalent information');
  assert.equal(queue.db.prepare("DELETE FROM candidates WHERE id=? AND state='done'").run(original.id).changes,1);
  assert.equal(queue.db.prepare('SELECT COUNT(*) n FROM candidate_information').get().n,1,'maintenance leaves the orphaned mapping that caused the primary-key conflict');
  const replacement=candidate('maintenance-replacement');
  assert.equal(queue.enqueue(replacement).queued,true,'enqueue atomically repairs the orphan without failing its index insert');
  assert.equal(queue.db.prepare('SELECT COUNT(*) n FROM candidates').get().n,1);assert.equal(queue.db.prepare('SELECT COUNT(*) n FROM candidate_information').get().n,1);
  assert.equal(queue.db.prepare('SELECT candidate_id FROM candidate_information').get().candidate_id,replacement.id);
  queue.close();queue=new CuratorQueue(temp,seamDirectory,()=>now);
  const stillDuplicate=queue.enqueue(candidate('after-maintenance-reopen'));
  assert.equal(stillDuplicate.queued,false);assert.equal(stillDuplicate.candidateId,replacement.id,'the repaired live mapping remains durable and suppresses repeated evaluation');
  assert.equal(queue.db.prepare('SELECT attempts FROM candidates WHERE id=?').get(replacement.id).attempts,0);
  queue.settle(queue.claim(1,1000)[0],{disposition:'discarded',reason:'replacement completed'});
  queue.db.prepare("DELETE FROM candidates WHERE id=? AND state='done'").run(replacement.id);
  assert.equal(queue.enqueue(replacement).queued,true,'the same original event can also recover after its row is explicitly maintained away');
  assert.equal(queue.db.prepare('SELECT COUNT(*) n FROM candidate_information').get().n,1);
  queue.close();queue=undefined;

  now=100;let calls=0;const runtimeOptions={workspaceId:'w',root:temp,directory:path.join(temp,'runtime'),now:()=>now,
    references:()=>({records:[],deleted:[]}),commit(){throw new Error('unexpected write');},
    createSession:async input=>({id:'dedicated-memory',async run(_job,signal){calls++;const tools=Object.fromEntries(input.tools.map(t=>[t.name,t]));
      const [item]=await tools.memory_candidates.execute({},signal);await tools.memory_defer.execute({candidateId:item.id,reason:'依据暂不可定位'},signal);
    },async abort(){},dispose(){}})};
  runtime=new MemoryCuratorRuntime(runtimeOptions);runtime.enqueue(candidate('runtime-first'));await waitFor(()=>!runtime.snapshot().running,'first defer');
  assert.equal(calls,1);
  for(let index=0;index<4;index++)assert.equal(runtime.enqueue(candidate(`duplicate-turn-${index}`)).queued,false);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1,'repeated new turn IDs do not wake the model');
  now+=30_001;runtime.requestDrain();await waitFor(()=>!runtime.snapshot().running,'second defer');assert.equal(calls,2);
  now+=60_001;runtime.requestDrain();await waitFor(()=>!runtime.snapshot().running,'third defer');assert.equal(calls,3);assert.equal(runtime.snapshot().failed,1);
  assert.equal(runtime.enqueue(candidate('after-exhaustion')).queued,false);runtime.requestDrain();assert.equal(calls,3,'new event identities cannot evade the finite deferral cap');
  await runtime.stop();runtime=new MemoryCuratorRuntime(runtimeOptions);assert.equal(runtime.enqueue(candidate('after-restart')).queued,false);runtime.requestDrain();
  assert.equal(calls,3);assert.equal(runtime.snapshot().failed,1,'terminal state survives process reopening');
  console.log('memory-curator-scheduling: durable information identity, fresh sources/conditions/policy, explicit human actions and finite cross-turn deferral passed');
}finally{queue?.close();if(runtime)await runtime.stop();fs.rmSync(temp,{recursive:true,force:true});}
