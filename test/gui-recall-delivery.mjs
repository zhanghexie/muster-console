import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const root=process.cwd(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'gui-recall-delivery-'));
const require=createRequire(import.meta.url),ts=require('typescript'),Module=require('module');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:filename}).outputText,filename);
const load=Module._load;
Module._load=function(request,parent,isMain){
  if(request==='electron')return {app:{getPath:()=>tmp,getAppPath:()=>root,isReady:()=>true},ipcMain:{handle(){},on(){}}};
  if(request==='@earendil-works/pi-coding-agent')return {getAgentDir:()=>tmp,DefaultResourceLoader:class{async reload(){} getSkills(){return {skills:[]};}}};
  if(request==='../../turnChanges/runtime')return {turnChanges:()=>({begin:(_owner,id)=>{
    const summary={id:`snapshot-${id}`,state:'collecting',files:[],warnings:[]};
    return {summary,ready:Promise.resolve(),toolStart(){},toolEnd(){},finish:async()=>({...summary,state:'ready'})};
  }})};
  return load.apply(this,arguments);
};
const {AgentSessionHost}=require(path.join(root,'src/main/agentSession/host.ts'));
const {setMemoryService}=require(path.join(root,'src/main/memory/serviceRef.ts'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const messages=[],row={id:'recall',name:'recall',runtime:'pi',type:'terminal',cwd:tmp};
const ctx={getWindow:()=>null,store:{loadSessions:()=>[]},sessions:{get:id=>id===row.id?row:undefined,engineSweepRoster:()=>[row],
  applyActivitySignal(){},touchUsed(){},updateRuntimeHandle(){},resetRuntimeHandle(){},rootDependencyRoster:()=>[]},
  config:{get:()=>({workspaces:[],llm:{providers:[{id:'p1',name:'Fixture provider',baseUrl:'https://example.test/v1',apiKey:'fixture',models:[{id:'m1',name:'Fixture model'}],enabled:true}],activeProviderId:'p1',activeModelId:'m1'},agentRules:[]}),effectiveMcp:()=>({servers:[]})},
  runtimes:{list:()=>[]},bgTasks:null};
const queue={items:[],closed:false,push(item){this.items.push(item);},async *[Symbol.asyncIterator](){while(!this.closed){if(this.items.length)yield this.items.shift();else await new Promise(resolve=>{const timer=setTimeout(resolve,5);timer.unref();});}}};
const connection={events:queue,async send(text){messages.push(text);},async abort(){queue.closed=true;},async close(){queue.closed=true;}};
const driver={runtimeId:'pi',supportsImages:false,supportsSeed:false,modelOverridePolicy:'reconnect',thinkingPolicy:'hot',connect:async()=>connection};
const recall='### 相关记忆参考\n先核实适用条件。\n- [fixture r1] 同一条经验\n  适用：条件A；例外：条件B\n  依据：未经独立验证';
setMemoryService({knowledge:()=>({}),injectKnowledge:()=>({text:''}),recallKnowledge:async()=>recall});
const host=new AgentSessionHost(ctx,{userDataDir:tmp});
try {
  host.registerDriver(driver);host.open(row);
  await host.send(row.id,'第一轮');await sleep(35);assert.match(messages[0],/适用：条件A/);
  queue.push({type:'text-delta',delta:'完成'});queue.push({type:'turn-complete'});await sleep(55);
  await host.send(row.id,'第二轮');await sleep(35);
  assert.match(messages[1],/上一轮已提供/);assert.doesNotMatch(messages[1],/适用：条件A/);
  queue.push({type:'turn-complete'});await sleep(55);
  assert.ok(host.getHistory(row.id).messages.at(-1).error,'empty completion is a failed delivery');
  await host.send(row.id,'第三轮');await sleep(35);
  assert.match(messages[2],/适用：条件A/,'empty failed turn cannot establish a deduplication receipt');
  queue.push({type:'compaction',phase:'start'});queue.push({type:'compaction',phase:'end'});
  queue.push({type:'text-delta',delta:'完成'});queue.push({type:'turn-complete'});await sleep(55);
  await host.send(row.id,'第四轮');await sleep(35);
  assert.match(messages[3],/适用：条件A/,'compaction while the turn runs invalidates the context receipt');
  queue.push({type:'text-delta',delta:'完成'});queue.push({type:'turn-complete'});await sleep(55);
  console.log('gui-recall-delivery: real host/driver turns, empty output and compaction preserve recall boundaries');
} finally {
  await host.close(row.id);queue.closed=true;setMemoryService(null);Module._load=load;fs.rmSync(tmp,{recursive:true,force:true});
}
