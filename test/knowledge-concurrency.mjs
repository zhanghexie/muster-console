import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
fs.mkdirSync('.tmp',{recursive:true});const temp=fs.mkdtempSync(path.resolve('.tmp/knowledge-concurrent-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const module=pathToFileURL(compile('main/memory/knowledgeStore.ts')).href;
const pipelineModule=pathToFileURL(compile('main/memory/knowledgePipeline.ts')).href;
const {KnowledgeStore}=await import(module);
const directory=path.join(temp,'assets');new KnowledgeStore(directory).close();
const worker=path.join(temp,'worker.mjs');
fs.writeFileSync(worker,`import {KnowledgeStore} from ${JSON.stringify(module)};
import {KnowledgePipeline} from ${JSON.stringify(pipelineModule)};
const store=new KnowledgeStore(process.argv[2]);
const id=process.argv[3];
try{
 if(process.argv[4]==='queue'){
  const pipeline=new KnowledgePipeline(store);
  const result=await pipeline.run(async()=>{await new Promise(r=>setTimeout(r,100));return '{"records":[]}';});
  console.log(JSON.stringify(result));
 }else{
  const record=store.submit({kind:'reusable_lesson',summary:'并发审批核对版本',problem:'旧提案覆盖修改',action:'提交时比较revision',rationale:'并发回归通过',applicability:['延迟审批'],expectedFutureUse:'避免覆盖'},
   {namespace:'worker',origin:'worker',evidence:[{id,source:'test',eventTime:Date.now(),verification:'test'}]});
  console.log(record.disposition);
 }
}finally{store.close();}`);
function run(id,mode='write'){return new Promise((resolve,reject)=>{const proc=spawn(process.execPath,[worker,directory,id,mode],{stdio:['ignore','pipe','pipe']});let out='',err='';proc.stdout.on('data',d=>out+=d);proc.stderr.on('data',d=>err+=d);proc.on('error',reject);proc.on('exit',code=>code===0?resolve(out):reject(new Error(err||out)));});}
try{
 const outcomes=await Promise.all([run('event-a'),run('event-b')]);
 let store=new KnowledgeStore(directory);
 assert.equal(store.list().records.length,1);assert.equal(store.list().records[0].evidence.length,2);
 assert.ok(outcomes.some(x=>x.includes('duplicate')));
 const {KnowledgePipeline}=await import(pipelineModule);const queue=new KnowledgePipeline(store);
 queue.enqueue({id:'one-event',text:'本次初始化项目',namespace:'worker',origin:'worker',evidence:{id:'one-event',source:'test',eventTime:Date.now(),verification:'unverified'}});store.close();
 const executions=await Promise.all([run('a','queue'),run('b','queue')]);
 assert.equal(executions.map(JSON.parse).reduce((n,r)=>n+r.processed,0),1,'cross-process claim executes once');
 store=new KnowledgeStore(directory);assert.equal(store.db.prepare("SELECT state FROM source_events WHERE id='one-event'").get().state,'done');store.close();
 console.log('knowledge-concurrency: real two-process dedup, evidence merge and event lease passed');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
