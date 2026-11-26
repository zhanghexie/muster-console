import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const base=path.resolve('.tmp');fs.mkdirSync(base,{recursive:true});
const directory=fs.mkdtempSync(path.join(base,'curator-inspection-'));
let queue,runtime;
try {
  const compile=createSharedCompiler(process.cwd(),path.join(directory,'compiled'));
  const {CuratorQueue}=await import(pathToFileURL(compile('main/memory/curator/queue.ts')));
  const {MemoryCuratorRuntime}=await import(pathToFileURL(compile('main/memory/curator/runtime.ts')));
  const day=24*60*60*1000;let now=1000;
  const queueDirectory=path.join(directory,'queue');
  queue=new CuratorQueue(directory,queueDirectory,()=>now);
  for(let i=0;i<6;i++)queue.enqueue({id:`c${i}`,eventId:`e${i}`,namespace:'worker',origin:'worker',text:`候选内容 ${i}`,sourceText:'private-original-not-for-list',createdAt:i+1,
    evidence:[{id:`evidence-${i}`,source:'host-observation',eventTime:1,verification:'unverified'}]});
  const [running]=queue.claim(1,10000);
  const [deferred]=queue.claim(1,10000);queue.defer(deferred,'证据暂时不可用',70000);
  const [failed]=queue.claim(1,10000);queue.fail(failed,'draft.action: 缺少具体方法');
  const [done]=queue.claim(1,10000);queue.settle(done,{disposition:'active',reason:'原始依据与适用条件完整',record:{id:'knowledge-result'}});
  const before=queue.db.prepare('SELECT id,state,attempts,claim,lease_until FROM candidates ORDER BY id').all();
  const first=queue.inspect({limit:2});
  assert.equal(first.total,6);assert.equal(first.items.length,2);assert.equal(first.items[0].state,'failed');
  assert.equal(first.items[0].error,'draft.action: 缺少具体方法');assert.equal(first.items[1].id,running.candidate.id);
  assert.equal(queue.inspect({state:'queued'}).total,4);
  assert.equal(queue.inspect({state:'attention'}).total,5,'attention includes failed records as well as pending work');
  assert.equal(first.items.every(item=>item.archived===false),true);
  assert.equal(queue.inspect({state:'pending'}).total,2);
  assert.equal(queue.inspect({state:'deferred'}).items[0].availableAt,70000);
  const completed=queue.inspect({state:'done'}).items[0];
  assert.equal(completed.result.recordId,'knowledge-result');assert.equal(completed.evidenceCount,1);
  assert.equal(completed.result.reason,'原始依据与适用条件完整');
  assert.equal(queue.inspect({limit:2,offset:2}).items.length,2);
  assert.equal(queue.inspect({offset:999}).items.length,0);
  assert.equal(JSON.stringify(queue.inspect({})).includes('private-original-not-for-list'),false,'queue lists never disclose raw source or claim tokens');
  assert.deepEqual(queue.db.prepare('SELECT id,state,attempts,claim,lease_until FROM candidates ORDER BY id').all(),before,'read-only inspection never claims, retries or changes queue state');
  for(const input of [{state:'invented'},{visibility:'deleted'},{limit:51},{limit:0},{offset:-1},{offset:0.5},null,[],true,'visible'])assert.throws(()=>queue.inspect(input),/无效/);
  const business=()=>queue.db.prepare('SELECT id,payload,state,attempts,claim,lease_until,error,result,created_at,available_at,defer_single FROM candidates ORDER BY id').all();
  const original=business();
  assert.equal(queue.setArchived(done.candidate.id,false),false,'setting the current visibility is an idempotent success');
  assert.equal(queue.setArchived(failed.candidate.id,true),true);
  assert.equal(queue.setArchived(failed.candidate.id,true),false);
  assert.equal(queue.inspect({state:'failed'}).total,0);
  assert.equal(queue.inspect({state:'attention'}).total,4);
  assert.equal(queue.inspect({state:'failed',visibility:'all'}).items[0].archived,true);
  assert.equal(queue.inspect({visibility:'archived'}).total,1);
  assert.deepEqual(queue.counts(),{pending:4,failed:0});
  assert.equal(queue.retryFailed(),0,'archived failures do not reenter processing when retrying active failures');
  assert.deepEqual(business(),original,'archiving never changes attempts, decisions, sources or processing state');
  assert.equal(queue.setArchived(failed.candidate.id,false),true);
  assert.deepEqual(queue.counts(),{pending:4,failed:1});
  assert.deepEqual(business(),original,'restoring a failed record does not itself retry it');
  assert.equal(queue.setArchived(failed.candidate.id,true),true);
  for(const state of ['pending','running','deferred']){
    const active=queue.inspect({state}).items[0];
    for(const archived of [true,false])assert.throws(()=>queue.setArchived(active.id,archived),/正在处理/);
  }
  assert.throws(()=>queue.setArchived('missing',true),/不存在/);
  for(const args of [['',true],['c1','true'],[17,true]])assert.throws(()=>queue.setArchived(...args),/无效/);

  now=1000+7*day-1;assert.equal(queue.inspect({state:'done'}).total,1);
  const beforeAutomatic=queue.db.prepare('SELECT * FROM candidates ORDER BY id').all();
  now++;
  assert.equal(queue.inspect({state:'done'}).total,0,'done records leave the visible list at the seven-day boundary');
  assert.equal(queue.inspect({state:'done',visibility:'archived'}).items[0].archived,true);
  assert.equal(queue.inspect({state:'failed',visibility:'archived'}).items[0].id,failed.candidate.id);
  assert.equal(queue.inspect({visibility:'all'}).total,6);
  assert.deepEqual(queue.db.prepare('SELECT * FROM candidates ORDER BY id').all(),beforeAutomatic,'automatic archival is a pure read-time projection');
  assert.equal(queue.setArchived(done.candidate.id,false),true,'an automatically archived completion can be restored');
  const restoredAt=now;
  assert.equal(queue.inspect({state:'done'}).items[0].archived,false);
  assert.equal(queue.db.prepare('SELECT completed_at FROM candidates WHERE id=?').get(done.candidate.id).completed_at,1000,'restoring does not rewrite the actual completion time');
  now=restoredAt+7*day-1;assert.equal(queue.inspect({state:'done'}).total,1,'restoring grants a fresh seven-day visibility window');
  now++;
  assert.equal(queue.inspect({state:'done',visibility:'archived'}).total,1);
  assert.equal(queue.setArchived(done.candidate.id,false),true);
  assert.equal(queue.setArchived(done.candidate.id,true),true,'a fresh completion can also be archived manually');
  queue.close();queue=new CuratorQueue(directory,queueDirectory,()=>now);
  assert.deepEqual(new Set(queue.inspect({visibility:'archived'}).items.map(item=>item.id)),new Set([done.candidate.id,failed.candidate.id]),'manual visibility persists after reopening');
  assert.deepEqual(queue.counts(),{pending:4,failed:0});assert.equal(queue.retryFailed(),0);
  assert.deepEqual(business(),original,'reopening and idempotent schema migration preserve all processing and receipt data');
  queue.close();queue=undefined;

  let models=0;
  runtime=new MemoryCuratorRuntime({workspaceId:'fixture',root:directory,directory:queueDirectory,now:()=>now,
    createSession:async()=>{models++;throw new Error('inspection must not create a model');},references:()=>({records:[],deleted:[]}),commit:()=>{throw new Error('inspection must not commit knowledge');}});
  runtime.inspect({state:'attention'});runtime.snapshot();
  assert.deepEqual(runtime.setArchived(done.candidate.id,false),{changed:true});
  assert.deepEqual(runtime.setArchived(done.candidate.id,false),{changed:false});
  assert.deepEqual(runtime.setArchived(failed.candidate.id,false),{changed:true});
  await new Promise(setImmediate);
  assert.equal(models,0,'opening, archiving and restoring records do not wake Pi or retry failed work');
  assert.equal(runtime.inspect({state:'failed'}).items[0].attempts,1);
  await runtime.stop();runtime=undefined;

  // Upgrade a real pre-archive SQLite schema, including its original receipt and
  // information index. This is not a fixture created by the new constructor.
  const legacyDirectory=path.join(directory,'legacy');fs.mkdirSync(legacyDirectory,{recursive:true});
  const legacyDb=new DatabaseSync(path.join(legacyDirectory,'curator.sqlite'));
  legacyDb.exec(`CREATE TABLE candidates(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,
    state TEXT NOT NULL,claim TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,result TEXT,
    created_at INTEGER NOT NULL,available_at INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'candidate');
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE candidate_information(information_key TEXT PRIMARY KEY,candidate_id TEXT NOT NULL);`);
  const legacyNow=40*day;
  const legacyCandidate=id=>({id,eventId:`event:${id}`,namespace:'worker',origin:'worker',text:`旧候选 ${id}`,sourceText:`原始依据 ${id}`,createdAt:1,
    evidence:[{id:`legacy-evidence:${id}`,source:'host-observation',eventTime:1,verification:'unverified'}]});
  const rows=[
    ['old-done','done',legacyNow-30*day,{disposition:'active',at:legacyNow-8*day}],
    ['recent-done','done',legacyNow-30*day,{disposition:'active',at:legacyNow-day}],
    ['no-time-done','done',legacyNow-8*day,{disposition:'discarded'}],
    ['old-failed','failed',legacyNow-30*day,null],
    ['old-pending','pending',legacyNow-30*day,null]
  ];
  for(const [id,state,createdAt,result] of rows){
    const candidate=legacyCandidate(id),identity={kind:'candidate',eventId:candidate.eventId,namespace:candidate.namespace,origin:candidate.origin,text:candidate.text,explicit:false};
    legacyDb.prepare('INSERT INTO candidates(id,event_id,hash,payload,state,created_at,available_at,attempts,error,result) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id,candidate.eventId,createHash('sha256').update(JSON.stringify(identity)).digest('hex'),JSON.stringify(candidate),state,createdAt,createdAt,1,state==='failed'?'历史失败':null,result?JSON.stringify(result):null);
  }
  legacyDb.prepare('INSERT INTO candidate_information VALUES(?,?)').run('original-dedupe-index','old-done');
  legacyDb.prepare('INSERT INTO meta VALUES(?,?)').run('generation','7');
  const legacyBefore=legacyDb.prepare('SELECT * FROM candidates ORDER BY id').all();legacyDb.close();
  queue=new CuratorQueue(directory,legacyDirectory,()=>legacyNow);
  assert.equal(queue.generation,7);
  assert.equal(queue.inspect({state:'done'}).items[0].id,'recent-done','old completion migration uses receipt time instead of creation or upgrade time');
  assert.deepEqual(new Set(queue.inspect({state:'done',visibility:'archived'}).items.map(item=>item.id)),new Set(['old-done','no-time-done']));
  assert.equal(queue.inspect({state:'failed'}).items[0].archived,false,'old failures do not automatically disappear');
  assert.equal(queue.inspect({state:'attention'}).total,2);
  for(const previous of legacyBefore){const current=queue.db.prepare('SELECT * FROM candidates WHERE id=?').get(previous.id);for(const key of Object.keys(previous))assert.deepEqual(current[key],previous[key],`migration preserves ${previous.id}.${key}`);}
  assert.equal(queue.db.prepare('SELECT candidate_id FROM candidate_information WHERE information_key=?').get('original-dedupe-index').candidate_id,'old-done');
  assert.equal(queue.enqueue({...legacyCandidate('old-done'),id:'new-same-information',eventId:'new-event'}).queued,false,'existing source information remains deduplicated after migration');
  assert.equal(queue.setArchived('old-done',false),true);
  assert.equal(queue.setArchived('old-failed',true),true);
  queue.close();queue=new CuratorQueue(directory,legacyDirectory,()=>legacyNow+1);
  assert.equal(queue.inspect({state:'done'}).items.some(item=>item.id==='old-done'),true,'a restored legacy completion stays visible across reopen');
  assert.equal(queue.inspect({state:'failed',visibility:'archived'}).total,1);assert.equal(queue.retryFailed(),0);
  queue.close();queue=undefined;

  const singleDirectory=path.join(directory,'single');queue=new CuratorQueue(directory,singleDirectory,()=>now);
  for(let index=0;index<3;index++)queue.enqueue({...legacyCandidate(`single-${index}`),sourceText:`单条补试依据 ${index}`});
  const singles=queue.claim(3,1000);assert.equal(singles.length,3);
  for(const claim of singles)queue.defer(claim,'预算延期，下一批单条',now+1000,true);
  queue.close();now+=1000;queue=new CuratorQueue(directory,singleDirectory,()=>now);
  const [single]=queue.claim(3,1000);assert.equal(single.candidate.id,singles[0].candidate.id);
  assert.equal(queue.inspect({state:'running'}).total,1,'budget single-item retry survives reopening');
  queue.requeue(single);assert.equal(queue.claim(3,1000).length,1,'requeue preserves the single-item retry flag');
  console.log('memory-curator-inspection: read-only views, old-schema migration, automatic/manual archival, restart and processing isolation passed');
} finally { await runtime?.stop();queue?.close(); assert(path.resolve(directory).startsWith(base+path.sep));fs.rmSync(directory,{recursive:true,force:true}); }
