import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
fs.mkdirSync('.tmp',{recursive:true});
const directory=fs.mkdtempSync(path.resolve('.tmp/memory-curator-host-'));
const source=file=>JSON.stringify(path.resolve(file).replaceAll('\\','/'));
try{
  fs.writeFileSync(path.join(directory,'entry.ts'),`
    import {bindCandidateEvidence,bindMemoryCurator,memoryCurator,closeMemoryCurator,restoreMemoryCurators,boundCuratorReferences} from ${source('src/main/memory/curatorBindings.ts')};
    import {setMemoryService} from ${source('src/main/memory/serviceRef.ts')};
    import {runAsAgentWorkspace,runAsAgentSession,runAsSchedulerTool} from ${source('src/main/agent/agentScope.ts')};
    import {runWithTurnUserText,runWithExternalMemoryCandidate} from ${source('src/main/agent/turnScope.ts')};
    import {noteKnowledge} from ${source('src/main/memory/knowledgeTools.ts')};
    import {memoryHost} from ${source('src/main/capabilities/hosts/memory.ts')};
    import {setMemoryEnvironmentProvider} from ${source('src/main/memory/environment.ts')};
    import {applyLocaleSetting} from ${source('src/shared/i18n/index.ts')};
    import {localizeKnowledgeHostText} from ${source('src/shared/knowledgeDisplayText.ts')};
    export {bindCandidateEvidence,bindMemoryCurator,memoryCurator,closeMemoryCurator,restoreMemoryCurators,boundCuratorReferences,setMemoryService,setMemoryEnvironmentProvider,runAsAgentWorkspace,runAsAgentSession,runAsSchedulerTool,runWithTurnUserText,runWithExternalMemoryCandidate,noteKnowledge,memoryHost,applyLocaleSetting,localizeKnowledgeHostText};
  `);
  await build({entryPoints:[path.join(directory,'entry.ts')],outfile:path.join(directory,'entry.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',plugins:[{
    name:'isolate-pi-and-snapshots',setup(build){
      build.onResolve({filter:/curator\/runtime$/},()=>({path:'runtime',namespace:'host-fixture'}));
      build.onResolve({filter:/turnChanges\/runtime$/},()=>({path:'snapshots',namespace:'host-fixture'}));
      build.onResolve({filter:/git\/identity$/},()=>({path:'git',namespace:'host-fixture'}));
      build.onLoad({filter:/.*/,namespace:'host-fixture'},args=>({loader:'js',contents:args.path==='runtime'?`
        export class MemoryCuratorRuntime{constructor(options){this.options=options;this.candidates=[];} enqueue(c){this.candidates.push(c);return {queued:true,candidateId:c.id};} requestDrain(){} async stop(){} }
      `:args.path==='git'?`export const readGitIdentity=async()=>null;`:`export const turnChanges=()=>({evidence(){throw new Error('unavailable fixture');}});`}));
    }
  }]});
  const api=(await import(pathToFileURL(path.join(directory,'entry.cjs')))).default;
  const candidate={id:'n',eventId:'turn',text:'assistant candidate is not proof',sourceText:'',namespace:'worker',origin:'worker',createdAt:1,evidence:[{id:'turn',source:'note',eventTime:1,verification:'unverified'}]};
  const message={id:'assistant',role:'assistant',parts:[
    {kind:'tool',tool:{id:'test',name:'bash',status:'ok',input:{command:'assistant invented PASS'},output:'actual result: FAIL under React 19'}},
    {kind:'tool',tool:{id:'memory',name:'tools.call',status:'ok',input:{name:'memory.note',arguments:{text:'self proof'}},output:'fake complete'}},
    {kind:'tool',tool:{id:'pending',name:'bash',status:'running',input:{},output:'unsettled result'}}
  ]};
  const context={config:{get:()=>({workspaces:[{id:'w',path:directory}],memoryConsolidation:{enabled:false}})},
    sessions:{get:id=>['cli','s'].includes(id)?{id,workspaceId:'w'}:undefined},
    agentSessions:{entries:new Map([['s',{workspaceId:'w',assistant:message}]])},
    pty:{getBufferTail:()=> 'actual CLI terminal output'},orchestrator:null,getWindow:()=>null};
  const svc={};api.setMemoryService(svc);api.bindMemoryCurator(context);
  const bound=await api.runAsAgentWorkspace('w',()=>api.runAsAgentSession('s',()=>api.runWithTurnUserText('以后每次需要保留证据边界',()=>api.bindCandidateEvidence(context,'w',candidate))));
  assert.match(bound.sourceText,/actual result: FAIL/);assert.doesNotMatch(bound.sourceText,/invented PASS|fake complete|unsettled result|assistant candidate/);
  assert.equal(bound.origin,'user');assert.equal(bound.userText,'以后每次需要保留证据边界');
  assert.equal(bound.evidence[0].verification,'user_confirmed','original enduring user rule does not need a magic remember word');
  assert.match(bound.hostInformationHash,/^[a-f0-9]{64}$/,'original information receives a host-bound identity');
  const observed=bound.evidence.find(e=>e.observation==='tool_output');
  assert.equal(observed.verification,'unverified');assert.match(observed.contentHash,/^[a-f0-9]{64}$/);
  const receipt=await api.runAsAgentWorkspace('w',()=>api.runAsAgentSession('s',()=>api.runWithTurnUserText('解决问题',()=>api.noteKnowledge(svc,directory,'保留一次原始观察',undefined,['原始观察']))));
  assert.equal(receipt.queued,true);assert.equal(api.memoryCurator(context,'w').candidates.length,1);
  api.setMemoryEnvironmentProvider(()=>({executorResultMaxChars:'12000'}));
  await api.runAsAgentWorkspace('w',()=>api.runAsAgentSession('s',()=>api.runWithTurnUserText('核对预算',()=>api.memoryHost['memory.note'](context,{text:'观察到执行器预算',searchKeys:['预算'],environmentKeys:['executorResultMaxChars']}))));
  assert.deepEqual(api.memoryCurator(context,'w').candidates.at(-1).environment,[{key:'executorResultMaxChars',value:'12000'}],'the real note route captures the host value on the candidate');
  api.setMemoryEnvironmentProvider(undefined);
  await assert.rejects(api.runAsAgentWorkspace('w',()=>api.runAsAgentSession('s',async()=>api.runWithTurnUserText('修复',()=>api.noteKnowledge(svc,path.join(directory,'elsewhere'),'越权',undefined,['越权'])))),/越过/);
  const cli=await api.runAsAgentWorkspace('w',()=>api.runAsAgentSession('cli',()=>api.runWithExternalMemoryCandidate('cli',()=>api.bindCandidateEvidence(context,'w',candidate))));
  assert.match(cli.sourceText,/CLI.*摘录/);assert.equal(cli.origin,'worker');assert.equal(cli.evidence.some(e=>e.verification!=='unverified'),false);
  let schedulerPages=0;
  const schedulerMessages=Array.from({length:1000},(_,i)=>({id:String(i),role:i===5?'assistant':'user',content:'history',createdAt:i,
    ...(i===5?{toolCalls:[{id:'scheduler-tool',name:'bash',arguments:'{}',status:'ok',result:'actual scheduler tool result'}]}:{})}));
  const schedulerContext={...context,orchestrator:{getHistory(){throw new Error('full scheduler transcript forbidden');},getHistoryRange(_workspaceId,before,limit){
    schedulerPages++;assert.ok(limit<=120);const end=before??schedulerMessages.length,start=Math.max(0,end-limit);
    return {messages:schedulerMessages.slice(start,end),before:start,total:schedulerMessages.length,hasEarlier:start>0};
  }}};
  const schedulerBound=api.runAsAgentWorkspace('w',()=>api.runAsSchedulerTool(()=>api.runWithTurnUserText('核对调度证据',()=>api.bindCandidateEvidence(schedulerContext,'w',candidate))));
  assert.match(schedulerBound.sourceText,/actual scheduler tool result/);assert.equal(schedulerPages,9);
  const searched=[];
  svc.knowledge=(_root,namespace)=>({curatorReceipt:id=>{searched.push(namespace);return namespace==='profile'&&id==='known-profile'?{candidateId:id,operationId:'previous-profile-write'}:undefined;}});
  const lookup=api.memoryCurator(context,'w').options.receipt;
  assert.equal(lookup(candidate),undefined);assert.deepEqual(searched,['worker','profile'],'ordinary candidates also recover profile writes');
  searched.length=0;
  assert.equal(lookup({...candidate,id:'known-profile'}).operationId,'previous-profile-write');
  assert.deepEqual(searched,['worker','profile'],'automatic profile writes are replayed from the profile ledger');
  searched.length=0;
  assert.equal(lookup({...candidate,id:'known-profile',evidence:[{...candidate.evidence[0],source:'memory-curator-user'}]}).operationId,'previous-profile-write');
  assert.deepEqual(searched,['worker','scheduler','profile'],'trusted memory-view user action can recover its rebound target scope');
  const comparisonRoots=[],comparisonScopes=[],writeScopes=[],deleted={worker:[],scheduler:[],profile:[],host:[]};
  const records=Object.fromEntries(['worker','scheduler','profile','host'].map(namespace=>[namespace,[{id:`${namespace}-knowledge`,namespace,revision:1,kind:'reusable_lesson',summary:'订阅清理',
    schema:1,status:'active',origin:'worker',applicability:['组件卸载'],exceptions:[],evidence:[],history:[],createdAt:1,updatedAt:1,decisionReason:'fixture',
    repoKey:namespace==='profile'||namespace==='host'?undefined:directory,branch:namespace==='scheduler'?'previous-branch':undefined}]]));
  let fixtureIssue=false;
  svc.knowledge=(root,namespace)=>{
    assert.equal(root,directory,'the dedicated curator cannot switch to another workspace root');
    return {list:()=>({records:records[namespace]}),integrityIssues:()=>fixtureIssue&&namespace==='worker'?[{id:'damaged',reason:'missing'}]:[],curatorReferences:(_query,scope)=>{comparisonScopes.push(scope);return {records:records[namespace],deleted:deleted[namespace]};},
      deletedKnowledge:()=>deleted[namespace],commitCuratorDecision:(decision,scope)=>{writeScopes.push(scope);return {candidateId:decision.candidateId};}};
  };
  svc.curatorReferences=async(root,_query,scope)=>{comparisonRoots.push(root);comparisonScopes.push(scope);return {records:records[scope.namespace],deleted:deleted[scope.namespace]};};
  const current=api.memoryCurator(context,'w');
  const notifications=[]; context.ui={notify:(...args)=>notifications.push(args)};
  api.applyLocaleSetting('en');
  try {
    const failed={workspaceId:'w',failed:1,error:'原始失败',running:false};
    current.options.onChanged(failed); current.options.onChanged(failed);
    assert.equal(notifications.length,1,'the same failure is still notified once');
    assert.equal(notifications[0][0],'Memory service needs attention');
    assert.equal(notifications[0][1],'Background processing retained a failure state. Check the model configuration in memory settings or retry. Knowledge content does not need approval.');
    assert.deepEqual(notifications[0][2],{workspaceId:'w',openPanel:{panel:'memory',tab:'index'}});
    assert.equal(failed.error,'原始失败');
  } finally { api.applyLocaleSetting('zh-CN'); }
  const compared=await current.options.references({...candidate,repoKey:directory},'订阅清理');
  assert.deepEqual(new Set(compared.records.map(r=>r.namespace)),new Set(['worker','scheduler','profile','host']),'ordinary candidates compare global host knowledge without gaining write authority');
  assert.equal(comparisonRoots.length,4);assert.ok(comparisonRoots.every(root=>root===directory));
  assert.ok(comparisonScopes.some(scope=>scope.namespace==='scheduler'&&scope.branch==='previous-branch'),'stored branch boundaries remain available for comparison');
  fixtureIssue=true;
  assert.match((await current.options.references({...candidate,repoKey:directory},'订阅清理')).notice,/worker:damaged/,'curator comparison explains the isolated projection');
  fixtureIssue=false;
  const groups=['worker','scheduler','profile'].map(namespace=>({records:Array.from({length:20},(_,index)=>({...records[namespace][0],id:`${namespace}-${index}`,
    evidence:[{id:'original-source',source:'fixture',eventTime:1,verification:'unverified',excerpt:'原始长摘录'.repeat(2000)}],history:[{revision:1,summary:'旧版本'.repeat(2000),status:'pending',at:1}]})),
    deleted:[{id:`${namespace}-deleted`,namespace,kind:'stable_constraint',summary:'删除后的同义内容不自动复活',applicability:['完整条件'],deletedAt:1,revision:2}]}));
  const bounded=api.boundCuratorReferences(groups);
  assert.equal(bounded.records.length,12);assert.equal(bounded.omittedRecords,48);assert.equal(bounded.truncated,true);
  assert.deepEqual(bounded.records.slice(0,3).map(record=>record.namespace),['worker','scheduler','profile'],'each namespace has a fair first comparison');
  assert.ok(bounded.records.reduce((sum,record)=>sum+JSON.stringify(record).length,0)<=12000,'one global character budget bounds all namespaces');
  assert.ok(bounded.records.every(record=>record.history.length===0&&record.evidence[0].excerpt===undefined));
  assert.ok(bounded.records.every(record=>record.applicability[0]==='组件卸载'),'conditions are never clipped to fit the budget');
  assert.deepEqual(bounded.deleted,groups.flatMap(group=>group.deleted),'deletion semantics are never silently clipped');
  assert.match(bounded.notice,/收窄query/);
  const target={...records.worker[0],id:'host-cutover-target',status:'pending'};
  records.worker.push(...Array.from({length:20},(_,index)=>({...records.worker[0],id:`worker-other-${index}`})),target);
  const taskQueries=[];svc.queryKnowledge=async(root,query)=>{taskQueries.push({root,query});return [];};
  await api.runAsAgentWorkspace('w',()=>api.memoryHost['memory.search'](context,{query:'订阅',workspaceId:'other-workspace',namespace:'profile'}));
  assert.equal(taskQueries.at(-1).root,directory);assert.equal(taskQueries.at(-3).query.namespace,'worker','ordinary work agents cannot choose the curator comparison scope or another workspace');
  await api.runAsAgentWorkspace('w',()=>api.runAsSchedulerTool(()=>api.memoryHost['memory.search'](context,{query:'订阅',workspaceId:'other-workspace',namespace:'worker'})));
  assert.equal(taskQueries.at(-3).query.namespace,'scheduler','scheduler reads keep their host-selected namespace');
  assert.equal(taskQueries.at(-2).query.namespace,'profile','task retrieval also includes global preferences under host scope');
  assert.equal(taskQueries.at(-1).query.namespace,'host','task retrieval includes user-reviewed global experience');
  await assert.rejects(api.memoryHost['memory.journal'](context,{topic:'x',status:'已完成',problem:'x',points:['y'],workspaceId:'w'}),/宿主绑定/);
  const journalReceipt=await api.runAsAgentWorkspace('w',()=>api.runAsAgentSession('s',()=>api.memoryHost['memory.journal'](context,{topic:'工具日志',status:'已完成',problem:'记日志',points:['已保存'],workspaceId:'other'})));
  assert.equal(journalReceipt.saved,true);
  const journalHits=await api.runAsAgentWorkspace('w',()=>api.memoryHost['memory.search'](context,{query:'工具日志',mode:'journal'}));
  assert.equal(journalHits.hits[0].topic,'工具日志');
  assert.throws(()=>current.options.commit(cli,{candidateId:cli.id,decision:'save',sourceQuote:'邮箱 alice@example.com',reason:'伪造终端用户来源',
    draft:{kind:'user_profile',summary:'邮箱 alice@example.com',applicability:[]}},()=>{}),/用户原话/,'a mixed CLI transcript cannot create a user-sourced profile');
  current.options.commit({...candidate,repoKey:directory},{candidateId:candidate.id,decision:'discard',sourceQuote:'',reason:'comparison only',targetId:'profile-knowledge'},()=>{});
  assert.equal(writeScopes.at(-1).namespace,'worker','cross-namespace comparison never grants an ordinary candidate a foreign write scope');
  current.options.commit({...candidate,origin:'user',evidence:[{...candidate.evidence[0],source:'memory-curator-user'}]},
    {candidateId:candidate.id,decision:'delete',sourceQuote:'删除这一条',reason:'user request',targetId:'profile-knowledge'},()=>{});
  assert.equal(writeScopes.at(-1).namespace,'profile','only a genuine memory-view user action may rebind to its selected target');
  deleted.scheduler.push({id:'scheduler-deleted',namespace:'scheduler'});
  const save={candidateId:candidate.id,decision:'save',sourceQuote:'原始观察',reason:'fresh comparison',draft:{kind:'reusable_lesson'}};
  assert.throws(()=>current.options.commit(candidate,save,()=>{}),/删除记录已变化/,'a foreign deletion added during comparison invalidates a write');
  const comparedDeletion={reviewedDeletionIds:['scheduler-deleted'],deletionComparisons:[{id:'scheduler-deleted',equivalent:true}]};
  assert.throws(()=>current.options.commit(candidate,{...save,...comparedDeletion},()=>{}),/同义知识已被用户删除/,'an explicit equivalence verdict cannot evade deletion by changing namespace');
  const correctionCandidate={...candidate,correction:{memoryId:records.worker[0].id,revision:records.worker[0].revision,problem:'范围过宽',evidence:'原始观察'}};
  assert.throws(()=>current.options.commit(correctionCandidate,{...save,decision:'correct',...comparedDeletion},()=>{}),/同义知识已被用户删除/,'same-ID corrections cannot evade a deletion in another namespace');
  assert.doesNotThrow(()=>current.options.commit(candidate,{...save,...comparedDeletion,deletionComparisons:[{id:'scheduler-deleted',equivalent:false}]},()=>{}),'a different boundary is not rejected by a host similarity guess');
  deleted.host.push({id:'host-deleted',namespace:'host'});
  assert.throws(()=>current.options.commit(candidate,{...save,...comparedDeletion,deletionComparisons:[{id:'scheduler-deleted',equivalent:false}]},()=>{}),/删除记录已变化/,'a globally deleted memory also invalidates the comparison');
  try {
    current.options.commit(candidate,{...save,...comparedDeletion,deletionComparisons:[{id:'scheduler-deleted',equivalent:false}]},()=>{});
    assert.fail('changed deletion record must be rejected');
  } catch(error) {
    assert.match(error.message,/删除记录已变化/);
    api.applyLocaleSetting('en');
    try {assert.equal(api.localizeKnowledgeHostText(error.message),'Workspace deletion records changed or have not been compared. Search again before submitting.');}
    finally {api.applyLocaleSetting('zh-CN');}
  }
  await api.closeMemoryCurator(context,'w');
  context.config.get=()=>({workspaces:[{id:'w',path:directory},{id:'w2',path:directory}],memoryConsolidation:{enabled:false}});
  assert.doesNotThrow(()=>api.restoreMemoryCurators(context),'disabled processing cannot touch legacy pending records');
  assert.notEqual(api.memoryCurator(context,'w').options.directory,api.memoryCurator(context,'w2').options.directory,'workspace identity is part of the durable session path');
  context.config.get=()=>({workspaces:[{id:'w',path:directory},{id:'w2',path:directory}],memoryConsolidation:{enabled:true,admissionMode:'observe'}});
  assert.doesNotThrow(()=>api.restoreMemoryCurators(context),'observation mode cannot directly archive legacy pending records');
  await api.closeMemoryCurator(context,'w');await api.closeMemoryCurator(context,'w2');
  const restoreNotices=[];context.notify={push:item=>restoreNotices.push(item)};api.setMemoryService(undefined);
  const oldError=console.error;console.error=()=>{};
  try {
    api.applyLocaleSetting('en');api.restoreMemoryCurators(context);
    assert.equal(restoreNotices.length,2);
    assert.equal(restoreNotices[0].sessionName,'Workbench');
    assert.equal(restoreNotices[0].text,'Memory initialization failed; data was not cleared: Memory service is not ready yet');
    assert.equal(restoreNotices[0].workspaceId,'w');assert.equal(restoreNotices[0].toast,true);
    restoreNotices.length=0;api.applyLocaleSetting('zh-CN');api.restoreMemoryCurators(context);
    assert.equal(restoreNotices[0].text,'记忆初始化失败，数据未清理：Error: 记忆服务尚未就绪');
    restoreNotices.length=0;api.applyLocaleSetting('en');let configReads=0;
    const previousConfig=context.config.get;
    context.config.get=()=>{if(configReads++===0)return {workspaces:[{id:'w',path:directory}]};throw new Error('第三方原始错误');};
    try {api.restoreMemoryCurators(context);} finally {context.config.get=previousConfig;}
    assert.equal(restoreNotices[0].text,'Memory initialization failed; data was not cleared: Error: 第三方原始错误');
  } finally {console.error=oldError;api.applyLocaleSetting('zh-CN');api.setMemoryService(svc);}
  for(const file of ['src/main/agentSession/host/fileChanges.ts','src/main/agentSession/host/messaging.ts','src/main/agentSession/host/sessionOps.ts','src/main/agent/orchestrator/turnExecution.ts','src/main/agent/orchestrator/compaction.ts']){
    assert.doesNotMatch(fs.readFileSync(file,'utf8'),/ingestGuiSessionOnRelease|enqueueSchedulerKnowledge|requestMemoryConsolidation|scheduleTranscriptIndex/,file);
  }
  console.log('memory-curator-host: bound raw outputs, no self-evidence, CLI observation, workspace authority and no lifecycle extraction passed');
}finally{fs.rmSync(directory,{recursive:true,force:true});}
