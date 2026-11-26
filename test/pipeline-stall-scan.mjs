import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createSharedCompiler} from './helpers/shared-compile.mjs';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pipeline-stall-')),compile=createSharedCompiler(process.cwd(),tmp),load=p=>import(pathToFileURL(compile(p)).href);
try{
 const {PipelineStallScanner}=await load('main/pipeline/stallScanner.ts');
 const {RuntimeAwarenessStore}=await load('main/awareness/store.ts');
 const {isStallPushEligible,decideStallScanAction}=await load('shared/pipelineStallScan.ts');
 const now=1700000000000,stall=15*60000;
 for(const lifecycle of ['idle','blocked','exited','starting'])assert.equal(isStallPushEligible({lifecycle}),false);
 for(const lifecycle of ['working','quiet'])assert.equal(isStallPushEligible({lifecycle}),true);
 assert.equal(isStallPushEligible({lifecycle:'working',phase:{value:'done'}}),false);
 assert.equal(isStallPushEligible({lifecycle:'working',archived:true}),false);
 const workers=[{id:'active',type:'terminal',workspaceId:'w',name:'Active',lifecycle:'working',activity:{kind:'active',ts:now-stall*2}},
 {id:'idle',type:'terminal',workspaceId:'w',lifecycle:'idle'}, {id:'done',type:'terminal',workspaceId:'w',lifecycle:'working',phase:{value:'done',ts:now-stall*2}}];
 const awareness=new RuntimeAwarenessStore(tmp),ctx={awareness,config:{get:()=>({pipeline:{stallMs:stall}})},sessions:{list:()=>workers},workspaces:{list:()=>[{id:'w',path:tmp}]}};
 const scanner=new PipelineStallScanner({ctx});
 const first=await scanner.scanOnce(now);assert.equal(first.facts.length,1);assert.equal(first.facts[0].sessionId,'active');
 assert.equal((await scanner.scanOnce(now+1)).facts.length,0,'same stall epoch is not repeated');
 workers[0].activity.ts=now+2;
 const recovery=await scanner.scanOnce(now+3);assert.equal(recovery.facts.length,1);assert.equal(recovery.facts[0].data.recovered,true);
 assert.equal((await scanner.scanOnce(now+stall*2)).facts.length,1,'new stall is observable after recovery');
 workers.shift();await scanner.scanOnce(now+stall*3);assert.equal(scanner.epochs.has('active'),false);
 assert.equal(awareness.getStallEpoch('active'),undefined,'F-04：会话消失后持久停滞段一并清');
 assert.deepEqual(decideStallScanAction(undefined,'working'),{type:'skip'});
 // ---- F-04 回归：停滞段去重状态与滚动账本解耦——账本淘汰不再导致同段重复推送（还原 → 转红）----
 // 注意 runtimeStartedAt 计入活动parts：要判停滞必须让「运行时启动 + 活动」都足够老
 {
  const {FACT_EVENT_MAX_COUNT}=await load('shared/runtimeFacts.ts');
  const evictWorkers=[{id:'stall-evict',type:'terminal',workspaceId:'w',name:'S',lifecycle:'working',runtimeStartedAt:now-stall*2,runtimePresence:'running',activity:{kind:'active',ts:now-stall*2}}];
  const evictAwareness=new RuntimeAwarenessStore(path.join(tmp,'stall-evict'));
  const evictCtx={awareness:evictAwareness,config:{get:()=>({pipeline:{stallMs:stall}})},sessions:{list:()=>evictWorkers},workspaces:{list:()=>[{id:'w',path:tmp}]}};
  const evictScanner=new PipelineStallScanner({ctx:evictCtx});
  const enter=await evictScanner.scanOnce(now);
  assert.equal(enter.facts.length,1);assert.equal(enter.facts[0].data.stalled,true);
  assert.equal(enter.facts[0].data.runtimeStartedAt,now-stall*2);
  // 灌满事实账本把 stalled 事实挤出（400 条/128KB 滚动淘汰）
  for(let i=0;i<FACT_EVENT_MAX_COUNT+50;i++)evictAwareness.recordFact({id:`filler-${i}`,kind:'git.integrate',ts:now+1+i,summary:'filler',data:{},source:'event'});
  assert.equal(evictAwareness.listFacts().some(f=>f.kind==='pipeline.verdict'),false,'前置：stalled 事实确已被滚动账本淘汰');
  assert.equal((await evictScanner.scanOnce(now+1)).facts.length,0,'同一停滞段不因账本淘汰重复推送');
  // 第二个 Worker 入段后整体消失：持久停滞段被清，不随名单滞留
  evictWorkers.push({id:'stall-gone',type:'terminal',workspaceId:'w',name:'G',lifecycle:'working',runtimeStartedAt:now-stall*2,runtimePresence:'running',activity:{kind:'active',ts:now-stall*2}});
  assert.equal((await evictScanner.scanOnce(now+2)).facts.length,1,'新 Worker 首次停滞入账');
  assert.ok(evictAwareness.getStallEpoch('stall-gone'),'入段即持久');
  evictWorkers.pop();
  assert.equal((await evictScanner.scanOnce(now+3)).facts.length,0,'消失的会话不再推事实');
  assert.equal(evictAwareness.getStallEpoch('stall-gone'),undefined,'会话消失后持久停滞段被清');
  // 运行时重启（runtimeStartedAt 变化）：新实例先活跃再安静，属新停滞段可再次推送
  evictWorkers[0].runtimeStartedAt=now+4;evictWorkers[0].activity={kind:'active',ts:now+4};
  assert.equal((await evictScanner.scanOnce(now+5)).facts.length,0,'刚重启还在宽限内，不判停滞');
  const restarted=await evictScanner.scanOnce(now+4+stall);
  assert.equal(restarted.facts.length,1,'重启后是新运行时实例，属新停滞段');
  assert.equal(restarted.facts[0].data.runtimeStartedAt,now+4);
  // 恢复仍可观测，且不重复
  evictWorkers[0].activity={kind:'active',ts:now+4+stall+1};
  const rec=await evictScanner.scanOnce(now+4+stall+1);
  assert.equal(rec.facts.length,1);assert.equal(rec.facts[0].data.recovered,true,'账本被灌满后恢复仍可观测');
  assert.equal((await evictScanner.scanOnce(now+4+stall+2)).facts.length,0,'恢复不重复');
  console.log('stall-scan: F-04 停滞段去重持久化（账本淘汰不重复推送/重启新段/消失清段）');
 }
 {
  let release, entered=false;
  const closingScanner=new PipelineStallScanner({ctx});
  closingScanner.scanWorker=async()=>{entered=true;await new Promise(resolve=>{release=resolve;});return null;};
  const scan=closingScanner.scanOnce(now);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(entered,true);
  let drained=false;const draining=closingScanner.shutdown().then(()=>{drained=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false,'shutdown waits the accepted scan callback');
  assert.equal((await closingScanner.scanOnce(now)).skipped,true,'shutdown blocks new scans');
  release();await scan;await draining;
  assert.throws(()=>closingScanner.start(),/stopping/);
 }
 {
  let finish, stop, drained=false;
  const held=new Promise(resolve=>{finish=resolve;});
  const reentrant=new PipelineStallScanner({ctx});
  reentrant.scanWorker=async()=>{stop=reentrant.shutdown().then(()=>{drained=true;});await held;return null;};
  const accepted=reentrant.scanOnce(now);
  try{await new Promise(resolve=>setImmediate(resolve));assert.ok(stop);assert.equal(drained,false,'synchronous scan dependency cannot escape the registered shutdown barrier');}
  finally{finish();await accepted;await stop;}
 }
 console.log('pipeline-stall-scan: OK (real session eligibility, idle/completed excluded, one per epoch, recovery/re-entry, no shared task lookup, shutdown drain)');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
