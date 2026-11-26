// Reuse the existing host/fake-driver fixture; filesystem capture is the real service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireTestLease } from './helpers/lease.mjs';

const originalFlag = process.argv.indexOf('--original');
const originalCommit = originalFlag < 0 ? undefined : process.argv[originalFlag + 1];
if (originalFlag >= 0 && !/^[0-9a-f]{7,40}$/i.test(originalCommit ?? '')) {
  throw new Error('Usage: node test/turn-changes-host-resilience.mjs --original <commit>');
}

const root = process.cwd(), releaseLease = acquireTestLease(root);
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'review-host-acceptance-'));
let source = fs.readFileSync(path.join(root, 'test/gui-host-lifecycle.mjs'), 'utf8').split('const tests = [')[0];
const declaration = "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');";
assert(source.includes(declaration), 'lifecycle fixture root declaration changed; recheck the generator');
source = source.replace(declaration, `const root = ${JSON.stringify(root)};`)
  .replace("from './helpers/codex-worktree.mjs'", `from ${JSON.stringify(new URL('./helpers/codex-worktree.mjs', import.meta.url).href)}`);
source = source.replace('let piStub = null;', 'let piStub = null; let acceptanceService;');
if(originalCommit) {
  const marker="const source = fs.readFileSync(filename, 'utf8');";
  assert(source.includes(marker),'lifecycle TypeScript loader changed; recheck original control');
  const oldFiles=['src/main/turnChanges/service.ts','src/main/turnChanges/baseline.ts','src/main/agentSession/host/fileChanges.ts','src/main/agentSession/host/turn.ts'];
  source=source.replace(marker,`const rel=path.relative(root,filename).replace(/\\\\/g,'/');
    const source=${JSON.stringify(oldFiles)}.includes(rel)
      ? require('node:child_process').execFileSync('git',['show',${JSON.stringify(originalCommit)}+':'+rel],{cwd:root,encoding:'utf8',windowsHide:true})
      : fs.readFileSync(filename,'utf8');`);
}
const start = source.indexOf("  if (request === '../../turnChanges/runtime') {");
const end = source.indexOf("  if (request === 'electron')", start);
assert(start > 0 && end > start, 'lifecycle runtime stub changed; recheck the generator');
source = source.slice(0, start) + "  if (request === '../../turnChanges/runtime') return {turnChanges: () => acceptanceService};\n" + source.slice(end);
source += `
const acceptanceDir = ${JSON.stringify(tmp)};
const work = path.join(acceptanceDir, 'work'); fs.mkdirSync(work);
const { TurnChangeService } = require(path.join(root, 'src/main/turnChanges/service.ts'));
acceptanceService = new TurnChangeService(path.join(acceptanceDir, 'capture'));
const begin = acceptanceService.begin.bind(acceptanceService);
let releasePreparation;
const blocked = new Promise(resolve => { releasePreparation = resolve; });
acceptanceService.begin = (...args) => { const tracker=begin(...args); tracker.ready=Promise.all([tracker.ready,blocked]).then(()=>{}); return tracker; };
const {host, ctx} = makeHost(path.join(acceptanceDir, 'profile'));
const {driver, state} = makeFakeDriver(); host.registerDriver(driver);
const row = session('acceptance', {cwd: work}); ctx.__sessionsDb.set(row.id, row); host.open(row);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, message) => {
  const deadline = Date.now() + 1800;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert(predicate(), message);
};
async function checkLateOwner(kind) {
  const file=path.join(work,'owned.txt');fs.writeFileSync(file,'before');
  const {host:lateHost,ctx:lateContext}=makeHost(path.join(acceptanceDir,'late-'+kind));
  const {driver:lateDriver,state:lateDriverState}=makeFakeDriver();lateHost.registerDriver(lateDriver);
  const lateRow=session('late-'+kind,{cwd:work});lateContext.__sessionsDb.set(lateRow.id,lateRow);lateHost.open(lateRow);
  const pushes=[];lateHost.pushSubs.add(event=>pushes.push(event));
  const save=acceptanceService.save.bind(acceptanceService);
  let releaseSave,saving=false,tracked;
  const saveGate=new Promise(resolve=>{releaseSave=resolve;});
  acceptanceService.save=async record=>{saving=true;await saveGate;return save(record);};
  try {
    await lateHost.send(lateRow.id,'owned turn');
    await until(()=>typeof lateDriverState.resolveConnect==='function','warm owner must connect');lateDriverState.resolveConnect();
    await until(()=>lateDriverState.sends.length===1,'warm owner must send');
    const entry=lateHost.entries.get(lateRow.id),message=entry.assistant;
    tracked=[...acceptanceService.active].find(candidate=>candidate.summary.id===message.turnChanges.id);assert(tracked);
    await tracked.ready;
    await tracked.toolStart('write','write',{path:'owned.txt',content:'after'},undefined,true);fs.writeFileSync(file,'after');await tracked.toolEnd('write',true,undefined,true);
    lateDriverState.queue.push({type:'turn-complete'});
    await until(()=>saving,'real snapshot save must reach the controlled gate');
    await until(()=>!lateHost.isBusy(lateRow.id),'real snapshot save must not retain busy');
    if(kind==='entry') lateHost.entries.set(lateRow.id,{...entry,messages:[]});
    if(kind==='message') entry.messages=[];
    if(kind==='snapshot') message.turnChanges={...message.turnChanges,id:'replacement-snapshot'};
    const before=pushes.filter(event=>event.kind==='sync').length;
    releaseSave();await tracked.finish();await delay(40);
    assert.equal(pushes.filter(event=>event.kind==='sync').length,before,'late GUI completion cannot publish after '+kind+' ownership changes');
    if(kind==='snapshot') assert.equal(message.turnChanges.id,'replacement-snapshot','late GUI completion cannot overwrite the replacement snapshot');
  } finally {
    releaseSave();if(tracked)await tracked.finish();acceptanceService.save=save;await lateHost.close(lateRow.id);
  }
}
try {
  await host.send(row.id, 'first request');
  await until(() => typeof state.resolveConnect === 'function', 'slow baseline must not delay driver connection');
  state.resolveConnect();
  await until(() => state.sends.length === 1, 'slow baseline must not delay model send');
  const first = host.entries.get(row.id).assistant;
  const tracker = [...acceptanceService.active][0]; assert(tracker, 'tracker must be registered before model tools');
  assert.equal(tracker.executionStarted,true,'a real driver send marks execution before any SDK event arrives');
  assert.equal(first.turnChanges?.id,tracker.summary.id,'the live GUI message must own its snapshot ID before preparation; collision publishing matches this ID');
  // A capture callback fault must not escape through the actual host event pump.
  tracker.toolStart = () => { throw new Error('injected observer start fault'); };
  tracker.toolEnd = () => { throw new Error('injected observer end fault'); };
  state.queue.push({type:'text-delta',delta:'normal response'});
  state.queue.push({type:'tool-start',toolCallId:'tool-1',toolName:'write',input:{path:'a.txt',content:'text'}});
  state.queue.push({type:'tool-result',toolCallId:'tool-1',ok:true,result:'ok'});
  await delay(60);
  assert.equal(first.error, undefined, 'capture exceptions must not become assistant errors');
  assert.equal(host.isBusy(row.id), true, 'observer failure must not close the physical turn');
  assert.equal((await host.send(row.id, 'queued request')).queued, true);
  state.queue.push({type:'turn-complete'});
  await until(() => state.sends.length === 2, 'background capture must not prevent queue dispatch');
  state.queue.push({type:'text-delta',delta:'second response'});
  state.queue.push({type:'turn-complete'});
  await until(() => !host.isBusy(row.id), 'background preparation/save must not hold busy');
  assert.equal(first.error, undefined);
  await host.close(row.id);
  releasePreparation();
  await delay(100);
  assert.equal(host.entries.has(row.id), false, 'late review completion cannot reopen a closed host entry');
  for(const kind of ['entry','message','snapshot'])await checkLateOwner(kind);
  const result = {passed:true, platform:process.platform, cases:['connect/send while identity lookup is blocked','live snapshot identity before lookup','observer exceptions isolated','queue dispatch while review pending','late completion after close','late save after entry replacement','late save after message removal','late save after snapshot replacement']};
  fs.writeFileSync(path.join(acceptanceDir,'results.json'), JSON.stringify(result,null,2));
  console.log(JSON.stringify({tmp:acceptanceDir,...result},null,2));
} finally {
  releasePreparation();
  await host.close(row.id);
  await delay(100);
  acceptanceService.dispose();
}
`;
const generated = path.join(tmp, 'probe.mjs');
fs.writeFileSync(generated, source);
try { await import(pathToFileURL(generated)); }
finally { releaseLease(); }
