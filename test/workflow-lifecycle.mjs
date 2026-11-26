/** Regression: cancellation across trust awaits, durable failures, admission. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-lifecycle-'));
const compile = createSharedCompiler(repo, path.join(fixture, 'compiled'));
const { WorkflowRuntime } = await import(pathToFileURL(compile('main/workflow/runtime.ts')).href);
const { readRunRecord, listRunRecords, writeRunRecord } = await import(pathToFileURL(compile('main/workflow/store.ts')).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate, label) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5000) throw new Error(`Timeout: ${label}`);
    await delay(10);
  }
}
function writeWorkflow(root, name, script) {
  const dir = path.join(root, '.muster', 'workflows', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), `---\nname: ${name}\ndescription: regression fixture\n---\n`);
  fs.writeFileSync(path.join(dir, 'run.mjs'), script);
}
const runtimes = [];
function runtime(root, extra = {}) {
  const rt = new WorkflowRuntime({
    workspaceIds: () => ['ws'], workspaceRoot: () => root,
    emit: () => {}, delegate: async (_ws, input) => ({ sessionId: 'session', taskId: input.creationKey }),
    executeTool: async () => ({ ok: true }),
    ensureTrusted: async () => true, trustState: () => 'trusted',
    setInterval: () => 0, clearInterval: () => {}, ...extra
  });
  runtimes.push(rt);
  return rt;
}
const cases = [];
const test = (name, run) => cases.push({ name, run });
for (const action of ['cancel', 'shutdown']) test(`child trust resolved after ${action}`, async () => {
  const root = path.join(fixture, action);
  writeWorkflow(root, 'parent', `export default async wf => await wf.call('child', {});`);
  writeWorkflow(root, 'child', `export default async wf => { await wf.delegate({task:'child'}); await wf.ask('hold'); };`);
  const trust = deferred();
  let waiting = false, delegated = 0;
  const rt = runtime(root, {
    ensureTrusted: async (_ws, wf) => { if (wf.name === 'child') { waiting = true; await trust.promise; } return true; },
    delegate: async () => { delegated++; return { sessionId: 'late' }; }
  });
  const parent = await rt.startRun('ws', 'parent', {});
  await until(() => waiting, 'child confirmation');
  if (action === 'cancel') await rt.cancel('ws', parent.runId, 'cancel', { closeSessions: true });
  else rt.shutdown();
  trust.resolve();
  await delay(200);
  assert.equal(delegated, 0, 'no child side effect after parent stops');
  assert.equal(listRunRecords(root).filter(r => r.name === 'child').length, 0);
  if (action === 'cancel') assert.equal(readRunRecord(root, parent.runId).status, 'cancelled');
});

for (const stage of ['launch', 'delegate', 'answer', 'wait', 'completion']) test(`record failure at ${stage}`, async () => {
  const root = path.join(fixture, stage);
  const scripts = {
    launch: `await wf.delegate({task:'must not dispatch'});`,
    delegate: `await wf.ask('gate'); await wf.delegate({task:'must not dispatch'});`,
    answer: `await wf.ask('gate'); await wf.delegate({task:'must not dispatch'});`,
    wait: `await wf.waitFor({kind:'phase',sessionId:'t1',trigger:['done']}); await wf.delegate({task:'must not dispatch'});`,
    completion: `await wf.ask('gate'); return 'done';`
  };
  writeWorkflow(root, 'demo', `export default async wf => { ${scripts[stage]} };`);
  const events = [];
  let delegated = 0;
  const rt = runtime(root, { delegate: async () => { delegated++; return {}; }, emit: (_ws, e) => events.push(e) });
  const rename = fs.renameSync;
  let fail = stage === 'launch';
  let writes = 0;
  fs.renameSync = function(from, to, ...args) {
    if (String(to).startsWith(root) && String(to).includes('workflow-runs')) {
      if (stage === 'delegate' && fail && ++writes === 1) return rename.call(this, from, to, ...args); // persist answer first
      if (fail) throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
    }
    return rename.call(this, from, to, ...args);
  };
  try {
    let rec;
    if (stage === 'launch') await assert.rejects(rt.startRun('ws', 'demo', {}), /保存|落盘/);
    else {
      rec = await rt.startRun('ws', 'demo', {});
      await until(() => rt.get('ws', rec.runId).status === 'waiting', 'wait registered');
      fail = true;
      if (stage === 'wait') assert.doesNotThrow(() => rt.onEvent('ws', {kind:'phase',sessionId:'t1',trigger:'done'}));
      else if (stage === 'answer') assert.throws(() => rt.reply('ws', rec.runId, rt.get('ws',rec.runId).pendingAsk.askId, 'go'), /保存|落盘/);
      else {
        // completion must successfully save the answer before failing the terminal record.
        if (stage === 'completion') fail = false;
        rt.reply('ws', rec.runId, rt.get('ws',rec.runId).pendingAsk.askId, 'go');
        fail = true;
      }
    }
    await until(() => events.some(e => e.trigger === 'failed'), 'storage failure event');
    const failed = rt.overview('ws').recent.find(r => r.status === 'failed');
    assert.ok(failed, 'failure remains visible even when primary record never existed');
    assert.equal(rt.overview('ws').active.length, 0);
    assert.equal(delegated, 0, 'storage failure prevents next side effect');
    assert.equal(events.some(e => e.trigger === 'completed'), false, 'no false success');
    assert.equal(readRunRecord(root, failed.runId).status, 'failed', 'durable failure overrides stale running record');
    rt.shutdown();
    const restart = runtime(root, { delegate: async () => { delegated++; return {}; } });
    restart.resumeAll();
    await delay(80);
    assert.equal(restart.overview('ws').active.length, 0);
    assert.equal(delegated, 0, 'restart does not replay failed operation');
    fail = false;
    assert.equal(rt.clearRuns('ws'), 1);
    assert.equal(rt.overview('ws').recent.length, 0, 'clearing removes in-memory failure too');
    assert.equal(readRunRecord(root, failed.runId), null, 'clearing cannot reveal old checkpoint');
  } finally { fs.renameSync = rename; }
});

test('concurrent admission and release after rejection', async () => {
  const root = path.join(fixture, 'admission');
  writeWorkflow(root, 'demo', `export default async wf => await wf.ask('hold');`);
  const gate = deferred();
  let asked = 0, denyFirst = true;
  const rt = runtime(root, { ensureTrusted: async () => { const n = ++asked; await gate.promise; return !(denyFirst && n === 1); } });
  const pending = Array.from({length:4}, () => rt.startRun('ws','demo',{}));
  const outcomes = Promise.allSettled(pending); // attach rejects before any wait
  await delay(20);
  gate.resolve();
  const results = await outcomes;
  assert.equal(asked, 3, 'pending confirmations reserve capacity');
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  denyFirst = false;
  await rt.startRun('ws','demo',{}); // denied confirmation released its slot
  await assert.rejects(rt.startRun('ws','demo',{}), /上限/);
  assert.equal(rt.overview('ws').active.length, 3);
});
test('shutdown invalidates pending top-level admission', async () => {
  const root = path.join(fixture, 'shutdown-top');
  writeWorkflow(root,'demo',`export default async () => 1;`);
  const gate = deferred();
  const rt = runtime(root, {ensureTrusted: async () => { await gate.promise; return true; }});
  const pending = rt.startRun('ws','demo',{});
  const checked = assert.rejects(pending, /结束|关闭|失效/);
  rt.shutdown();
  gate.resolve();
  await checked;
  assert.equal(listRunRecords(root).length, 0);
});

test('automatic starts reserve the same workflow before launch', async () => {
  const root = path.join(fixture, 'auto');
  writeWorkflow(root,'demo',`export default async wf => await wf.ask('hold');`);
  const doc = path.join(root,'.muster/workflows/demo/WORKFLOW.md');
  fs.writeFileSync(doc, fs.readFileSync(doc,'utf8').replace('description:', 'on: {"kind":"phase","trigger":["done"]}\ncooldown: 1\ndescription:'));
  let now = Date.now();
  const rt = runtime(root,{now:()=>now});
  rt.checkTriggers();
  rt.onEvent('ws',{kind:'phase',sessionId:'external1',trigger:'done'});
  now += 61000;
  rt.onEvent('ws',{kind:'phase',sessionId:'external2',trigger:'done'});
  await delay(100);
  assert.equal(rt.overview('ws').active.length,1, 'pending automatic run prevents duplicate start');
});

test('both storage writes fail: visible stop and no same-process resume', async () => {
  const root = path.join(fixture,'unwritable');
  writeWorkflow(root,'demo',`export default async wf => {await wf.ask('hold'); await wf.delegate({task:'forbidden'});};`);
  let delegated = 0;
  const rt = runtime(root,{delegate:async()=>{delegated++;return {};}});
  const rec = await rt.startRun('ws','demo',{});
  await until(()=>rt.get('ws',rec.runId).pendingAsk,'pending answer');
  const rename = fs.renameSync;
  fs.renameSync = function(from,to,...args) {
    if (String(to).startsWith(root)) throw new Error('synthetic ENOSPC');
    return rename.call(this,from,to,...args);
  };
  try {
    assert.throws(()=>rt.reply('ws',rec.runId,rt.get('ws',rec.runId).pendingAsk.askId,'yes'),/保存失败/);
    assert.match(rt.overview('ws').recent[0].error,/故障记录也无法保存/);
    rt.resumeAll();
    await delay(50);
    assert.equal(rt.overview('ws').active.length,0);
    assert.equal(delegated,0);
  } finally { fs.renameSync = rename; }
  rt.shutdown();
  assert.equal(readRunRecord(root,rec.runId).status,'failed', 'shutdown retries failure record after storage recovers');
});

test('recovery write failure isolates the failed run', async () => {
  const root = path.join(fixture,'recovery');
  writeWorkflow(root,'demo',`export default async wf => await wf.ask('hold');`);
  const original = runtime(root);
  const rec = await original.startRun('ws','demo',{});
  await until(()=>original.get('ws',rec.runId).pendingAsk,'pending recovery');
  original.shutdown();
  const second = {...readRunRecord(root,rec.runId),runId:'wf-second',memo:{},pendingAsk:undefined};
  writeRunRecord(root,second);
  const rename = fs.renameSync;
  fs.renameSync = function(from,to,...args) {
    if (String(to).includes(`workflow-runs${path.sep}${rec.runId}.json`)) throw new Error('synthetic recovery EIO');
    return rename.call(this,from,to,...args);
  };
  try {
    const restart = runtime(root);
    assert.doesNotThrow(()=>restart.resumeAll());
    await until(()=>restart.get('ws','wf-second').pendingAsk,'second recovery');
    assert.equal(restart.get('ws',rec.runId).status,'failed');
    assert.equal(restart.overview('ws').active.length,1);
  } finally { fs.renameSync = rename; }
});

let failures = 0;
try {
  for (const {name, run} of cases) {
    try { await run(); console.log(`ok: ${name}`); }
    catch (err) { failures++; console.error(`FAIL: ${name}: ${err.stack}`); }
    finally { for (const rt of runtimes) rt.shutdown(); runtimes.length = 0; }
  }
} finally { fs.rmSync(fixture, {recursive:true,force:true}); }
if (failures) process.exitCode = 1;
else console.log(`workflow-lifecycle: ${cases.length} passed`);
