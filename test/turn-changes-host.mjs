/** Host lifecycle races, isolated from Electron's main-process dependency graph. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src/main/agentSession/host/fileChanges.ts');
const output = ts.transpileModule(fs.readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let beginImpl;
let syncs = 0, persists = 0;
const module = new Module(file);
module.require = name => {
  if(name==='../../turnChanges/runtime') return {turnChanges:()=>({begin:(...args)=>beginImpl(...args)})};
  if(name==='../../turnChanges/rootDirs') return {reviewRootDirs:()=>new Map()};
  if(name==='../../turnChanges/pathCapture') return {nativeWritePaths:(_name,input)=>input.path?[{path:input.path}]:[]};
  if(name==='./base') return {syncEntry:()=>syncs++,persistEntry:()=>persists++};
  if(name==='../../memory/runtime') return {ingestGuiSessionOnRelease(){}};
  return require(name);
};
module._compile(output,file);
const {beginFileChanges,finishFileChanges,noteFileChangeStart,noteFileChangeEnd}=module.exports;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const hostFor=entry=>({entries:new Map([[entry.sessionId,entry]]),ctx:{sessions:{get(){return {};}}}});
function tracker(id, ready = Promise.resolve()) {
  return {summary:{id,state:'collecting',files:[],warnings:[]},ready,calls:0,async finish(){this.calls++;return {...this.summary,state:'ready'};},toolStart(){},toolEnd(){}};
}
{
  // A late-settling preparation must never leak into the next turn's tracker.
  let release;
  const first=tracker('first',new Promise(r=>{release=r;})),second=tracker('second');
  let count=0; beginImpl=()=>++count===1?first:second;
  const a={id:'a'},b={id:'b'},entry={sessionId:'s',cwd:'.',messages:[a,b]};
  beginFileChanges(hostFor(entry),entry,a);
  assert.equal(a.turnChanges.id,'first');
  assert.equal(a.turnChanges.state,'collecting');
  finishFileChanges(hostFor(entry),entry,a);
  assert.equal(a.turnChanges.finalizing,true);
  assert.equal(a.turnChanges.preparing,false);
  beginFileChanges(hostFor(entry),entry,b); release(); await first.ready; await tick();
  assert.equal(first.calls,1); assert.equal(second.calls,0,'old capture must not finish the next tracker');
  assert.equal(b.turnChanges.id,'second','settlement keeps the real snapshot identity');
  finishFileChanges(hostFor(entry),entry,b); await tick(); assert.equal(second.calls,1);
}
{
  const t=tracker('capture'); beginImpl=()=>t;
  const message={id:'m'},entry={sessionId:'s',cwd:'.',messages:[message]};
  beginFileChanges(hostFor(entry),entry,message); await t.ready; await tick(); syncs=0;persists=0;
  entry.messages=[];entry.closed=true;finishFileChanges(hostFor(entry),entry);await tick();
  assert.equal(t.calls,1);assert.equal(syncs,0);assert.equal(persists,0);
}
{
  // begin() itself throwing must degrade review without failing the turn.
  beginImpl=()=>{throw new Error('EACCES fixture');};
  const message={id:'failure'},entry={sessionId:'s',cwd:'.',messages:[message]};
  beginFileChanges(hostFor(entry),entry,message);
  assert.equal(message.turnChanges.state,'error');
  assert.equal(message.turnChanges.preparing,undefined);
  assert.match(message.turnChanges.warnings[0],/文件审阅初始化失败/);
  finishFileChanges(hostFor(entry),entry); await tick();
  assert.equal(message.turnChanges.state,'error');
}
{
  // A tracker whose capture hooks throw must not break the event pump wrappers.
  const boom=Object.assign(tracker('boom'),{toolStart(){throw new Error('capture exploded');},toolEnd(){throw new Error('end exploded');}});
  beginImpl=()=>boom;
  const message={id:'boom'},entry={sessionId:'s',cwd:'.',messages:[message]};
  beginFileChanges(hostFor(entry),entry,message);
  assert.doesNotThrow(()=>noteFileChangeStart(entry,'t1','write',{path:'x'}));
  assert.doesNotThrow(()=>noteFileChangeEnd(entry,'t1',true));
  finishFileChanges(hostFor(entry),entry); await tick();
  assert.equal(boom.calls,1);
}
{
  let release;
  const t=tracker('closed-prepare',new Promise(r=>{release=r;}));
  beginImpl=()=>t;
  const message={id:'closed'}, entry={sessionId:'s',cwd:'.',messages:[message]};
  beginFileChanges(hostFor(entry),entry,message);
  entry.closed=true; entry.messages=[]; finishFileChanges(hostFor(entry),entry); syncs=0; persists=0;
  release(); await t.ready; await tick();
  assert.equal(t.calls,1); assert.equal(syncs,0); assert.equal(persists,0,'late ready must not republish removed messages');
}
console.log('turn-changes-host: lifecycle races, isolation and pump guards passed');
