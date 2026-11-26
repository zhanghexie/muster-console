import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
fs.mkdirSync('.tmp',{recursive:true});
const temp=fs.mkdtempSync(path.resolve('.tmp/knowledge-pipeline-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const {KnowledgeStore}=await import(pathToFileURL(compile('main/memory/knowledgeStore.ts')));
const {KnowledgePipeline}=await import(pathToFileURL(compile('main/memory/knowledgePipeline.ts')));
const store=new KnowledgeStore(path.join(temp,'assets'));
const pipeline=new KnowledgePipeline(store);
const event=(id,text='用户要求初始化仓库并编写文档')=>({id,text,namespace:'worker',origin:'worker',evidence:{id,source:'session',eventTime:Date.now(),verification:'unverified'},repoKey:'repoA',taskId:'task1'});
try {
  let calls=0;
  const empty=async()=>{calls++;return '{"records":[]}';};
  assert.equal((await pipeline.run(empty)).processed,0); assert.equal(calls,0,'empty sweep does not call model');
  const old=event('old'); old.evidence.eventTime=store.startedAt-1;
  assert.equal(pipeline.enqueue(old),false,'old transcripts are never reimported after cutover');
  const input=event('one'); pipeline.enqueue(input);
  assert.equal(pipeline.enqueue(input),false);
  assert.throws(()=>pipeline.enqueue({...input,text:'different'}),/不同内容/);
  await Promise.all([pipeline.run(empty),pipeline.run(empty)]);
  assert.equal(calls,1,'concurrent callers share one execution');
  assert.equal((await pipeline.run(empty)).processed,0); assert.equal(calls,1,'zero-output is a terminal result');
  const two=event('two'); pipeline.enqueue(two);
  const failed=await pipeline.run(async()=>'{bad json');
  assert.equal(failed.errors.length,1);
  assert.equal(pipeline.pending(),0,'failed work is visible and does not spin forever');
  assert.equal(pipeline.retryFailed(),1);
  const facts=await pipeline.run(async()=>JSON.stringify({records:[{kind:'task_fact',summary:'初始化仓库',applicability:[],repoKey:'forged',branch:'forged',origin:'user',verification:'runtime'}]}));
  assert.equal(facts.history,1);
  const record=store.list().records[0];
  assert.equal(record.repoKey,'repoA'); assert.equal(record.branch,undefined);
  assert.equal(record.origin,'worker'); assert.equal(record.evidence[0].verification,'unverified');
  pipeline.enqueue(event('three'));
  // Kill a model operation's claim before publication: its late result cannot write.
  const lost=await pipeline.run(async()=>{
    store.db.prepare("UPDATE source_events SET claim='other' WHERE id='three'").run();
    return JSON.stringify({records:[{kind:'task_fact',summary:'过期结果',applicability:[]}]});
  });
  assert.equal(lost.errors.length,1);
  assert.equal(store.list().records.length,1);
  console.log('knowledge-pipeline: incremental, singleflight, terminal empty, retry and stale-claim tests passed');
} finally {store.close();fs.rmSync(temp,{recursive:true,force:true});}
