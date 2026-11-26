// Actual scheduler turn orchestration; model and snapshot persistence are controlled boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
import {acquireTestLease} from './helpers/lease.mjs';

const root=process.cwd(), releaseLease=acquireTestLease(root);
const tmp=fs.mkdtempSync(path.join(root,'.tmp','review-scheduler-acceptance-'));
const compiled=path.join(tmp,'compiled'), compile=createSharedCompiler(root,compiled);
const entry=compile('main/agent/orchestrator/turnExecution.ts');
const boundary=(rel,code)=>fs.writeFileSync(path.join(compiled,rel),code);
boundary('main/agent/providers/piProvider.mjs','export const abortPiTurn=()=>{}; export const disposePiSessionResources=async()=>{}; export const runPiProvider=args=>globalThis.__reviewProvider(args);');
boundary('main/agent/providers/modeExtension.mjs','export const getModeController=()=>undefined;');
boundary('main/agent/orchestrator/planModes.mjs','export const bindModeController=()=>{}; export const updatePlanCard=()=>{};');
boundary('main/agent/orchestrator/turnGate.mjs','export const releaseTurnGate=()=>{};');
boundary('main/agent/orchestrator/memoryInjection.mjs','export const composeReadPathTurnText=async(_ctx,_bucket,_id,text)=>text;');
boundary('main/turnChanges/runtime.mjs','export const turnChanges=()=>({begin:(_owner,id)=>globalThis.__reviewTracker(id)});');
boundary('main/attachments/service.mjs','export const clearAttachments=()=>{};');
const electronStub=path.join(compiled,'node_modules','electron'); fs.mkdirSync(electronStub,{recursive:true});
fs.writeFileSync(path.join(electronStub,'package.json'),JSON.stringify({type:'module',main:'index.js'}));
fs.writeFileSync(path.join(electronStub,'index.js'),`export const app={getPath:()=>${JSON.stringify(tmp)}};`);
const {startTurn}=await import(pathToFileURL(entry));
const {workspaceRootUsesFor}=await import(pathToFileURL(compile('main/workspaceRootUses.ts')));
const {initialCompactBreakerState}=await import(pathToFileURL(compile('shared/compactBreaker.ts')));
const work=path.join(tmp,'work'); fs.mkdirSync(work);
const ws={id:'ws',name:'Review Fixture',path:work,controlRoot:work,defaultRootId:'root',rootsRevision:1,roots:[{id:'root',path:work}]};
const config={get:()=>({workspaces:[ws],activeWorkspaceId:'ws'})};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cases=[];
async function runCase(name,mutate,expectReady) {
  const bucket={display:[],busy:false,resetPiOnNextSend:false,queue:[],mode:'default',compactBreaker:initialCompactBreakerState()};
  const events=[],notifications=[];
  let providerCalls=0,finishCalls=0,releaseFinish,turn,snapshot,executionStarted=false;
  const saving=new Promise(resolve=>{releaseFinish=resolve;});
  globalThis.__reviewTracker=id=>{
    snapshot={id,state:'collecting',files:[],warnings:[]};
    return {summary:snapshot,ready:Promise.resolve(),markExecutionStarted(){executionStarted=true;},toolStart(){},toolEnd(){},finish(){finishCalls++;return saving;}};
  };
  globalThis.__reviewProvider=args=>{assert(executionStarted,'scheduler marks execution before invoking the provider');providerCalls++;args.assistant.content='completed';};
  const o={ctx:{config,usage:{recordSessionActivity(){},recordDispatchTurn(){}},ui:{setBubble(){}},notify:{push:event=>notifications.push(event)}},
    buckets:new Map([['ws',bucket]]),autoRetryTimers:new Map(),autoRetryAttempts:new Map(),
    emit:(name,event)=>events.push({name,...event}),invalidatePiSession(){},abortPendingAsk(){},persistBucket(){},getThinkingLevel:()=>null,
    scheduleTranscriptIndex(){},maybeAutoCompact(){},drainQueue(){}};
  try {
  let settled=false;
  turn=startTurn(o,bucket,'ws','normal request').then(()=>{settled=true;});
  const deadline=Date.now()+1500;
  while(!finishCalls&&Date.now()<deadline) await delay(10);
  assert.equal(providerCalls,1); assert.equal(finishCalls,1);
  await delay(40);
  assert.equal(bucket.busy,false,'review persistence must not hold scheduler busy');
  assert.equal(settled,true,'scheduler turn must settle while snapshot persistence is pending');
  assert.equal(workspaceRootUsesFor(config).list('ws').length,0,'review persistence must not retain scheduler execution roots');
  assert(events.some(event=>event.name==='agent:done'));
  assert.equal(notifications.length,0,'review pending is not a scheduler failure');
  const readyEvents=()=>events.filter(event=>event.name==='agent:message'&&event.turnChanges?.state==='ready').length;
  const before=readyEvents(), assistant=bucket.display.find(message=>message.role==='assistant');
  assert(assistant,'the finished model message remains available');
  mutate(o,bucket,assistant);
  releaseFinish({...snapshot,state:'ready'});
  await delay(40);
  assert.equal(readyEvents(),before+(expectReady?1:0),name);
  cases.push({name,passed:true});
  } catch(error) { cases.push({name,passed:false,error:String(error.stack??error)}); }
  finally { releaseFinish({...snapshot,state:'ready'});await turn; }
}
try {
  await runCase('unchanged owner receives background completion',()=>{},true);
  await runCase('replaced bucket never receives stale completion',(o)=>{o.buckets.set('ws',{display:[]});},false);
  await runCase('cleared message never receives stale completion',(_o,bucket)=>{bucket.display=[];},false);
  await runCase('replaced snapshot never receives stale completion',(_o,_bucket,assistant)=>{assistant.turnChanges={...assistant.turnChanges,id:'replacement-snapshot'};},false);
  const result={tmp,passed:cases.every(test=>test.passed),platform:process.platform,cases};
  fs.writeFileSync(path.join(tmp,'results.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2));
  assert(result.passed,'scheduler acceptance failed; see results.json');
} finally {
  delete globalThis.__reviewTracker; delete globalThis.__reviewProvider;
  releaseLease();
}
