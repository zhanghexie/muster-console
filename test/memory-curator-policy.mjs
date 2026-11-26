import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});const temp=fs.mkdtempSync(path.join(scratch,'memory-curator-policy-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const policy=await import(pathToFileURL(compile('main/memory/curatorPolicy.ts')));
const {KnowledgeStore,decodeKnowledge}=await import(pathToFileURL(compile('main/memory/knowledgeStore.ts')));
const {KnowledgeSearch}=await import(pathToFileURL(compile('main/memory/knowledgeSearch.ts')));
const databases=[];
const stores=[];
const record=(summary,patch={})=>({schema:1,id:randomUUID(),revision:1,namespace:'worker',kind:'reusable_lesson',status:'active',origin:'worker',summary,
  problem:'重复监听',action:'卸载清理',rationale:'有界夹具观察',applicability:['React'],exceptions:[],expectedFutureUse:'避免重复回调',evidence:[{id:'original',source:'fixture',eventTime:1,verification:'test'}],createdAt:1,updatedAt:1,decisionReason:'fixture',history:[],...patch});
function fixture(name){
  const file=path.join(temp,`${name}.sqlite`),db=new DatabaseSync(file);databases.push(db);
  db.exec(`CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS versions(id TEXT,revision INTEGER,payload TEXT,PRIMARY KEY(id,revision));
    CREATE TABLE IF NOT EXISTS curator_receipts(operation_id TEXT PRIMARY KEY,signature TEXT,receipt TEXT,before_json TEXT,after_json TEXT);
    CREATE TABLE IF NOT EXISTS knowledge_deleted(id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
  policy.ensureCuratorPolicySchema(db);
  const get=id=>{const row=db.prepare('SELECT payload FROM records WHERE id=?').get(id);return row?JSON.parse(row.payload):undefined;};
  const put=value=>{const old=get(value.id);if(old)db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?)').run(old.id,old.revision,JSON.stringify(old));db.prepare('INSERT OR REPLACE INTO records VALUES(?,?)').run(value.id,JSON.stringify(value));};
  const operation=(id,before,after,version='bad')=>{for(const value of after)put(value);db.prepare('INSERT INTO curator_receipts VALUES(?,?,?,?,?)').run(id,'fixture',JSON.stringify({operationId:id,candidateId:id,policyVersion:version,decision:'supersede',affected:after.map(r=>({id:r.id,revision:r.revision})),reason:'fixture',at:1}),JSON.stringify(before),JSON.stringify(after));};
  const port={db,transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},persist:put,drain(){}};
  return {db,file,get,put,operation,port};
}
try{
  const basic=fixture('basic'),old=record('已有可靠经验'),retired={...old,revision:2,status:'superseded',updatedAt:2},fresh=record('错误策略的新经验'),unrelated=record('用户既有可靠知识',{origin:'user'});
  basic.put(old);basic.put(unrelated);basic.operation('replace',[old],[retired,fresh]);
  const derived=record('其他策略的派生结论',{relations:[{targetId:fresh.id,targetRevision:1,kind:'derived_from',inferred:true}]});basic.operation('later-derived',[],[derived],'good');
  policy.disableCuratorPolicy(basic.db,'bad','错误策略',10);
  assert.equal(policy.isVersionDisabled(basic.db,'bad'),true);assert.equal(policy.policyEnabled(basic.db,'bad'),false);
  assert.equal(policy.curatorPolicyAvailable(basic.db,unrelated),true,'unattributed user knowledge stays usable');
  for(const value of [retired,fresh,derived])assert.equal(policy.curatorPolicyAvailable(basic.db,value),false,'disabled operations and later-policy derivations are unavailable');
  const result=policy.compensateCuratorPolicy(basic.port,'bad',{now:20});
  assert.equal(result.complete,1);assert.equal(result.incomplete,0);assert.equal(result.remaining,0);
  assert.equal(basic.get(old.id).status,'active');assert.equal(basic.get(old.id).revision,3);assert.equal(policy.curatorPolicyAvailable(basic.db,basic.get(old.id)),true);
  assert.equal(basic.get(fresh.id).status,'needs_revalidation');assert.equal(policy.curatorPolicyAvailable(basic.db,basic.get(fresh.id)),false);
  assert.equal(policy.curatorPolicyAvailable(basic.db,derived),false,'a restored source does not validate a derivation of its old bad revision');
  const revisions=[basic.get(old.id).revision,basic.get(fresh.id).revision];
  assert.equal(policy.compensateCuratorPolicy(basic.port,'bad').processed,0);assert.deepEqual([basic.get(old.id).revision,basic.get(fresh.id).revision],revisions,'compensation is idempotent');
  const reopened=new DatabaseSync(basic.file);databases.push(reopened);assert.equal(policy.isVersionDisabled(reopened,'bad'),true);assert.equal(policy.curatorPolicyAvailable(reopened,basic.get(fresh.id)),false,'disabled roots persist across connections');

  const chain=fixture('chain'),created=record('错误新增'),linked={...created,revision:2,evidence:[...created.evidence,{id:'extra',source:'fixture',eventTime:2,verification:'test'}],updatedAt:2};
  chain.operation('save',[],[created]);chain.operation('duplicate',[created],[linked]);policy.disableCuratorPolicy(chain.db,'bad','bad chain');
  const first=policy.compensateCuratorPolicy(chain.port,'bad',{limit:1,now:10});assert.equal(first.remaining,1);
  assert.equal(chain.get(created.id).revision,3);assert.equal(policy.curatorPolicyAvailable(chain.db,chain.get(created.id)),false,'bounded rollback cannot wash an earlier bad save into a safe version');
  const second=policy.compensateCuratorPolicy(chain.port,'bad',{limit:1,now:11});assert.equal(second.remaining,0);assert.equal(second.complete,2);
  assert.equal(chain.get(created.id).status,'needs_revalidation');assert.equal(chain.get(created.id).revision,4);
  assert.equal(policy.curatorPolicyAvailable(chain.db,chain.get(created.id)),false,'the original bad save remains retired');

  const restoreChain=fixture('restore-chain'),base=record('人工已有内容'),step1={...base,revision:2,summary:'错误第一版'},step2={...step1,revision:3,summary:'错误第二版'};
  restoreChain.put(base);restoreChain.operation('change-one',[base],[step1]);restoreChain.operation('change-two',[step1],[step2]);policy.disableCuratorPolicy(restoreChain.db,'bad','two changes');
  policy.compensateCuratorPolicy(restoreChain.port,'bad',{limit:1});assert.equal(policy.curatorPolicyAvailable(restoreChain.db,restoreChain.get(base.id)),false);
  policy.compensateCuratorPolicy(restoreChain.port,'bad',{limit:1});assert.equal(restoreChain.get(base.id).summary,base.summary);assert.equal(restoreChain.get(base.id).revision,5);
  assert.equal(policy.curatorPolicyAvailable(restoreChain.db,restoreChain.get(base.id)),true,'reverse CAS mappings can reach the compatible manual predecessor');
  const priorSafe=restoreChain.get(base.id),futureFault={...priorSafe,revision:priorSafe.revision+1,summary:'更晚的故障策略结果'};
  restoreChain.operation('future-fault',[priorSafe],[futureFault]);
  assert.equal(policy.curatorPolicyAvailable(restoreChain.db,futureFault),false,'an earlier safe marker never hides a later disabled-policy root');

  for(const mutation of ['new-evidence','user-delete']){
    const f=fixture(mutation),a=record('旧经验'),a2={...a,revision:2,status:'superseded'},b=record('故障替代');f.put(a);f.operation('replace',[a],[a2,b]);
    const later={...b,revision:2,status:mutation==='user-delete'?'rejected':'active',evidence:[...b.evidence,{id:'human-later',source:'user',eventTime:3,verification:'user_confirmed'}]};f.put(later);
    if(mutation==='user-delete')f.db.prepare('INSERT INTO knowledge_deleted VALUES(?,?)').run(b.id,JSON.stringify({...later,deletedAt:3}));
    policy.disableCuratorPolicy(f.db,'bad','later edit');const outcome=policy.compensateCuratorPolicy(f.port,'bad');
    assert.equal(outcome.incomplete,1);assert.equal(f.get(a.id).status,'superseded','one conflict prevents partial restoration of the other side');
    assert.equal(f.get(b.id).evidence.some(e=>e.id==='human-later'),true,'later evidence is never overwritten');
    if(mutation==='user-delete'){assert.equal(f.get(b.id).status,'rejected');assert.equal(f.get(b.id).revision,2);assert.ok(f.db.prepare('SELECT 1 FROM knowledge_deleted WHERE id=?').get(b.id));}
    else assert.equal(f.get(b.id).status,'needs_revalidation');
    const revision=f.get(b.id).revision;assert.equal(policy.compensateCuratorPolicy(f.port,'bad').processed,0);assert.equal(f.get(b.id).revision,revision,'incomplete compensation does not loop or reverse user actions');
  }
  const atomic=fixture('atomic'),a=record('原条目'),a2={...a,revision:2,status:'superseded'},b=record('新条目');atomic.put(a);atomic.operation('replace',[a],[a2,b]);policy.disableCuratorPolicy(atomic.db,'bad','atomic test');
  let writes=0;assert.throws(()=>policy.compensateCuratorPolicy({...atomic.port,persist(value,event){if(++writes===2)throw new Error('simulated crash');atomic.port.persist(value,event);}},'bad'),/simulated crash/);
  assert.equal(atomic.get(a.id).revision,2);assert.equal(atomic.get(b.id).revision,1);assert.equal(atomic.db.prepare('SELECT COUNT(*) n FROM curator_policy_compensations').get().n,0,'all sides and compensation receipt roll back together');
  assert.equal(policy.compensateCuratorPolicy(atomic.port,'bad').complete,1,'an interrupted operation resumes safely');
  const late=fixture('projection-crash'),x=record('故障新增');late.operation('save',[],[x]);policy.disableCuratorPolicy(late.db,'bad','flush interruption');
  let drains=0;assert.throws(()=>policy.compensateCuratorPolicy({...late.port,drain(){if(++drains===3)throw new Error('projection interrupted');}},'bad'),/projection interrupted/);
  const settled=late.get(x.id).revision;assert.equal(policy.compensateCuratorPolicy(late.port,'bad').processed,0);assert.equal(late.get(x.id).revision,settled,'a committed compensation is not applied again after publication recovery');
  const restore=fixture('undo-restore'),deleted=record('之前由用户删除',{revision:2,status:'rejected',updatedAt:2}),restored={...deleted,revision:4,status:'active',updatedAt:4};
  restore.operation('restore',[deleted],[restored]);policy.disableCuratorPolicy(restore.db,'bad','faulty restore');
  assert.equal(policy.compensateCuratorPolicy(restore.port,'bad').complete,1);assert.equal(restore.get(deleted.id).status,'rejected');
  assert.ok(restore.db.prepare('SELECT 1 FROM knowledge_deleted WHERE id=?').get(deleted.id),'undoing a restore reinstates its prior deletion rather than leaving an unguarded rejected record');
  // Real store wiring must revalidate lexical results before async delivery.
  const assetDirectory=path.join(temp,'store-assets');let store=new KnowledgeStore(assetDirectory);stores.push(store);
  const quote='挂载卸载原始测试确认取消订阅后监听器恢复初始数量。';let seq=0;
  const ctx=()=>({namespace:'worker',origin:'worker',sourceText:quote,evidence:[{id:`observed:${++seq}`,source:'test-result',eventTime:1,verification:'test'}]});
  const draft={kind:'reusable_lesson',summary:'策略回归：卸载清理订阅',problem:'重复监听',action:'卸载取消订阅',rationale:quote,applicability:['React'],exceptions:[],expectedFutureUse:'避免重复回调'};
  const save=extra=>({operationId:`save:${++seq}`,candidateId:`candidate:${seq}`,policyVersion:'store-bad',decision:'save',draft,sourceQuote:quote,reason:'宿主证据支持这条特定经验',
    reviewedDeletionIds:store.deletedKnowledge({namespace:'worker'}).map(item=>item.id),deletionComparisons:store.deletedKnowledge({namespace:'worker'}).map(item=>({id:item.id,equivalent:false})),...extra});
  const saved=store.commitCuratorDecision(save(),ctx()).record;
  const engine=new KnowledgeSearch(store),input={query:'卸载清理订阅',namespace:'worker',conditions:['React']};
  assert.ok(store.search(input).some(hit=>hit.record.id===saved.id));
  const pendingSearch=engine.search(input);
  store.disablePolicy('store-bad','夹具发现错误策略');
  assert.equal(store.list().active,0);assert.ok(store.list().policySuppressedIds.includes(saved.id),'UI counts do not label suppressed yet uncompensated records as active');
  assert.deepEqual(await pendingSearch,[],'late search results cannot return disabled-policy records');
  assert.deepEqual(store.search(input),[],'direct lexical recall observes the same persistent suppression');
  assert.throws(()=>store.commitCuratorDecision(save({draft:{...draft,summary:'迟到的自动写'}}),ctx()),/策略已停用/);
  const compensation=store.compensatePolicy('store-bad');assert.equal(compensation.complete,1);
  const compensated=store.list().records.find(item=>item.id===saved.id);
  assert.equal(compensated.status,'needs_revalidation');
  assert.equal(decodeKnowledge(fs.readFileSync(path.join(store.assetsDir,`${saved.id}.md`),'utf8')).revision,compensated.revision,'compensation publishes the same revision through the real outbox');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,0);
  const removed=store.deleteKnowledge(compensated.id,compensated.revision),restoreText='恢复这条订阅清理记忆';
  assert.throws(()=>store.commitCuratorDecision(save({policyVersion:'replacement-policy',decision:'restore',draft:undefined,sourceQuote:restoreText,targetId:removed.id,targetRevision:removed.revision}),
    {namespace:'worker',origin:'user',sourceText:restoreText,userText:restoreText,evidence:[{id:'restore-user',source:'memory-curator-user',eventTime:1,verification:'user_confirmed'}]}),/受已停用策略影响/,'a new policy cannot report a blocked old record as restored and active');
  const rule={kind:'stable_constraint',summary:'交付前检查回归用例',applicability:[]};
  const user={namespace:'worker',origin:'user',explicit:true,sourceText:'以后交付前检查回归用例',userText:'以后交付前检查回归用例',evidence:[{id:'user-rule',source:'memory-curator-user',eventTime:1,verification:'user_confirmed'}]};
  const original=store.submit(rule,user).record;
  store.commitCuratorDecision(save({policyVersion:'constraint-bad',decision:'suspend',draft:rule,sourceQuote:'交付前检查回归用例',targetId:original.id,targetRevision:original.revision}),user);
  store.disablePolicy('constraint-bad','撤回错误暂停');assert.equal(store.core('worker'),'');
  store.compensatePolicy('constraint-bad');assert.match(store.core('worker'),/交付前检查/,'compatible pre-policy user constraints resume core injection');
  engine.close();store.close();stores.pop();store=new KnowledgeStore(assetDirectory);stores.push(store);
  assert.deepEqual(store.search(input),[],'policy suppression and projection remain coherent after reopening');
  assert.match(store.core('worker'),/交付前检查/);assert.equal(store.compensatePolicy('store-bad').processed,0);
  console.log('memory-curator-policy: persistent disable, derived filtering, bounded reverse CAS, real store/core/search/outbox/reopen, deletion/new-evidence preservation and crash recovery passed');
}finally{
  for(const store of stores)store.close();
  for(const db of databases)db.close();const relative=path.relative(scratch,temp);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))fs.rmSync(temp,{recursive:true,force:true});
}
