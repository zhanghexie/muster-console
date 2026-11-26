import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'correction-host-'));
let api,ctx;
let modelStubLoaded=false;
try{
  const executor=fs.readFileSync('src/main/capabilities/executor.ts','utf8');
  const otherHosts=new Map([...executor.matchAll(/import \{([^}]+)\} from '\.\/hosts\/([^']+)'/g)]
    .filter(match=>match[2]!=='memory').map(match=>[match[2],match[1].split(',').map(s=>s.trim())]));
  const bundle=path.join(temp,'api.cjs');
  await build({stdin:{contents:`
    export {buildCatalogHostTools} from './src/main/agentSession/tools/catalogHostTools';
    export {executeTool} from './src/main/capabilities/executor';
    export {runAsAgentWorkspace,runAsSchedulerTool} from './src/main/agent/agentScope';
    export {runWithTurnUserText,runAsNonUserTurn,runAsHeadlessTurn,markTurnNetworkTaint,runWithExternalMemoryCandidate} from './src/main/agent/turnScope';
    export {setMemoryService} from './src/main/memory/serviceRef';
    export {memoryCurator,closeMemoryCurator} from './src/main/memory/curatorBindings';
    export {getHostToolMeta,hostToolPermissionClass,listHostToolIds} from './src/shared/hostTools';
    export {residentHostToolIds} from './src/shared/toolDiscovery';
  `,resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',plugins:[{
    name:'unrelated-services',setup(b){
      b.onResolve({filter:/^\.\/hosts\//},args=>{
        const name=args.path.slice('./hosts/'.length);
        if(args.importer.replaceAll('\\','/').endsWith('/capabilities/executor.ts')&&otherHosts.has(name))return {path:name,namespace:'unused-host'};
      });
      b.onLoad({filter:/.*/,namespace:'unused-host'},args=>({contents:otherHosts.get(args.path).map(name=>`export const ${name}={};`).join('\n'),loader:'js'}));
      const stubs={
        'curator/pi':'export function createMemoryCuratorPiFactory(){throw Error("model must remain idle")}',
        'turnChanges/runtime':'export function turnChanges(){throw Error("unused")}',
        'git/identity':'export async function readGitIdentity(root){return {root,branch:"main"}}',
        'browser/turnShotCapture':'export function recordBrowserToolUse(){}',
        'safety/bindings':'export function authorizeSafetyOperation(){throw Error("unused")}',
        'extensions/safetyEvidence':'export function extensionSafetyEvidence(){throw Error("unused")}'
      };
      b.onResolve({filter:/curator\/pi$|^\.\/pi$|turnChanges\/runtime$|git\/identity$|browser\/turnShotCapture$|safety\/bindings$|extensions\/safetyEvidence$/},args=>{
        const key=args.path==='./pi'&&args.importer.replaceAll('\\','/').endsWith('/memory/curator/runtime.ts')?'curator/pi':Object.keys(stubs).find(key=>args.path.endsWith(key));
        if(key)return {path:key,namespace:'fixture'};
      });
      b.onLoad({filter:/.*/,namespace:'fixture'},args=>{if(args.path==='curator/pi')modelStubLoaded=true;return {contents:stubs[args.path],loader:'js'};});
    }
  }]});
  assert.equal(modelStubLoaded,true,'the idle-model guard must be installed even when processing is disabled');
  api=createRequire(import.meta.url)(bundle);
  const roots={one:path.join(temp,'one'),two:path.join(temp,'two')};
  const sessions={a:{id:'a',workspaceId:'one',cwd:roots.one},peer:{id:'peer',workspaceId:'one',cwd:roots.one},cli:{id:'cli',workspaceId:'one',cwd:roots.one},b:{id:'b',workspaceId:'two',cwd:roots.two},orphan:{id:'orphan'}};
  const record=(id,namespace='worker',extra={})=>({schema:1,id,revision:3,namespace,kind:'reusable_lesson',summary:'旧结论',status:'active',origin:'worker',applicability:[],evidence:[],history:[],createdAt:1,updatedAt:1,...extra});
  const records={worker:[record('target'),record('branch','worker',{branch:'other'}),record('repo','worker',{repoKey:path.join(temp,'foreign')}),record('task','worker',{kind:'task_fact'}),record('retired','worker',{status:'superseded'}),record('suspended','worker',{status:'needs_revalidation'}),record('protected','worker',{userManaged:true})],scheduler:[record('scheduler','scheduler')],profile:[record('profile','profile')],host:[]};
  const assistant={id:'turn',role:'assistant',parts:[
    {kind:'tool',tool:{id:'test',name:'bash',status:'ok',input:{command:'claim PASS'},output:'actual observation: FAIL'}},
    {kind:'tool',tool:{id:'memory',name:'memory.correct',status:'ok',input:{evidence:'forged proof'},output:'self certified PASS'}},
    {kind:'tool',tool:{id:'wrapped',name:'tools.call',status:'ok',input:{name:'memory.correct'},output:'wrapped self certified PASS'}},
    {kind:'tool',tool:{id:'pending',name:'bash',status:'running',input:{},output:'pending proof'}}
  ]};
  ctx={sessions:{get:id=>sessions[id]},agentSessions:{entries:new Map(Object.entries(sessions).filter(([id])=>id!=='cli').map(([id,session])=>[id,{workspaceId:session.workspaceId,assistant}]))},
    config:{get:()=>({activeWorkspaceId:'two',workspaces:Object.entries(roots).map(([id,root])=>({id,path:root})),memoryConsolidation:{enabled:false}})},
    orchestrator:{getHistoryRange:()=>({messages:[],hasMore:false}),schedulerModelFor:()=>undefined},getWindow:()=>null,pty:{getBufferTail:()=> 'CLI original output: FAIL'}};
  api.setMemoryService({knowledge:(root,ns)=>({list:()=>({records:root===roots.one||ns==='profile'?records[ns]:[]}),policyAllows:()=>true,
    confirm(id,revision,userText){const item=records[ns].find(r=>r.id===id);if(!item||item.revision!==revision)throw Error('版本已变化');item.revision++;item.userManaged=true;item.evidence.push({id:'confirm',source:'user',eventTime:2,verification:'user_confirmed',excerpt:userText});return item;}})});
  const tools=api.buildCatalogHostTools(ctx),correct=tools.find(t=>t.id==='memory.correct'),status=tools.find(t=>t.id==='memory.correctionStatus');
  const input={memoryId:'target',revision:3,problem:'结论与实际观察冲突',evidence:'forged model proof: PASS',suggestion:'重新限定条件'};
  const call=(id,args=input)=>api.runWithTurnUserText('请核实当前记忆',()=>correct.execute(args,{sessionId:id})).then(JSON.parse);
  const a=await api.runAsAgentWorkspace('two',()=>call('a',{...input,workspaceId:'two',namespace:'scheduler',__actorSessionId:'b',requesterSessionId:'b'}));
  assert.equal(a.ok,true,JSON.stringify(a));assert.equal(a.result.queued,true);assert.equal(a.result.requestId,a.result.candidateId);
  const runtime=api.memoryCurator(ctx,'one');
  const queued=JSON.parse(runtime.queue.db.prepare('SELECT payload FROM candidates WHERE id=?').get(a.result.requestId).payload);
  assert.equal(queued.requesterSessionId,'a');assert.equal(queued.namespace,'worker');assert.equal(queued.correction.memoryId,'target');
  assert.match(queued.sourceText,/请核实当前记忆|actual observation: FAIL/);
  assert.doesNotMatch(queued.sourceText,/forged model proof|self certified|pending proof|claim PASS/);
  assert.equal(queued.evidence.find(e=>e.observation==='tool_output').verification,'unverified','tool execution does not certify the reported outcome');
  assert.equal(records.worker[0].revision,3,'submission never revises knowledge');
  const own=JSON.parse(await status.execute({requestId:a.result.requestId,requesterSessionId:'peer'},{sessionId:'a'}));
  assert.equal(own.ok,true,JSON.stringify(own));assert.equal(own.result.status,'pending');assert.equal(own.result.completed,false);
  assert.equal(JSON.parse(await status.execute({requestId:a.result.requestId},{sessionId:'peer'})).ok,false,'request status belongs to its producer');
  assert.equal(JSON.parse(await status.execute({requestId:a.result.requestId},{sessionId:'b'})).ok,false,'another workspace cannot inspect requests');
  for(const memoryId of ['scheduler','branch','repo','task','retired'])assert.equal((await call('a',{...input,memoryId})).ok,false,memoryId);
  assert.equal((await call('a',{...input,revision:2})).ok,false,'stale revision');
  for(const memoryId of ['profile','suspended','protected'])assert.equal((await call('a',{...input,memoryId})).ok,true,memoryId);
  for(const id of ['missing','orphan','b'])assert.equal((await call(id)).ok,false,id);
  assert.equal(JSON.parse(await correct.execute(input,{sessionId:'a'})).ok,false,'missing turn');
  assert.equal((await api.runAsHeadlessTurn(()=>call('a'))).ok,false,'headless turn');
  ctx.agentSessions.entries.get('peer').assistant={id:'empty',role:'assistant',parts:[]};
  const noSources=await api.runAsNonUserTurn(()=>correct.execute(input,{sessionId:'peer'}));
  assert.equal(JSON.parse(noSources).ok,false,'model evidence hint alone cannot supply raw sources');
  const tainted=await api.runWithTurnUserText('原始输入',async()=>{api.markTurnNetworkTaint();return JSON.parse(await correct.execute(input,{sessionId:'a'}));});
  assert.equal(tainted.ok,false,'untrusted turn cannot submit');
  const missing=await api.executeTool(ctx,'memory.correct',JSON.stringify({...input,__actorSessionId:'a',workspaceId:'one'}));
  assert.equal(missing.ok,false,'model arguments alone are not identity');
  const scheduled=await api.runAsAgentWorkspace('one',()=>api.runAsSchedulerTool(()=>api.runWithTurnUserText('核实调度记忆',()=>api.executeTool(ctx,'memory.correct',JSON.stringify({...input,memoryId:'scheduler'})))));
  assert.equal(scheduled.ok,true,JSON.stringify(scheduled));
  const schedulerPayload=JSON.parse(runtime.queue.db.prepare('SELECT payload FROM candidates WHERE id=?').get(scheduled.result.requestId).payload);
  assert.equal(schedulerPayload.requesterSessionId,'scheduler:one');assert.equal(schedulerPayload.namespace,'scheduler');
  const schedulerStatus=await api.runAsAgentWorkspace('one',()=>api.runAsSchedulerTool(()=>api.executeTool(ctx,'memory.correctionStatus',JSON.stringify({requestId:scheduled.result.requestId}))));
  assert.equal(schedulerStatus.ok,true);
  assert.match(fs.readFileSync('src/main/protocol/shellApi.ts','utf8'),/\['host\.memory\.note', 'host\.memory\.correct'\]\.includes\(publicName\)\s*\?\s*await runWithExternalMemoryCandidate/,'authenticated CLI correction receives the existing provenance wrapper');
  const cli=await api.runWithExternalMemoryCandidate('cli',()=>api.executeTool(ctx,'memory.correct',JSON.stringify(input),{callingSessionId:'cli'}));
  assert.equal(cli.ok,true,JSON.stringify(cli));
  const cliPayload=JSON.parse(runtime.queue.db.prepare('SELECT payload FROM candidates WHERE id=?').get(cli.result.requestId).payload);
  assert.equal(cliPayload.requesterSessionId,'cli');assert.equal(cliPayload.userText,'');assert.match(cliPayload.sourceText,/CLI original output/);
  assert.ok(cliPayload.evidence.every(e=>e.verification==='unverified'),'mixed CLI output is not user authority or runtime verification');
  const confirm=tools.find(t=>t.id==='memory.confirm'),confirmCall=(text,args={id:'target',revision:3})=>api.runWithTurnUserText(text,()=>confirm.execute(args,{sessionId:'a'})).then(JSON.parse);
  assert.equal((await confirmCall('这条是对的')).ok,false,'model arguments alone cannot select a target the user did not name');
  assert.equal((await confirmCall('不要确认记忆 target 正确')).ok,false,'negative user instructions do not confirm');
  assert.equal((await confirmCall('确认记忆 other 正确')).ok,false,'a different named target cannot authorize this one');
  assert.equal((await confirmCall('确认记忆 target 正确',{id:'target',revision:2})).ok,false,'stale versions cannot be confirmed');
  const accepted=await confirmCall('确认记忆 target 正确');
  assert.equal(accepted.ok,true,JSON.stringify(accepted));assert.equal(accepted.result.revision,4);assert.equal(accepted.result.evidence.verification[0],'user_confirmed');
  assert.equal(records.worker[0].evidence.at(-1).excerpt,'确认记忆 target 正确','original human text is stored as the confirmation');
  const taintedConfirm=await api.runWithTurnUserText('确认记忆 target 正确',async()=>{api.markTurnNetworkTaint();return JSON.parse(await confirm.execute({id:'target',revision:4},{sessionId:'a'}));});
  assert.equal(taintedConfirm.ok,false,'network-tainted turns cannot confirm');
  for(const name of ['memory.correct','memory.correctionStatus']){
    assert.ok(api.residentHostToolIds('worker').includes(name));assert.ok(api.residentHostToolIds('scheduler').includes(name));
    assert.ok(api.listHostToolIds('gui-full').includes(name));assert.ok(api.listHostToolIds('pty-allowlist').includes(name));assert.ok(api.listHostToolIds('acp-subset').includes(name));
    assert.equal(api.getHostToolMeta(name).bind,'actor');
  }
  assert.equal(api.hostToolPermissionClass('memory.correct'),'edit');assert.equal(api.hostToolPermissionClass('memory.correctionStatus'),'read');
  console.log('memory-correction-host: actual GUI/executor/queue route, scope, provenance, source binding, ownership and exposure passed');
}finally{
  if(api&&ctx)for(const id of ['one','two'])await api.closeMemoryCurator(ctx,id);
  assert.equal(path.dirname(path.resolve(temp)),scratch);assert.ok(path.basename(temp).startsWith('correction-host-'));
  fs.rmSync(temp,{recursive:true,force:true});
}
