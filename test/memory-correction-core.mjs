import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';

const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'memory-correction-core-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const {KnowledgeStore}=await import(pathToFileURL(compile('main/memory/knowledgeStore.ts')));
const {knowledgeActivity}=await import(pathToFileURL(compile('main/memory/knowledgeActivity.ts')));
const {CuratorQueue}=await import(pathToFileURL(compile('main/memory/curator/queue.ts')));
const {MemoryCuratorRuntime}=await import(pathToFileURL(compile('main/memory/curator/runtime.ts')));
const {createCuratorTools}=await import(pathToFileURL(compile('main/memory/curator/tools.ts')));
const {formatCuratorCandidates}=await import(pathToFileURL(compile('main/memory/curator/prompt.ts')));
const hash=s=>createHash('sha256').update(s).digest('hex');
const source='真实运行发现Linux Wayland未获得窗口坐标，现有方案只在Windows通过。原始来源标记不应从status泄露';
const lesson={kind:'reusable_lesson',summary:'窗口定位在已验证的平台有效',problem:'不同桌面协议行为不同',action:'使用宿主窗口适配器',rationale:'对应平台真实运行验证',applicability:['桌面应用'],exceptions:[],expectedFutureUse:'按平台选择窗口策略'};
const corrected={...lesson,summary:'窗口定位目前仅在Windows验证有效',applicability:['Windows桌面应用'],exceptions:['Linux Wayland未验证有效']};
let seq=0,now=100;
let store=new KnowledgeStore(path.join(temp,'knowledge'));
let queue=new CuratorQueue(temp,path.join(temp,'queue'),()=>now);
const runtimes=[];
const evidence=()=>[{id:`host:${++seq}`,source:'host-runtime',eventTime:now,verification:'unverified',observation:'tool_output',contentHash:hash(source),excerpt:source}];
const ctx=(correction,extra={})=>({namespace:'worker',origin:'worker',sourceText:source,evidence:evidence(),correction,now,...extra});
const input=(extra={})=>{const id=`candidate:${++seq}`;return {operationId:`memory:${id}`,candidateId:id,policyVersion:'correction-test',decision:'save',draft:lesson,sourceQuote:source,reason:'来自原始观察的审核结论',reviewedDeletionIds:[],deletionComparisons:[],...extra};};
const seed=()=>store.commitCuratorDecision(input(),ctx(undefined,{now:now-86400001})).record;
const correction=r=>({memoryId:r.id,revision:r.revision,problem:'平台条件过宽',evidence:'运行输出中的Wayland定位结果',suggestion:'收窄Windows条件'});
const request=(r,extra={})=>({id:`request:${++seq}`,eventId:`event:${seq}`,namespace:'worker',origin:'worker',text:'复核窗口平台条件',sourceText:source,evidence:[{id:'same-evidence',source:'host-runtime',eventTime:1,verification:'unverified',observation:'tool_output',contentHash:hash(source),excerpt:source}],createdAt:now,correction:correction(r),requesterSessionId:'requester',...extra});
const current=id=>store.list().records.find(r=>r.id===id);
const normalized=v=>JSON.parse(JSON.stringify(v));
try{
  const old=seed(), bound=correction(old), context=ctx(bound);
  const edit=input({decision:'correct',draft:corrected,targetId:old.id,targetRevision:old.revision});
  for(const decision of ['save','duplicate','history','delete','restore','supersede']){
    assert.throws(()=>store.commitCuratorDecision({...edit,...input(),decision},context),/纠错请求只能/);
  }
  assert.throws(()=>store.commitCuratorDecision({...edit,targetId:'substituted'},context),/原始ID和版本/);
  assert.throws(()=>store.commitCuratorDecision(edit,ctx()),/宿主绑定/);
  assert.throws(()=>store.commitCuratorDecision(edit,ctx(bound,{evidence:[{id:'claim-only',source:'memory.correct',eventTime:now,verification:'test'}]})),/原始反证/);
  assert.equal(current(old.id).revision,old.revision,'unlocated evidence levels and the task model hint cannot mutate the target');
  const changed=store.commitCuratorDecision(edit,context);
  assert.equal(changed.disposition,'updated');assert.equal(changed.record.id,old.id);assert.equal(changed.record.revision,old.revision+1);
  assert.equal(changed.record.userManaged,false);assert.deepEqual(changed.record.applicability,corrected.applicability,'reviewed narrowing is allowed without exact boundary equality');
  assert.equal(changed.targetId,old.id);assert.equal(changed.targetRevision,old.revision);
  assert.equal(store.search({query:'Windows'}).find(hit=>hit.record.id===old.id)?.record.revision,changed.record.revision,'correction immediately reindexes and recalls its new current revision');
  const activity=knowledgeActivity([store],now);
  assert.equal(activity.todayActivations,1,'a correction activates a new current version even if original admission was yesterday');
  assert.equal(activity.kindCounts24h.auto_admitted,1,'correction contributes to automatic activation counts');
  assert(activity.items.some(event=>event.entryRef===old.id&&event.ts===now&&event.kind==='auto_admitted'),'correction appears in the ledger activity feed');
  assert.equal(store.commitCuratorDecision(edit,context).replayed,true);
  assert.throws(()=>store.commitCuratorDecision({...edit,...input(),decision:'correct',draft:corrected},ctx(bound)),/已变化/,'a second stale request must not replace the new revision');
  assert.equal(store.list().records.length,1,'same-ID corrections do not create a second knowledge record');

  const user=store.revise(changed.record.id,changed.record.revision,corrected),userBound=correction(user);
  const proposalDraft={...corrected,summary:'仅在Windows已授权窗口定位时使用',searchKeys:['窗口定位']};
  const proposalInput=input({decision:'correct',draft:proposalDraft,targetId:user.id,targetRevision:user.revision});
  const proposal=store.commitCuratorDecision(proposalInput,ctx(userBound));
  assert.equal(proposal.disposition,'needs_user');assert.deepEqual(proposal.affected,[]);
  assert.equal(proposal.proposedCorrection.decision,'correct');assert.equal(proposal.proposedCorrection.draft.summary,proposalDraft.summary);
  assert.deepEqual(current(user.id),normalized(user),'user-managed content, evidence, status and revision remain untouched');
  const suspendProposal=store.commitCuratorDecision(input({decision:'suspend',draft:corrected,targetId:user.id,targetRevision:user.revision}),ctx(userBound));
  assert.equal(suspendProposal.disposition,'needs_user');assert.equal(suspendProposal.proposedCorrection.decision,'suspend');
  assert.deepEqual(current(user.id),normalized(user));
  const userOp=proposalInput.candidateId;
  store.close();store=new KnowledgeStore(path.join(temp,'knowledge'));
  assert.equal(store.curatorReceipt(userOp).proposedCorrection.draft.summary,proposalDraft.summary,'protected-record proposal survives restart');
  assert.deepEqual(current(user.id),normalized(user));

  const pref={kind:'user_preference',summary:'报告先给结论',applicability:[]};
  const initialUserText='报告先给结论';
  const prefOld=store.commitCuratorDecision(input({draft:pref,sourceQuote:initialUserText}),ctx(undefined,{origin:'user',sourceText:initialUserText,userText:initialUserText})).record;
  const userText='更正报告偏好，改为先给结论和验证范围';
  const prefResult=store.commitCuratorDecision(input({decision:'correct',draft:{...pref,summary:'报告先给结论和验证范围'},sourceQuote:userText,targetId:prefOld.id,targetRevision:prefOld.revision}),ctx(correction(prefOld),{sourceText:userText,userText,evidence:[{id:'bound-user',source:'host-turn',eventTime:now,verification:'unverified',observation:'user_input'}]}));
  assert.equal(prefResult.disposition,'updated','actual user correction can update preference even when producer origin is worker');
  assert.equal(prefResult.record.origin,'user');
  const negative='不要更正报告偏好';
  assert.throws(()=>store.commitCuratorDecision(input({decision:'correct',draft:pref,sourceQuote:negative,targetId:prefResult.record.id,targetRevision:prefResult.record.revision}),ctx(correction(prefResult.record),{sourceText:negative,userText:negative,evidence:[{id:'negative-user',source:'host-turn',eventTime:now,verification:'unverified',observation:'user_input'}]})),/必须由用户表达/);

  const baselineDraft={...lesson,summary:'宿主坐标策略原有适用性'};
  const policyOriginal=store.commitCuratorDecision(input({policyVersion:'baseline-policy',draft:baselineDraft}),ctx()).record;
  const policyCorrected=store.commitCuratorDecision(input({policyVersion:'failed-correction-policy',decision:'correct',draft:{...baselineDraft,summary:'宿主坐标策略收窄到Windows'},targetId:policyOriginal.id,targetRevision:policyOriginal.revision}),ctx(correction(policyOriginal))).record;
  store.disablePolicy('failed-correction-policy','测试纠错策略故障');
  assert.equal(store.search({query:'宿主坐标策略'}).some(hit=>hit.record.id===policyCorrected.id),false,'a disabled correcting policy suppresses the affected revision');
  const compensation=store.compensatePolicy('failed-correction-policy',{now});
  assert.equal(compensation.incomplete,0);assert.equal(compensation.remaining,0);
  const compensated=current(policyOriginal.id);
  assert.equal(compensated.summary,policyOriginal.summary);assert.equal(compensated.revision,policyCorrected.revision+1);
  assert.equal(store.search({query:'宿主坐标策略'}).find(hit=>hit.record.id===compensated.id)?.record.revision,compensated.revision,'generic curator receipts safely compensate and reindex a same-ID correction');

  const another=store.commitCuratorDecision(input({draft:{...lesson,summary:'桌面窗口坐标由宿主适配'}}),ctx()).record;
  const suspended=store.commitCuratorDecision(input({decision:'suspend',draft:{...lesson,summary:another.summary},targetId:another.id,targetRevision:another.revision}),ctx(correction(another)));
  assert.equal(suspended.disposition,'suspended');assert.equal(suspended.record.status,'needs_revalidation');
  const completedQueue=new CuratorQueue(temp,path.join(temp,'completed-queue'),()=>now);
  try{
    for(const [record,receipt,expected] of [[old,changed,'updated'],[another,suspended,'suspended'],[user,{...proposal,decision:'discard',disposition:'discarded',record:undefined,proposedCorrection:undefined},'rejected']]){
      const candidate=request(record);completedQueue.enqueue(candidate);const [claim]=completedQueue.claim(1,100);
      completedQueue.settle(claim,{...receipt,candidateId:candidate.id});
      const result=completedQueue.correctionStatus(candidate.id,'requester');assert.equal(result.status,expected);assert.equal(result.completed,true);
    }
  }finally{completedQueue.close();}

  // Queue identity includes the full correction, target revision, and authenticated requester.
  const first=request(user);queue.enqueue(first);
  assert.equal(queue.correctionStatus(first.id,'requester').status,'pending');
  assert.throws(()=>queue.correctionStatus(first.id,'other-session'),/不属于/);
  const ordinary={...request(user),correction:undefined};queue.enqueue(ordinary);
  assert.throws(()=>queue.correctionStatus(ordinary.id,'requester'),/不存在/);
  const repeated=request(user);assert.equal(queue.enqueue(repeated).candidateId,first.id);
  const productionRequest=event=>request(user,{id:`production:${event}`,eventId:event,userText:undefined,evidence:[
    {id:event,source:'memory.correct',eventTime:now,verification:'unverified'},
    {id:`${event}:tool:call-${event}`,source:'terminal.run',eventTime:now,verification:'unverified',observation:'tool_output',contentHash:hash(source),excerpt:source}
  ]});
  const productionQueue=new CuratorQueue(temp,path.join(temp,'production-dedup'),()=>now);
  try{
    const productionFirst=productionRequest('base-a');productionQueue.enqueue(productionFirst);
    const productionRepeated=productionRequest('base-b');
    assert.equal(productionQueue.enqueue(productionRepeated).candidateId,productionFirst.id,'memory.correct routing evidence IDs do not break cross-turn dedup of the same original observations without userText');
    assert.equal(productionQueue.enqueue({...productionRequest('base-c'),requesterSessionId:'another-requester'}).queued,true,'original requester ownership remains part of correction information identity');
    const changedObservation=productionRequest('base-d');changedObservation.evidence[1].contentHash=hash('new actual observation');
    assert.equal(productionQueue.enqueue(changedObservation).queued,true,'changing the actual observation still creates a new review');
  }finally{productionQueue.close();}
  assert.equal(queue.enqueue(request(user,{correction:{...correction(user),revision:user.revision+1}})).queued,true);
  assert.equal(queue.enqueue(request(user,{correction:{...correction(user),problem:'不同的问题'}})).queued,true);
  assert.equal(queue.enqueue(request(user,{requesterSessionId:'other-session'})).queued,true);
  assert.throws(()=>queue.enqueue({...first,correction:{...first.correction,revision:first.correction.revision+1}}),/不同内容/);
  const claims=queue.claim(3,100);
  const firstClaim=claims.find(c=>c.candidate.id===first.id);assert(firstClaim);
  assert.equal(queue.correctionStatus(first.id,'requester').status,'running');
  queue.defer(firstClaim,'原始来源稍后可用');assert.equal(queue.correctionStatus(first.id,'requester').status,'deferred');
  now+=31_000;
  const [again]=queue.claim(1,100);assert.equal(again.candidate.id,first.id);
  queue.fail(again,'来源读取失败');assert.equal(queue.correctionStatus(first.id,'requester').status,'failed');
  assert.equal(queue.correctionStatus(first.id,'requester').completed,false);
  queue.retryFailed();
  const [finalClaim]=queue.claim(1,100);assert.equal(finalClaim.candidate.id,first.id);
  queue.settle(finalClaim,{...proposal,candidateId:first.id});
  const status=queue.correctionStatus(first.id,'requester');
  assert.equal(status.status,'needs_user');assert.equal(status.completed,true);assert.equal(status.recordRevision,user.revision);
  assert.equal(status.proposedCorrection.draft.summary,proposalDraft.summary);assert(!JSON.stringify(status).includes('原始来源标记'));
  assert(queue.inspect({state:'attention'}).items.some(i=>i.id===first.id),'protected proposals remain visible in the attention view');
  queue.close();queue=new CuratorQueue(temp,path.join(temp,'queue'),()=>now);
  assert.deepEqual(queue.correctionStatus(first.id,'requester'),status,'queue status and proposal survive restart');

  const pendingCandidate=request(user);
  const runtime=new MemoryCuratorRuntime({root:temp,directory:path.join(temp,'runtime-queue'),workspaceId:'workspace',enabled:()=>false,references:()=>({records:[],deleted:[]}),commit:()=>{throw new Error('read-only status must not commit');}});
  runtimes.push(runtime);runtime.enqueue(pendingCandidate);
  assert.equal(runtime.correctionStatus(pendingCandidate.id,'requester').status,'pending');
  assert.throws(()=>runtime.correctionStatus(pendingCandidate.id,'other'),/不属于/);

  let committed;
  const tools=Object.fromEntries(createCuratorTools({candidates:[request(user)],policyVersion:'p',assertCurrent(){},references:()=>({records:[user],deleted:[]}),readEvidence:()=>({status:'available',text:source}),commit:(candidate,decision)=>{committed=decision;return {...proposal,candidateId:candidate.id};},defer(){}}).map(t=>[t.name,t]));
  const [visible]=await tools.memory_candidates.execute({});
  assert.deepEqual(visible.correction,userBound);assert(formatCuratorCandidates([request(user)]).includes('correction'));
  await tools.memory_search.execute({candidateId:visible.id,query:'窗口'});
  await assert.rejects(()=>tools.memory_commit.execute({candidateId:visible.id,decision:'save',draft:lesson,sourceQuote:source,reason:'不允许换路径'}),/只能更正/);
  await assert.rejects(()=>tools.memory_commit.execute({candidateId:visible.id,decision:'correct',targetId:'other',targetRevision:user.revision,draft:proposalDraft,sourceQuote:source,reason:'不允许换目标'}),/原始ID/);
  await tools.memory_commit.execute({candidateId:visible.id,decision:'correct',targetId:user.id,targetRevision:user.revision,draft:proposalDraft,sourceQuote:source,reason:'条件收窄'});
  assert.equal(committed.decision,'correct');
  console.log('memory-correction-core: bound targets, CAS, observed/user evidence, same-ID narrowing, user protection, durable proposals, ownership, status and dedup passed');
}finally{
  for(const runtime of runtimes)await runtime.stop();
  store.close();queue.close();
  assert(path.resolve(temp).startsWith(scratch+path.sep));fs.rmSync(temp,{recursive:true,force:true});
}
