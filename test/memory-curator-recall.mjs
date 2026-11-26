import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';

const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'memory-curator-recall-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const load=async file=>import(pathToFileURL(compile(file)));
const {KnowledgeStore}=await load('main/memory/knowledgeStore.ts');
const {KnowledgeSearch}=await load('main/memory/knowledgeSearch.ts');
const {formatKnowledgeHits,knowledgeBranchNotice}=await load('main/memory/knowledgeRecall.ts');
const {applyLocaleSetting}=await load('shared/i18n/index.ts');
const {createCuratorTools}=await load('main/memory/curator/tools.ts');
const {MemoryService}=await load('main/memory/service.ts');
const {setUserProfileFilePath}=await load('main/memory/userProfile.ts');
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const stores=[],searches=[];
try{
  const store=new KnowledgeStore(path.join(temp,'assets'));stores.push(store);
  const engine=new KnowledgeSearch(store);searches.push(engine);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_vectors'").get(),undefined,'new knowledge stores do not create vector tables');
  const source='隔离测试结果显示重复挂载后监听器数量持续增长，卸载时取消订阅后恢复基线。';
  const candidate={id:'candidate',eventId:'turn',namespace:'worker',origin:'worker',
    text:'保存订阅清理经验',searchKeys:['listenerzombie765'],sourceText:source,
    repoKey:'repo',branch:'feature/a',createdAt:1,
    evidence:[{id:'evidence',source:'test',eventTime:1,verification:'test'}]};
  const duplicate={...candidate,id:'duplicate',eventId:'turn-2',searchKeys:['repeatlistener766'],
    evidence:[{id:'evidence-2',source:'test',eventTime:2,verification:'test'}]};
  const scope={namespace:'worker',repoKey:'repo',branch:'feature/a'};
  const tools=Object.fromEntries(createCuratorTools({candidates:[candidate,duplicate],policyVersion:'test-policy',
    assertCurrent(){},references:(_candidate,query)=>store.curatorReferences(query,scope),
    readEvidence:()=>({status:'available',text:source}),defer(){},
    commit:(active,input)=>store.commitCuratorDecision(input,{...scope,origin:'worker',sourceText:source,evidence:active.evidence})
  }).map(tool=>[tool.name,tool]));
  const candidates=await tools.memory_candidates.execute({});
  assert.deepEqual(candidates[0].searchKeys,['listenerzombie765']);
  await tools.memory_search.execute({candidateId:candidate.id,query:'订阅清理'});
  const draft={kind:'reusable_lesson',summary:'组件卸载前注销事件订阅',problem:'重复挂载会多次接收通知',
    action:'执行清理函数',rationale:'挂载卸载测试确认监听器恢复基线',applicability:['React'],exceptions:[],
    expectedFutureUse:'避免重复回调',searchKeys:['unmountcleanup764']};
  const receipt=await tools.memory_commit.execute({candidateId:candidate.id,decision:'save',draft,sourceQuote:source,reason:'测试证据支持',deletionComparisons:[]});
  assert.equal(receipt.disposition,'active');
  assert.deepEqual(receipt.record.searchKeys,['listenerzombie765','unmountcleanup764']);
  await tools.memory_search.execute({candidateId:duplicate.id,query:'组件卸载'});
  const merged=await tools.memory_commit.execute({candidateId:duplicate.id,decision:'duplicate',draft,sourceQuote:source,reason:'同义经验',
    targetId:receipt.record.id,targetRevision:receipt.record.revision,deletionComparisons:[]});
  assert.equal(merged.record.id,receipt.record.id);
  assert.ok(merged.record.searchKeys.includes('listenerzombie765')&&merged.record.searchKeys.includes('repeatlistener766'));
  assert.equal((await engine.search({query:'repeatlistener766',repoKey:'repo',branch:'main'}))[0].record.id,receipt.record.id,'duplicate candidates add their keywords to the existing index');
  const input={query:'listenerzombie765',namespace:'worker',repoKey:'repo',branch:'main'};
  const hits=await engine.search(input);
  assert.equal(hits.length,1,'a keyword absent from the body is independently searchable');
  assert.equal(hits[0].record.branch,'feature/a','recall must not filter by branch');
  assert.match(formatKnowledgeHits(hits,1600,'main'),/记录于 feature\/a 分支，当前为 main 分支/);
  assert.match(formatKnowledgeHits(hits,1600,undefined),/当前分支未知/);
  applyLocaleSetting('en');
  assert.match(knowledgeBranchNotice(hits[0].record,'main'),/recorded on branch feature\/a; the current branch is main/);
  assert.match(knowledgeBranchNotice(hits[0].record,undefined),/current branch is unknown/);
  applyLocaleSetting('zh-CN');
  assert.equal(knowledgeBranchNotice(hits[0].record,'feature/a'),undefined);
  assert.equal(knowledgeBranchNotice({branch:undefined},'main'),undefined);
  assert.deepEqual(await engine.search({...input,repoKey:'other'}),[],'repository scope remains enforced');
  assert.deepEqual(await engine.search({...input,namespace:'scheduler'}),[],'namespace scope remains enforced');
  const stale=hits[0];
  store.decide(merged.record.id,merged.record.revision,'archive');
  assert.deepEqual(engine.current([stale],input),[],'retired records cannot be returned after revalidation');
  assert.deepEqual(await engine.search(input),[]);

  // A worker result must be revalidated after awaiting a separate profile search.
  const worker=new KnowledgeStore(path.join(temp,'worker')),profile=new KnowledgeStore(path.join(temp,'profile'));
  stores.push(worker,profile);
  const workerSearch=new KnowledgeSearch(worker),profileSearch=new KnowledgeSearch(profile);searches.push(workerSearch,profileSearch);
  const workerRecord=worker.submit({kind:'stable_constraint',summary:'始终报告实际验证边界',applicability:[],repoKey:'repo'},
    {namespace:'worker',origin:'user',explicit:true,evidence:[{id:'worker',source:'fixture',eventTime:1,verification:'user_confirmed'}]}).record;
  const workerHits=worker.search({query:'验证边界',namespace:'worker',repoKey:'repo'});
  const entered=deferred(),result=deferred();
  const fake={knowledgeSearches:new Map([[worker,workerSearch],[profile,profileSearch]]),
    knowledge(_root,namespace){return namespace==='profile'?profile:worker;},
    async queryKnowledge(_root,query){if(query.namespace==='profile'){entered.resolve();return result.promise;}return workerHits;}};
  setUserProfileFilePath(path.join(temp,'profile-home'));
  const recall=MemoryService.prototype.recallKnowledge.call(fake,temp,'验证边界','worker',{root:'repo',branch:'main'});
  await entered.promise;worker.decide(workerRecord.id,workerRecord.revision,'archive');result.resolve([]);
  assert.equal(await recall,'','profile await must not return a stale worker record');

  // Reproduce the user-visible failure through the actual curator search and commit tools.
  const damagedDir=path.join(temp,'damaged');let damaged=new KnowledgeStore(damagedDir);
  const missing=damaged.submit({kind:'stable_constraint',summary:'交付前保留原始依据',applicability:[]},
    {namespace:'worker',origin:'user',explicit:true,evidence:[{id:'old',source:'fixture',eventTime:1,verification:'user_confirmed'}]}).record;
  damaged.close();fs.unlinkSync(path.join(damagedDir,'entries',`${missing.id}.md`));
  damaged=new KnowledgeStore(damagedDir);stores.push(damaged);
  const fresh={...candidate,id:'after-damage',eventId:'fresh',repoKey:undefined,branch:undefined,evidence:[{id:'fresh',source:'test',eventTime:1,verification:'test'}]};
  const damagedTools=Object.fromEntries(createCuratorTools({candidates:[fresh],policyVersion:'test-policy',assertCurrent(){},
    references:(_candidate,query)=>damaged.curatorReferences(query,{namespace:'worker'}),readEvidence:()=>({status:'available',text:source}),defer(){},
    commit:(active,input)=>damaged.commitCuratorDecision(input,{namespace:'worker',origin:'worker',sourceText:source,evidence:active.evidence})
  }).map(tool=>[tool.name,tool]));
  const refs=await damagedTools.memory_search.execute({candidateId:fresh.id,query:'原始依据'});
  assert.ok(refs.records.some(r=>r.id===missing.id),'comparison still sees the last committed record');
  const afterDamage=await damagedTools.memory_commit.execute({candidateId:fresh.id,decision:'save',draft,sourceQuote:source,reason:'独立证据支持',deletionComparisons:[]});
  assert.equal(afterDamage.disposition,'active','a separate candidate saves with its real transaction receipt');
  assert.equal(fs.existsSync(path.join(damagedDir,'entries',`${missing.id}.md`)),false,'the missing source is not recreated by an unrelated commit');
  console.log('memory-curator-recall: candidate keywords, lexical index, branch notices, scope and stale-result checks passed');
}finally{
  setUserProfileFilePath(null);for(const search of searches)search.close();for(const store of stores)store.close();
  const relative=path.relative(scratch,temp);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))fs.rmSync(temp,{recursive:true,force:true});
}
