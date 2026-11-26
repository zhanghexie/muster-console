import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const temp=fs.mkdtempSync(path.resolve('.tmp/knowledge-timeouts-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const {KnowledgeStore}=await import(pathToFileURL(compile('main/memory/knowledgeStore.ts')));
const {KnowledgePipeline}=await import(pathToFileURL(compile('main/memory/knowledgePipeline.ts')));
const {knowledgeProcessingStatus}=await import(pathToFileURL(compile('main/memory/knowledgeProcessing.ts')));
const {runKnowledgeStage}=await import(pathToFileURL(compile('main/memory/knowledgeStage.ts')));
const store=new KnowledgeStore(path.join(temp,'assets'));
const pipeline=new KnowledgePipeline(store,{timeoutMs:80,maxAttempts:2,backoffMs:1});
const text='组件卸载时必须取消订阅，挂载卸载循环测试通过，避免重复回调。';
const draft={kind:'reusable_lesson',summary:'订阅应清理',problem:'重复回调',action:'取消订阅',rationale:'卸载测试通过',applicability:['React'],expectedFutureUse:'避免重复事件'};
const extracted=JSON.stringify({records:[draft]});
const reviewed=JSON.stringify({decisions:[{index:0,verdict:'keep',sourceQuote:text,reason:'有原文依据'}]});
const enqueue=id=>pipeline.enqueue({id,text,namespace:'worker',origin:'worker',evidence:{id,source:'session',eventTime:Date.now(),verification:'unverified'}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
  // Both stages take less than 80ms, but together exceed it: no shared timer.
  enqueue('independent');let calls=0;
  const result=await pipeline.run(async()=>{await sleep(45);return ++calls===1?extracted:reviewed;});
  assert.equal(result.processed,1);assert.equal(calls,2);
  const timing=JSON.parse(store.db.prepare("SELECT timings FROM source_events WHERE id='independent'").get().timings);
  assert.deepEqual(timing.map(t=>t.stage),['记忆抽取','价值审查']);

  enqueue('review-timeout');calls=0;const signals=[];
  const failed=await pipeline.run(async({signal})=>{calls++;if(calls===1)return extracted;signals.push(signal);return new Promise(()=>{});});
  assert.equal(calls,3);assert.match(failed.errors[0],/价值审查.*尝试 2 次.*价值审查超时/);
  assert.ok(signals.every(s=>s.aborted));
  assert.equal(store.list().records[0].evidence.length,1,'unreviewed evidence never published');
  store.setCheckpoint('processing:error',failed.errors[0]);
  const status=knowledgeProcessingStatus(pipeline,'worker');
  assert.equal(status.failed,1);assert.equal(status.errors.length,1,'legacy event summary is not shown twice');
  store.setCheckpoint('processing:error','模型配置不可用');
  assert.equal(knowledgeProcessingStatus(pipeline,'worker').errors.length,2,'independent configuration errors remain visible');
  pipeline.retryFailed();calls=0;
  await pipeline.run(async({system})=>{calls++;assert.match(system,/审查候选/);return reviewed;});
  assert.equal(calls,1,'manual retry reuses extraction but still reviews');
  assert.equal(knowledgeProcessingStatus(pipeline,'worker').errors.length,0);

  enqueue('invalid-review');calls=0;
  const invalid=await pipeline.run(async()=>++calls===1?extracted:JSON.stringify({decisions:[{index:0,verdict:'keep',sourceQuote:'这条依据完全是虚构的，并没有出现在任何原文中',reason:'猜测'}]}));
  assert.equal(calls,2,'invalid grounding is not automatically retried');
  assert.match(invalid.errors[0],/价值审查.*依据不能/);
  assert.equal(store.list().records[0].evidence.length,2);

  let attempts=0;
  await runKnowledgeStage('记忆抽取',async()=>{if(++attempts===1)throw new Error('巩固 LLM 429');return 'ok';},new AbortController().signal,()=>{}, {timeoutMs:80,maxAttempts:2,backoffMs:1});
  assert.equal(attempts,2);
  attempts=0;
  await assert.rejects(()=>runKnowledgeStage('记忆抽取',async()=>{attempts++;throw new Error('巩固 LLM 401');},new AbortController().signal,()=>{}, {timeoutMs:80,maxAttempts:2,backoffMs:1}),/尝试 1 次/);
  assert.equal(attempts,1);
  attempts=0;
  await assert.rejects(()=>runKnowledgeStage('价值审查',async()=>{attempts++;throw new Error('无效依据：原文包含 500 个字符');},new AbortController().signal,()=>{}, {timeoutMs:80,maxAttempts:2,backoffMs:1}),/尝试 1 次/);
  assert.equal(attempts,1,'numbers in validation failures are not HTTP statuses');
  enqueue('extract-timeout');let resolveLate;calls=0;
  const flight=pipeline.run(async()=>{calls++;return new Promise(resolve=>{resolveLate=resolve;});});
  assert.throws(()=>pipeline.retryFailed(),/正在运行/,'manual retry while running is explicit, not a silent no-op');
  const timeout=await flight;
  assert.equal(calls,2);assert.match(timeout.errors[0],/记忆抽取.*尝试 2 次.*记忆抽取超时/);
  resolveLate(extracted);await sleep(5);
  assert.equal(store.db.prepare("SELECT prepared FROM source_events WHERE id='extract-timeout'").get().prepared,null,'late response must not publish');
  assert.equal(store.list().records[0].evidence.length,2);
  assert.equal(knowledgeProcessingStatus(pipeline,'worker').failed,2,'separate failed events remain separate');
  // Non-cooperative transports and stop must not leave the worker waiting for timeout.
  const stop=new AbortController();
  const waiting=runKnowledgeStage('价值审查',()=>new Promise(()=>{}),stop.signal,()=>{}, {timeoutMs:10000,maxAttempts:2,backoffMs:1});
  stop.abort();await assert.rejects(waiting);
  console.log('knowledge-timeouts: independent budgets, bounded retries, grounding, resumable review, abort and deduplicated errors passed');
}finally{pipeline.stop();store.close();fs.rmSync(temp,{recursive:true,force:true});}
