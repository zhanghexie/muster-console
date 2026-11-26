import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

// Replace only the model. The candidate, source binding, tools, queue, stores,
// correction and injection below all exercise their real production paths.
const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'user-profile-flow-'));
const root=path.join(temp,'workspace-a'),other=path.join(temp,'workspace-b');
fs.mkdirSync(root,{recursive:true});fs.mkdirSync(other,{recursive:true});
const previous=globalThis.memoryUserProfileFlowModel;
let api,svc,ctx;
try{
  let modelStubLoaded=false;
  const bundle=path.join(temp,'api.cjs');
  await build({stdin:{contents:`
    export {MemoryService} from './src/main/memory/service';
    export {setMemoryService} from './src/main/memory/serviceRef';
    export {setUserProfileFilePath} from './src/main/memory/userProfile';
    export {memoryHost} from './src/main/capabilities/hosts/memory';
    export {memoryCurator,closeMemoryCurator} from './src/main/memory/curatorBindings';
    export {validateProfileSource} from './src/main/memory/profileProvenance';
    export {runAsAgentSession} from './src/main/agent/agentScope';
    export {runWithTurnUserText,runWithExternalMemoryCandidate,runAsHeadlessTurn,markTurnNetworkTaint} from './src/main/agent/turnScope';
  `,resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',plugins:[{
    name:'model-only',setup(b){
      b.onResolve({filter:/^\.\/pi$/},args=>args.importer.replaceAll('\\','/').endsWith('/memory/curator/runtime.ts')?{path:'model',namespace:'fixture-model'}:undefined);
      b.onLoad({filter:/.*/,namespace:'fixture-model'},()=>{modelStubLoaded=true;return {loader:'js',contents:`export function createMemoryCuratorPiFactory(){return async input=>globalThis.memoryUserProfileFlowModel(input);}`};});
    }
  }]});
  assert.equal(modelStubLoaded,true);
  api=createRequire(import.meta.url)(bundle);
  api.setUserProfileFilePath(path.join(temp,'user-data'));
  svc=new api.MemoryService();api.setMemoryService(svc);
  const config={workspaces:[{id:'a',path:root},{id:'b',path:other}],memoryConsolidation:{enabled:true}};
  const session={id:'producer',workspaceId:'a',cwd:root};
  const assistant={id:'assistant-turn',role:'assistant',parts:[]};
  ctx={sessions:{get:id=>id===session.id?session:undefined},agentSessions:{entries:new Map([[session.id,{workspaceId:'a',assistant}]])},
    config:{get:()=>config},getWindow:()=>null,orchestrator:null,pty:{getBufferTail:()=>''},ui:{notify(){}}};
  const profile=svc.knowledge(root,'profile'),worker=svc.knowledge(root,'worker');
  const original='我常用的邮箱是 alice@example.com，手机号是 +86 138 0013 8000。';
  const replacement='我的常用邮箱换成 bob@example.com，手机号仍然是 +86 138 0013 8000。';
  const originalDraft={kind:'user_profile',summary:'常用邮箱 alice@example.com，手机号 +86 138 0013 8000',applicability:[],searchKeys:['常用邮箱','手机号']};
  const replacementDraft={...originalDraft,summary:'常用邮箱 bob@example.com，手机号 +86 138 0013 8000'};
  const preferenceQuote='我喜欢简洁的回答。';
  const preferenceDraft={kind:'user_preference',summary:'偏好简洁回答',applicability:[],searchKeys:['回答偏好']};
  const runs=[];
  globalThis.memoryUserProfileFlowModel=async input=>{
    const tools=Object.fromEntries(input.tools.map(tool=>[tool.name,tool]));
    return {id:'fixture-pi-session',async run(_job,signal){
      input.beforeModelRequest?.();input.onEvent({type:'model-start'});
      for(const candidate of await tools.memory_candidates.execute({},signal)){
        const correcting=!!candidate.correction;
        const quote=correcting?replacement:candidate.text.includes('偏好')?preferenceQuote:original;
        const draft=correcting?replacementDraft:candidate.text.includes('偏好')?preferenceDraft:originalDraft;
        const source=await tools.memory_evidence.execute({candidateId:candidate.id,evidenceId:'source'},signal);
        assert.ok(source.text.includes(quote));
        const references=await tools.memory_search.execute({candidateId:candidate.id,query:candidate.text},signal);
        const result=await tools.memory_commit.execute({candidateId:candidate.id,decision:correcting?'correct':'save',draft,sourceQuote:quote,reason:'核对用户原话',
          ...(correcting?{targetId:candidate.correction.memoryId,targetRevision:candidate.correction.revision}:{}),
          deletionComparisons:references.deleted.map(record=>({id:record.id,equivalent:false}))},signal);
        runs.push({candidate,result});
      }
    },async abort(){},dispose(){}};
  };
  const call=(tool,args,userText)=>api.runAsAgentSession(session.id,()=>api.runWithTurnUserText(userText,()=>api.memoryHost[tool](ctx,args)));
  const waitFor=async check=>{
    const end=Date.now()+8000;
    while(Date.now()<end){const result=check();if(result&&!api.memoryCurator(ctx,'a').snapshot().running)return result;await new Promise(resolve=>setTimeout(resolve,10));}
    throw new Error(`profile flow timed out: ${JSON.stringify(api.memoryCurator(ctx,'a').snapshot())}`);
  };
  const first=await call('memory.note',{text:'用户常用邮箱和手机号',searchKeys:['邮箱','手机号']},original);
  assert.equal(first.queued,true);
  const receipt=await waitFor(()=>profile.curatorReceipt(first.candidateId));
  assert.equal(receipt.disposition,'active');
  let saved=profile.list().records.find(record=>record.id===receipt.record.id);
  assert.equal(saved.kind,'user_profile');assert.equal(saved.origin,'user');assert.equal(saved.status,'active');
  assert.equal(saved.repoKey,undefined);assert.equal(saved.branch,undefined);
  assert.ok(saved.evidence.some(e=>e.observation==='user_input'&&e.verification==='user_stated'&&e.excerpt.includes('alice@example.com')));
  assert.ok(!saved.evidence.some(e=>e.verification==='user_confirmed'),'an automatic note does not pretend the derived entry was explicitly confirmed');
  assert.equal(worker.curatorReceipt(first.candidateId),undefined);
  assert.ok(svc.knowledge(other,'profile').list().records.some(record=>record.id===saved.id),'same profile is visible from another workspace');
  assert.ok(svc.injectKnowledge(other,'worker').text.includes('alice@example.com'),'profile is injected in another workspace');
  assert.equal(svc.injectKnowledge(other,'worker').sections.find(section=>section.kind==='profile').budgetChars,2400);
  const second=await call('memory.note',{text:'用户的回答偏好',searchKeys:['回答偏好']},preferenceQuote);
  await waitFor(()=>profile.curatorReceipt(second.candidateId));
  assert.ok(profile.list().records.some(record=>record.kind==='user_preference'&&record.summary==='偏好简洁回答'));
  assert.ok(svc.injectKnowledge(other,'worker').text.includes('偏好简洁回答'));

  const correction=await call('memory.correct',{memoryId:saved.id,revision:saved.revision,problem:'用户更新了邮箱',evidence:'本轮用户原话'},replacement);
  const correctionStatus=await waitFor(()=>{
    const value=profile.curatorReceipt(correction.candidateId);return value?.disposition==='updated'?value:undefined;
  });
  assert.equal(correctionStatus.record.id,saved.id);
  saved=profile.list().records.find(record=>record.id===saved.id);
  assert.equal(saved.summary,replacementDraft.summary);assert.equal(saved.revision,correctionStatus.record.revision);
  assert.ok(saved.evidence.some(e=>e.observation==='user_input'&&e.excerpt.includes('bob@example.com')));
  await call('memory.confirm',{id:saved.id,revision:saved.revision},`确认记忆 ${saved.id} 正确`);
  saved=profile.list().records.find(record=>record.id===saved.id);
  assert.ok(saved.evidence.some(e=>e.verification==='user_stated'));
  assert.ok(saved.evidence.some(e=>e.verification==='user_confirmed'&&e.source==='memory-user-confirmation'),'explicit confirmation is recorded separately');

  for(let i=0;i<10;i++){
    const statement=`我的个人背景资料第${i}项：${'持续学习和工作经历'.repeat(13)}${i}`;
    const draft={kind:'user_profile',summary:statement,applicability:[],searchKeys:[`个人背景${i}`]};
    profile.commitCuratorDecision({operationId:`budget:${i}`,candidateId:`budget:${i}`,policyVersion:'fixture',decision:'save',draft,sourceQuote:statement,
      reason:'画像预算测试',reviewedDeletionIds:[],deletionComparisons:[]},{namespace:'profile',origin:'user',userText:statement,sourceText:statement,
      evidence:[{id:`budget-source:${i}`,source:'fixture-user',eventTime:Date.now(),verification:'user_confirmed'}]});
  }
  const injected=svc.injectKnowledge(other,'worker').sections.find(section=>section.kind==='profile');
  assert.ok(injected.chars>800,'profiles can actually inject more than the old 800 character budget');
  assert.ok(injected.chars<=2400,'the configured profile budget remains bounded');

  assert.throws(()=>api.validateProfileSource(original,original,{...originalDraft,summary:'邮箱 mallory@example.com'}),/邮箱必须/);
  assert.throws(()=>api.validateProfileSource(original,original,{...originalDraft,summary:'手机号 +86 139 0013 8000'}),/电话必须/);
  assert.throws(()=>api.validateProfileSource('不要记录我的邮箱 alice@example.com','不要记录我的邮箱 alice@example.com',originalDraft),/要求不记录/);
  assert.throws(()=>api.validateProfileSource(undefined,original,originalDraft),/用户原话/);
  const headless=()=>api.runAsAgentSession(session.id,()=>api.runAsHeadlessTurn(()=>api.runWithTurnUserText(original,()=>api.memoryHost['memory.note'](ctx,{text:'邮箱',searchKeys:['邮箱']}))));
  await assert.rejects(headless(),/交互轮次/);
  const tainted=await api.runAsAgentSession(session.id,()=>api.runWithTurnUserText(original,()=>{api.markTurnNetworkTaint();return api.memoryHost['memory.note'](ctx,{text:'邮箱',searchKeys:['邮箱']});}));
  assert.equal(tainted.queued,false);
  assert.equal(runs.length,3);
  console.log('memory-user-profile-flow: user-stated contact and preference notes, global storage/injection, correction and source checks passed');
}finally{
  if(api&&ctx)await api.closeMemoryCurator(ctx,'a');
  svc?.closeAll();api?.setMemoryService(null);api?.setUserProfileFilePath(null);
  if(previous===undefined)delete globalThis.memoryUserProfileFlowModel;else globalThis.memoryUserProfileFlowModel=previous;
  assert.equal(path.dirname(path.resolve(temp)),scratch);assert.ok(path.basename(temp).startsWith('user-profile-flow-'));
  fs.rmSync(temp,{recursive:true,force:true});
}
