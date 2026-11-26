import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

// The model factory is the sole replacement: host binding, service comparison,
// runtime tools, queue, knowledge transactions and status receipts are production code.
const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'correction-flow-'));
const root=path.join(temp,'workspace');fs.mkdirSync(root,{recursive:true});
const previousFactory=globalThis.memoryCorrectionFlowModel;
let api,svc,ctx;
let modelStubLoaded=false;
const normalized=value=>JSON.parse(JSON.stringify(value));
try{
  const bundle=path.join(temp,'api.cjs');
  await build({stdin:{contents:`
    export {MemoryService} from './src/main/memory/service';
    export {setMemoryService} from './src/main/memory/serviceRef';
    export {setUserProfileFilePath} from './src/main/memory/userProfile';
    export {memoryHost} from './src/main/capabilities/hosts/memory';
    export {memoryCurator,closeMemoryCurator} from './src/main/memory/curatorBindings';
    export {runAsAgentSession} from './src/main/agent/agentScope';
    export {runWithTurnUserText} from './src/main/agent/turnScope';
  `,resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',plugins:[{
    name:'model-only',setup(b){
      b.onResolve({filter:/^\.\/pi$/},args=>args.importer.replaceAll('\\','/').endsWith('/memory/curator/runtime.ts')?{path:'model',namespace:'fixture-model'}:undefined);
      b.onLoad({filter:/.*/,namespace:'fixture-model'},()=>{modelStubLoaded=true;return {loader:'js',contents:`
        export function createMemoryCuratorPiFactory(){return async input=>globalThis.memoryCorrectionFlowModel(input);}
      `};});
    }
  }]});
  assert.equal(modelStubLoaded,true,'the isolated model module must be installed before any host execution');
  api=createRequire(import.meta.url)(bundle);
  api.setUserProfileFilePath(path.join(temp,'user-data'));
  svc=new api.MemoryService();api.setMemoryService(svc);
  const config={workspaces:[{id:'flow',path:root}],memoryConsolidation:{enabled:true}};
  const session={id:'producer',workspaceId:'flow',cwd:root};
  const assistant={id:'working-turn',role:'assistant',parts:[]};
  const notifications=[];
  ctx={sessions:{get:id=>id===session.id?session:undefined},
    agentSessions:{entries:new Map([[session.id,{workspaceId:'flow',assistant}]])},
    config:{get:()=>config},getWindow:()=>null,orchestrator:null,pty:{getBufferTail:()=>''},
    ui:{notify:(...args)=>notifications.push(args)}};
  const store=svc.knowledge(root,'worker'),profile=svc.knowledge(root,'profile');
  const lesson={kind:'reusable_lesson',summary:'窗口探针在所有桌面环境均可取得坐标',problem:'消费者需要选择可用的窗口探针',
    action:'调用窗口探针读取坐标',rationale:'旧来源声称所有环境通过',applicability:['桌面窗口探针'],exceptions:[],searchKeys:['窗口探针'],expectedFutureUse:'选择有验证依据的窗口探针'};
  let sequence=0;
  function seed(draft=lesson,namespace='worker'){
    const id=`fixture-seed:${++sequence}`,source=draft.kind==='user_preference'?draft.summary:'先前来源声称桌面探针可在所有环境取得窗口坐标。';
    return svc.knowledge(root,namespace).commitCuratorDecision({operationId:id,candidateId:id,policyVersion:'fixture-seed',decision:'save',
      draft,sourceQuote:source,reason:'隔离夹具的原始知识',reviewedDeletionIds:[],deletionComparisons:[]},
      {namespace,origin:draft.kind==='user_preference'?'user':'worker',userText:draft.kind==='user_preference'?source:undefined,sourceText:source,
        evidence:[{id:`source:${sequence}`,source:'fixture-seed',eventTime:Date.now(),verification:'unverified'}]}).record;
  }
  const original=seed();
  const protectedSeed=seed({...lesson,summary:'受保护的坐标探针支持所有环境',action:'调用受保护的坐标探针'});
  const protectedRecord=store.revise(protectedSeed.id,protectedSeed.revision,{...protectedSeed,summary:'用户确认的坐标探针支持所有环境'});
  const raceRecord=seed({...lesson,summary:'并发修改前的探针结论',action:'调用并发探针'});
  const preference=seed({kind:'user_preference',summary:'报告先给结论',applicability:[]},'profile');
  const quote=execFileSync(process.execPath,['-e',`
    const assert=require('node:assert/strict');
    const fixtureProbe=desktop=>desktop==='Windows'?{x:12,y:20}:null;
    assert.deepEqual(fixtureProbe('Windows'),{x:12,y:20});
    assert.equal(fixtureProbe('Wayland'),null);
    process.stdout.write('隔离探针回归：Windows返回坐标(12,20)，Wayland返回null；只证明该夹具的结果。');
  `],{encoding:'utf8',windowsHide:true}).trim();
  const userQuote='更正报告偏好，改为先给结论和验证范围';
  const query='zxqv94702_no_lexical_overlap';
  const scenarios=new Map([
    [original.id,{draft:{...lesson,summary:'窗口探针仅在已验证的Windows夹具取得坐标',applicability:['Windows探针夹具'],exceptions:['Wayland夹具返回null']},quote}],
    [protectedRecord.id,{draft:{...lesson,summary:'受保护探针只在Windows夹具取得坐标',action:'调用受保护的坐标探针',applicability:['Windows探针夹具'],exceptions:['Wayland夹具返回null']},quote}],
    [raceRecord.id,{draft:{...lesson,summary:'并发探针应按夹具环境限定',action:'调用并发探针',applicability:['Windows探针夹具'],exceptions:['Wayland夹具返回null']},quote,race:true}],
    [preference.id,{draft:{kind:'user_preference',summary:'报告先给结论和验证范围',applicability:[],searchKeys:['报告格式']},quote:userQuote}]
  ]);
  const modelRuns=[],receipts=[],errors=[],searched=[],readSources=[];
  globalThis.memoryCorrectionFlowModel=async input=>{
    const tools=Object.fromEntries(input.tools.map(tool=>[tool.name,tool]));
    assert.deepEqual(Object.keys(tools).sort(),['memory_candidates','memory_commit','memory_defer','memory_evidence','memory_search']);
    return {id:'fixture-pi-session',async run(_job,signal){
      input.beforeModelRequest?.();input.onEvent({type:'model-start'});
      const candidates=await tools.memory_candidates.execute({},signal);
      for(const candidate of candidates){
        const scenario=scenarios.get(candidate.correction.memoryId);assert.ok(scenario,'only submitted targets reach the model');
        modelRuns.push(candidate.id);
        const raw=await tools.memory_evidence.execute({candidateId:candidate.id,evidenceId:'source'},signal);
        readSources.push(raw.text);
        assert.ok(raw.text.includes(scenario.quote),'the actual source quote is readable through the curator evidence tool');
        assert.doesNotMatch(raw.text,/wrapper-self-certified|running-result|model-hint-is-proof/);
        // This query deliberately has no lexical match: the host must prepend the
        // named target rather than leaving the model to guess another record.
        const bare=svc.knowledge(root,candidate.namespace).curatorReferences(query,{namespace:candidate.namespace});
        assert.ok(!bare.records.some(record=>record.id===candidate.correction.memoryId));
        const references=await tools.memory_search.execute({candidateId:candidate.id,query},signal);
        assert.equal(references.records[0].id,candidate.correction.memoryId,'host prioritizes the exact target even when ranking misses it');
        assert.equal(references.records[0].revision,candidate.correction.revision);
        searched.push(candidate.correction.memoryId);
        if(scenario.race){
          const current=store.list().records.find(record=>record.id===candidate.correction.memoryId);
          scenario.concurrent=store.revise(current.id,current.revision,{...current,summary:'并发用户已经发布的新探针版本'});
        }
        try{
          const result=await tools.memory_commit.execute({candidateId:candidate.id,decision:'correct',draft:scenario.draft,
            sourceQuote:scenario.quote,reason:'核对原始来源后更正条件与结论',targetId:candidate.correction.memoryId,targetRevision:candidate.correction.revision,
            deletionComparisons:references.deleted.map(record=>({id:record.id,equivalent:false}))},signal);
          receipts.push(result);
        }catch(error){errors.push(String(error.message));throw error;}
      }
    },async abort(){},dispose(){}};
  };
  const call=(tool,args,userText='请复核已召回的记忆')=>api.runAsAgentSession(session.id,()=>api.runWithTurnUserText(userText,()=>api.memoryHost[tool](ctx,args)));
  const readStatus=requestId=>api.runAsAgentSession(session.id,()=>api.memoryHost['memory.correctionStatus'](ctx,{requestId}));
  const waitFor=async(requestId)=>{
    const end=Date.now()+5000;
    for(;;){
      const status=await readStatus(requestId);
      if(status.completed||status.status==='failed'){
        const runtime=api.memoryCurator(ctx,'flow');
        if(!runtime.snapshot().running)return status;
      }
      if(Date.now()>end)throw new Error(`correction flow timed out: ${JSON.stringify(status)}`);
      await new Promise(resolve=>setTimeout(resolve,5));
    }
  };
  const toolPart=(id,output,name='terminal.exec',input={})=>({kind:'tool',tool:{id,name,status:'ok',input,output}});
  const submit=async record=>{
    assistant.parts=[...Array.from({length:12},(_,index)=>toolPart(`old-${index}`,`old-output-${index}`)),toolPart('recent-real-regression',quote),
      toolPart('wrapper','wrapper-self-certified','tools.call',{name:'memory.correct',arguments:{evidence:'fake'}}),
      {kind:'tool',tool:{id:'running',name:'terminal.exec',status:'running',input:{},output:'running-result'}}];
    const receipt=await call('memory.correct',{memoryId:record.id,revision:record.revision,problem:'原结论条件与新观察冲突',evidence:'model-hint-is-proof',suggestion:'核对最近的原始工具输出'});
    assert.equal(receipt.queued,true);assert.equal(receipt.requestId,receipt.candidateId);
    return {receipt,status:await waitFor(receipt.requestId)};
  };
  const first=await submit(original);
  assert.equal(first.status.status,'updated',JSON.stringify(first.status));assert.equal(first.status.recordId,original.id);
  assert.equal(first.status.recordRevision,original.revision+1);assert.equal(first.status.completed,true);
  const current=store.list().records.find(record=>record.id===original.id);
  assert.equal(current.summary,scenarios.get(original.id).draft.summary);assert.equal(current.userManaged,false);
  assert.deepEqual(current.applicability,['Windows探针夹具']);assert.equal(store.list().records.length,3,'same-ID correction creates no extra record');
  assert.ok(current.evidence.some(e=>e.observation==='tool_output'&&e.source==='terminal.exec'&&e.verification==='unverified'&&e.excerpt===quote));
  assert.ok(readSources[0].includes('recent-real-regression'),'recent completed counterevidence survives the eight-tool cap');
  assert.ok(!readSources[0].includes('old-output-0'),'correction capture takes recent outputs first');
  const savedReceipt=store.curatorReceipt(first.receipt.candidateId);
  assert.equal(savedReceipt.disposition,'updated');assert.equal(savedReceipt.targetRevision,original.revision);

  assistant.parts=[];
  const prefReceipt=await call('memory.correct',{memoryId:preference.id,revision:preference.revision,problem:'报告偏好已被用户纠正',evidence:'本轮用户原话'},userQuote);
  const prefStatus=await waitFor(prefReceipt.requestId);
  assert.equal(prefStatus.status,'updated',JSON.stringify(prefStatus));
  const prefCurrent=profile.list().records.find(record=>record.id===preference.id);
  assert.equal(prefCurrent.summary,'报告先给结论和验证范围');assert.equal(prefCurrent.origin,'user');
  assert.ok(prefCurrent.evidence.some(e=>e.observation==='user_input'&&e.excerpt===userQuote),'actual correction quote reaches the ledger as user input');

  const beforeProtected=normalized(store.list().records.find(record=>record.id===protectedRecord.id));
  const protectedFlow=await submit(protectedRecord);
  assert.equal(protectedFlow.status.status,'needs_user',JSON.stringify(protectedFlow.status));
  assert.equal(protectedFlow.status.proposedCorrection.decision,'correct');
  assert.equal(protectedFlow.status.proposedCorrection.draft.summary,scenarios.get(protectedRecord.id).draft.summary);
  assert.deepEqual(store.list().records.find(record=>record.id===protectedRecord.id),beforeProtected,'protected body, revision, evidence and status remain unchanged');

  const race=await submit(raceRecord);
  assert.equal(race.status.status,'failed',JSON.stringify(race.status));assert.equal(race.status.completed,false);
  assert.match(race.status.reason,/已变化/);
  assert.deepEqual(store.list().records.find(record=>record.id===raceRecord.id),normalized(scenarios.get(raceRecord.id).concurrent),'late correction cannot overwrite the racing user version');
  assert.equal(store.curatorReceipt(race.receipt.requestId),undefined,'CAS rejection publishes no successful knowledge receipt');
  assert.equal(modelRuns.length,4);assert.equal(receipts.length,3);assert.equal(errors.length,1);assert.equal(searched.length,4);
  assert.equal(notifications.length,1,'failed race is visible through the existing host notification path');
  // Status remains a durable host receipt when the curator object is closed and rebuilt.
  await api.closeMemoryCurator(ctx,'flow');
  assert.equal((await readStatus(first.receipt.requestId)).status,'updated');
  assert.equal((await readStatus(protectedFlow.receipt.requestId)).status,'needs_user');
  assert.equal((await readStatus(race.receipt.requestId)).status,'failed');
  assert.equal(modelRuns.length,4,'reading restored status never starts another model request');
  console.log('memory-correction-flow: real host/service/runtime/tools/ledger/status, recent sources, original user correction, protected proposal, CAS race and exact-target comparison passed');
}finally{
  if(api&&ctx)await api.closeMemoryCurator(ctx,'flow');
  svc?.closeAll();api?.setMemoryService(null);api?.setUserProfileFilePath(null);
  if(previousFactory===undefined)delete globalThis.memoryCorrectionFlowModel;else globalThis.memoryCorrectionFlowModel=previousFactory;
  assert.equal(path.dirname(path.resolve(temp)),scratch);assert.ok(path.basename(temp).startsWith('correction-flow-'));
  fs.rmSync(temp,{recursive:true,force:true});
}
