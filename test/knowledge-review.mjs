import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
fs.mkdirSync('.tmp',{recursive:true});
const temp=fs.mkdtempSync(path.resolve('.tmp/knowledge-review-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const {reviewKnowledgeDrafts}=await import(pathToFileURL(compile('main/memory/knowledgeReview.ts')));
const {KnowledgeStore}=await import(pathToFileURL(compile('main/memory/knowledgeStore.ts')));
const {KnowledgePipeline}=await import(pathToFileURL(compile('main/memory/knowledgePipeline.ts')));
const store=new KnowledgeStore(path.join(temp,'assets')),pipeline=new KnowledgePipeline(store);
const draft={kind:'reusable_lesson',summary:'订阅应清理',problem:'重复回调',action:'取消订阅',rationale:'卸载测试通过',applicability:['React'],expectedFutureUse:'避免重复事件'};
const event='组件卸载时必须取消订阅，挂载卸载循环测试通过，避免重复回调。';
const decision={index:0,verdict:'keep',sourceQuote:event,reason:'有方法与原始依据'};
const input={event,drafts:[draft],existing:[]};
try {
  assert.equal((await reviewKnowledgeDrafts(async()=>JSON.stringify({decisions:[decision]}),input))[0].verdict,'keep');
  assert.equal((await reviewKnowledgeDrafts(async()=>JSON.stringify({decisions:[{...decision,sourceQuote:'以后都用中文'}]}),{event:'以后都用中文',drafts:[{kind:'user_preference',summary:'使用中文交流',applicability:[]}],existing:[]}))[0].verdict,'keep','short explicit preference is not penalized for brevity');
  for(const bad of [[],[decision,decision],[{...decision,index:1}],[{...decision,sourceQuote:'模型自己编造了非常详细的测试依据'}],[{...decision,verdict:'duplicate',existingId:'fake'}]]) {
    await assert.rejects(()=>reviewKnowledgeDrafts(async()=>JSON.stringify({decisions:bad}),input));
  }
  const enqueue=id=>pipeline.enqueue({id,text:event,namespace:'worker',origin:'worker',evidence:{id,source:'session',eventTime:Date.now(),verification:'unverified'}});
  enqueue('reviewed');let calls=0;
  const outcome=await pipeline.run(async()=>++calls===1?JSON.stringify({records:[draft]}):JSON.stringify({decisions:[decision]}));
  assert.equal(outcome.proposed,1);assert.equal(calls,2);
  assert.equal(store.list().records[0].evidence[0].verification,'unverified','model cannot raise verification level');
  assert.ok(store.checkpoint('review:reviewed'),'review evidence is auditable');
  enqueue('discard');calls=0;
  await pipeline.run(async()=>++calls===1?JSON.stringify({records:[draft]}):JSON.stringify({decisions:[{...decision,verdict:'discard'}]}));
  assert.equal(store.list().records.length,1);
  enqueue('recovered');
  store.db.prepare("UPDATE source_events SET state='running',claim='dead',lease_until=0,prepared=? WHERE id='recovered'").run(JSON.stringify({records:[{...draft,summary:'恢复的合法经验'}]}));
  const recovered=await pipeline.run(async()=>{throw new Error('prepared must not call model again');});
  assert.equal(recovered.proposed,1);assert.equal(recovered.errors.length,0);
  console.log('knowledge-review: original quotes, index integrity, refusal, audit and prepared recovery passed');
} finally {store.close();fs.rmSync(temp,{recursive:true,force:true});}
