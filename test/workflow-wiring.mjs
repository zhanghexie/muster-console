/** Real workflow assembly/kernel: creation-key contract and archive-before-delete cancellation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const oldLoad = Module._load, oldTs = require.extensions['.ts'];
const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-wiring-'));
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file
}).outputText, file);
let state;
const { planCloseBatch } = require(path.join(root, 'src/shared/sessionCloseBatch.ts'));
Module._load = function(name, parent) {
  if (name === 'electron') return { app: { getPath: () => dir }, shell: { trashItem: async () => {} } };
  if (parent?.filename === path.join(root, 'src/main/tasks/delegate.ts') && name === '../capabilities/hosts/chat') return {
    buildBriefWithNamedSkills: async (_ctx, _sid, task, opts) => ({brief:task,vocab:opts.statusVocabulary ?? []})
  };
  if (parent?.filename === path.join(root, 'src/main/workflow/wiring.ts')) {
    if (name === '../tasks/delegate') return { delegateTask: async (_ctx, input) => {
      state.delegateInputs.push(input);
      if (state.realDelegate) {
        try { return await oldLoad.call(this, path.join(root,'src/main/tasks/delegate.ts'), parent).delegateTask(_ctx,input); }
        catch (error) { state.delegateError = error; throw error; }
      }
      const session = { id: `session-${state.sessions.length}`, name: input.name || 'Worker', type: 'terminal',
        runtime:'pi',cwd:dir,workspaceId: 'ws', archived: false, meta: { creationKey: input.creationKey } };
      state.sessions.push(session);
      if (state.pause) await state.pause;
      return { session, notified: false, status: 'started' };
    } };
    if (name === '../capabilities/executor') return { executeTool: async (_ctx, tool, json) => {
      const args = JSON.parse(json); state.calls.push({ tool, args });
      if (tool === 'sessions.setArchived') {
        if (state.archiveFails) return { ok: true, result: { updated: [], failed: [{ id: args.sessionIds[0], error: 'operation busy' }] } };
        for (const id of args.sessionIds) state.sessions.find(row => row.id === id).archived = args.archived;
        return { ok: true, result: { updated: args.sessionIds, failed: [] } };
      }
      assert.equal(tool, 'sessions.delete');
      const plan = planCloseBatch(state.sessions, args.sessionIds);
      const closed = plan.failed.length ? [] : plan.targets.map(row => ({ id: row.id }));
      return { ok: true, result: { closed, failed: plan.failed, aborted: !!plan.failed.length } };
    } };
  }
  return oldLoad.apply(this, arguments);
};
const { createWorkflowRuntime } = require(path.join(root, 'src/main/workflow/wiring.ts'));
const { applyLocaleSetting } = require(path.join(root, 'src/shared/i18n/index.ts'));
const { readRunRecord } = require(path.join(root, 'src/main/workflow/store.ts'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
  for (let i = 0; i < 500; i++) { if (test()) return; await delay(10); }
  throw Error(`Timeout: ${label}`);
}
const wfDir = path.join(dir, '.muster/workflows/probe');
fs.mkdirSync(wfDir, { recursive: true });
fs.writeFileSync(path.join(wfDir, 'WORKFLOW.md'), '---\nname: probe\ndescription: contract regression\n---\n');
fs.writeFileSync(path.join(wfDir, 'run.mjs'), 'export default async wf => { wf.state.worker = await wf.delegate({task:"work",isolate:false}); await wf.ask("hold"); };\n');
const active = [];
function setup() {
  state = { sessions: [], calls: [], reviews: [], confirms: 0, delegateInputs: [] };
  const config = { workspaces: [{ id: 'ws', path: dir }], extensionTrust: {} };
  const ctx = { config: { get: () => config, update: patch => Object.assign(config, patch) }, sessions: {
    listByWorkspace: () => state.sessions, get: id => state.sessions.find(s => s.id === id),
    setArchived: (id, archived) => { if (state.archiveFails) throw new Error('operation busy'); state.sessions.find(s => s.id === id).archived = archived; },
    deletePermanently: async (ids, origin) => { assert.equal(origin, 'human'); for (const id of ids) { assert.equal(state.sessions.find(s => s.id === id).archived, true); state.calls.push({ tool: 'human.delete', id }); } }
  },
    extensions: { setActionTrust: (key, fingerprint) => config.extensionTrust.ws = { [key]: fingerprint } },
    safety: { authorize: async input => { state.reviews.push(input); return { allowed: true, reason: 'reviewed' }; } },
    ui: { confirm: async () => { state.confirms++; return { confirmed: true }; }, notify() {} }, getWindow: () => null };
  state.ctx = ctx;
  const item = createWorkflowRuntime(ctx, { enqueueWorkflow() {}, addTap: () => () => {} });
  active.push(item); return item.runtime;
}
try {
  const confirmRuntime = setup();
  let shown;
  state.ctx.ui.confirm = async (...args) => { shown = args; return { confirmed: false }; };
  state.ctx.safety.authorize = async input => ({ allowed: await input.humanConfirm('审批代理需要人工确认：原始理由', new AbortController().signal), reason: '审批代理需要人工确认：原始理由' });
  try {
    applyLocaleSetting('en');
    assert.equal(await confirmRuntime.trust('ws', 'probe'), false, 'denied confirmation never grants workflow trust');
    assert.match(shown[1], /The approval agent requires human confirmation: 原始理由/);
    assert.match(shown[1], /Script:/);
    assert.match(shown[1], /Content fingerprint:/);
    assert.ok(shown[1].includes('contract regression'), 'workflow description remains unchanged');
    assert.deepEqual(state.ctx.config.get().extensionTrust, {});
  } finally { applyLocaleSetting('zh-CN'); active.pop().dispose(); }
  const trustRuntime = setup();
  assert.equal(await trustRuntime.trust('ws', 'probe'), true);
  assert.equal(state.reviews.length, 1, 'workflow code gets one independent review');
  assert.equal(state.confirms, 0, 'review allow requires no human');
  assert.match(state.reviews[0].evidence, /wf.delegate/);
  active.pop().dispose();
  const humanTrust = setup();
  assert.equal(await humanTrust.trust('ws', 'probe', 'human'), true);
  assert.equal(state.reviews.length, 0, 'the explicit human trust button does not review');
  assert.ok(state.ctx.config.get().extensionTrust.ws, 'human trust binds the current workflow fingerprint');
  active.pop().dispose();
  const changedRuntime = setup();
  const scriptFile = path.join(wfDir, 'run.mjs'), originalScript = fs.readFileSync(scriptFile, 'utf8');
  state.ctx.safety.authorize = async () => { fs.appendFileSync(scriptFile, '\n// changed during review'); return { allowed: true, reason: 'old bytes' }; };
  assert.equal(await changedRuntime.trust('ws','probe'), false, 'changed workflow cannot store stale trust');
  assert.deepEqual(state.ctx.config.get().extensionTrust, {});
  fs.writeFileSync(scriptFile, originalScript); active.pop().dispose();
  for (const [index, choice] of [undefined, 'auto', 'false'].entries()) {
    const name = `invalid-isolation-${index}`, badDir = path.join(dir,'.muster/workflows',name);
    fs.mkdirSync(badDir,{recursive:true});
    fs.writeFileSync(path.join(badDir,'WORKFLOW.md'),`---\nname: ${name}\ndescription: invalid isolation\n---\n`);
    fs.writeFileSync(path.join(badDir,'run.mjs'),`export default wf => wf.delegate(${JSON.stringify({task:'work',...(choice === undefined ? {} : {isolate:choice})})});\n`);
    const runtime = setup(), run = await runtime.startRun('ws',name,{});
    await until(()=>runtime.get('ws',run.runId).status === 'failed','invalid isolation rejected');
    const saved = readRunRecord(dir,run.runId);
    assert.equal(state.sessions.length,0,'invalid workflow cannot create or queue a worker');
    assert.equal(saved.delegates,0,'invalid workflow cannot consume delegation budget');
    assert.deepEqual(saved.memo,{},'invalid workflow cannot leave a pending memo');
    active.pop().dispose();
  }
  const writeDelegate = (name, input, catchError = false) => {
    const workflowDir = path.join(dir, '.muster/workflows', name);
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, 'WORKFLOW.md'), `---\nname: ${name}\ndescription: routing contract\n---\n`);
    const call = `await wf.delegate(${JSON.stringify(input)})`;
    fs.writeFileSync(path.join(workflowDir, 'run.mjs'), catchError
      ? `export default async wf => { try { ${call}; } catch (e) { return e.message; } };\n`
      : `export default async wf => ${call};\n`);
  };
  for (const [name, selection, target] of [
    ['tier-route', { tier: 'tier-alpha', runtime: 'runtime-a' }, { tierId: 'tier-alpha' }],
    ['ref-route', { targetRef: 'ref-alpha' }, { targetRef: 'ref-alpha' }],
    ['trim-route', { tier: '  tier-alpha  ' }, { tierId: 'tier-alpha' }],
    ['model-route', { model: { providerId: 'p', modelId: 'm' } }, undefined]
  ]) {
    writeDelegate(name, { task: 'work', isolate: false, ...selection });
    const runtime = setup(), run = await runtime.startRun('ws', name, {});
    await until(() => runtime.get('ws', run.runId).status === 'completed', `${name} completed`);
    assert.deepEqual(state.delegateInputs[0].target, target, 'workflow wiring sends the selected Worker target');
    if (selection.runtime) assert.equal(state.delegateInputs[0].runtime, selection.runtime);
    if (selection.model) assert.deepEqual(state.delegateInputs[0].model, selection.model);
    active.pop().dispose();
  }
  const invalidRoutes = [
    ...[null, '', '  ', 123, {}, []].map(tier => ({ input: { tier }, error: /wf\.delegate.*tier.*非空字符串/ })),
    ...[null, '', '  ', 123].map(targetRef => ({ input: { targetRef }, error: /wf\.delegate.*targetRef.*非空字符串/ })),
    { input: { tier: 'tier-alpha', model: { providerId: 'p', modelId: 'm' } }, error: /wf\.delegate.*tier.*model.*互斥/ },
    { input: { tier: 'tier-alpha', model: null }, error: /wf\.delegate.*tier.*model.*互斥/ },
    { input: { targetRef: 'ref-alpha', model: { providerId: 'p', modelId: 'm' } }, error: /wf\.delegate.*targetRef.*model.*互斥/ },
    { input: { tier: 'tier-alpha', targetRef: 'ref-alpha' }, error: /wf\.delegate.*tier.*targetRef.*互斥/ }
  ];
  for (const [index, { input, error }] of invalidRoutes.entries()) {
    const name = `invalid-route-${index}`;
    writeDelegate(name, { task: 'work', isolate: false, ...input });
    const runtime = setup(), run = await runtime.startRun('ws', name, {});
    await until(() => runtime.get('ws', run.runId).status === 'failed', `${name} rejected`);
    const saved = readRunRecord(dir, run.runId);
    assert.match(saved.error, error);
    assert.equal(state.delegateInputs.length, 0, 'invalid route cannot reach delegation');
    assert.equal(saved.delegates, 0, 'invalid route cannot consume delegation budget');
    assert.deepEqual(saved.memo, {}, 'invalid route cannot leave a pending memo');
    active.pop().dispose();
  }
  writeDelegate('unknown-tier', { task: 'work', isolate: false, tier: 'not-configured' }, true);
  const unknown = setup(); state.realDelegate = true;
  const unknownRun = await unknown.startRun('ws', 'unknown-tier', {});
  await until(() => unknown.get('ws', unknownRun.runId).status === 'completed', 'unknown tier surfaced to script');
  const { WorkerOptionError } = require(path.join(root, 'src/main/tasks/workerRoutingCatalog.ts'));
  assert.ok(state.delegateError instanceof WorkerOptionError, 'unknown tier comes from the real Worker route');
  assert.match(state.delegateError.message, /Worker tier is not configured/);
  assert.equal(readRunRecord(dir, unknownRun.runId).result, state.delegateError.message, 'script receives the original host error message');
  assert.equal(readRunRecord(dir, unknownRun.runId).delegates, 0, 'failed route restores the delegation budget');
  assert.deepEqual(readRunRecord(dir, unknownRun.runId).memo, {}, 'failed route clears its pending memo');
  assert.equal(state.sessions.length, 0);
  active.pop().dispose();

  const rt = setup(), rec = await rt.startRun('ws', 'probe', {});
  await until(() => rt.get('ws', rec.runId).pendingAsk, 'delegate result');
  const saved = readRunRecord(dir, rec.runId), worker = state.sessions[0];
  assert.equal(saved.state.worker.taskId, worker.meta.creationKey);
  assert.equal(typeof saved.state.worker.taskId, 'string');
  assert.deepEqual(saved.tasks, [worker.meta.creationKey]);
  assert.equal(planCloseBatch(state.sessions, [worker.id]).failed[0].reason, 'unarchived', 'real deletion precondition');
  const cancelled = await rt.cancel('ws', rec.runId, 'test', { closeSessions: true });
  assert.deepEqual(cancelled.closed, [worker.id]);
  assert.deepEqual(state.calls.map(call => call.tool), ['sessions.setArchived', 'sessions.delete']);
  active.pop().dispose();

  const human = setup(), humanRec = await human.startRun('ws', 'probe', {});
  await until(() => human.get('ws', humanRec.runId).pendingAsk, 'human cancellation fixture');
  state.calls = []; state.reviews = [];
  const humanCancelled = await human.cancel('ws', humanRec.runId, 'human', { closeSessions: true, initiatedBy: 'human' });
  assert.deepEqual(humanCancelled.closed, [state.sessions[0].id]);
  assert.deepEqual(state.calls.map(call => call.tool), ['human.delete']);
  assert.equal(state.reviews.length, 0, 'human cancellation uses the human deletion path');
  active.pop().dispose();

  const fail = setup(), failRec = await fail.startRun('ws', 'probe', {});
  await until(() => fail.get('ws', failRec.runId).pendingAsk, 'failed archive fixture');
  state.archiveFails = true;
  const failure = await fail.cancel('ws', failRec.runId, 'test', { closeSessions: true });
  assert.deepEqual(failure.closed, []); assert.match(failure.failed[0].error, /operation busy/);
  assert.equal(state.sessions[0].archived, false);
  assert.deepEqual(state.calls.map(call => call.tool), ['sessions.setArchived'], 'no deletion after archive failure');
  active.pop().dispose();

  const late = setup(); let release;
  state.pause = new Promise(resolve => { release = resolve; });
  const lateRec = await late.startRun('ws', 'probe', {});
  await until(() => state.sessions.length, 'in-flight delegation');
  const cancelledLate = await late.cancel('ws', lateRec.runId, 'test', { closeSessions: true });
  assert.equal(cancelledLate.lateDelegates.length, 1); release();
  await until(() => state.calls.some(call => call.tool === 'sessions.delete'), 'late compensation');
  assert.equal(state.sessions[0].archived, true);
  assert.deepEqual(state.calls.map(call => call.tool), ['sessions.setArchived', 'sessions.delete']);
  await until(() => readRunRecord(dir, lateRec.runId).tasks.length === 1, 'late creation key bookkeeping');

  active.pop().dispose();
  const humanLate = setup(); let releaseHuman;
  state.pause = new Promise(resolve => { releaseHuman = resolve; });
  const humanLateRec = await humanLate.startRun('ws', 'probe', {});
  await until(() => state.sessions.length, 'human in-flight delegation');
  state.calls = []; state.reviews = [];
  await humanLate.cancel('ws', humanLateRec.runId, 'human', { closeSessions: true, initiatedBy: 'human' });
  releaseHuman();
  await until(() => state.calls.some(call => call.tool === 'human.delete'), 'human late compensation');
  assert.equal(state.reviews.length, 0, 'late compensation retains the human origin');

  // Crash after session persistence but before the first chat message was accepted.
  active.pop().dispose();
  const crashed = setup(); state.pause = new Promise(() => {});
  const crashedRec = await crashed.startRun('ws','probe',{});
  await until(()=>state.sessions.length===1,'persisted session without a first message');
  active.pop().dispose();
  const ctx = state.ctx;
  const { resolveSessionTarget } = require(path.join(root,'src/main/sessions/targets.ts'));
  const target = await resolveSessionTarget(ctx.config.get(), {workspaceId:'ws'});
  state.sessions[0].sourceRoot = target.sourceRoot;
  const store = require(path.join(root,'src/main/metaAgent/messageStore.ts'));
  store.setAgentMessagesUserDataDir(path.join(dir,'mail-data'));
  let creates = 0;
  Object.assign(ctx.sessions, { list:()=>state.sessions,isChatRuntime:()=>true,ensureStatusToken(){},setOrchestrated(){},clearDonePhase(id){delete state.sessions.find(row=>row.id===id).phase;},broadcastMessagesChanged(){},
    createTerminal:async()=>{creates++;throw Error('must not create a second worker');} });
  ctx.resolveBubbleWorkspaceId=()=> 'ws'; ctx.workspaces={list:()=>ctx.config.get().workspaces};
  const chat = [];
  ctx.agentSessions={isBusy:()=>true,isOpen:()=>true,async send(sessionId, text, _images, opts){
    chat.push({sessionId,text,opts});return {ok:true};
  }}; state.realDelegate=true;
  assert.equal(store.readAgentMessageLedger(dir,'ws').messages.length,0);
  const resumed = createWorkflowRuntime(ctx,{enqueueWorkflow(){},addTap:()=>()=>{}});active.push(resumed);
  resumed.runtime.resumeAll();
  await until(()=>resumed.runtime.get('ws',crashedRec.runId).pendingAsk,'recovered assignment');
  assert.equal(creates,0);assert.equal(state.sessions.length,1);assert.equal(chat.length,1);
  assert.equal(chat[0].sessionId,state.sessions[0].id);assert.equal(chat[0].opts.source,'scheduler');
  assert.equal(chat[0].text,'work');
  assert.equal(store.readAgentMessageLedger(dir,'ws').messages.length,0);
  // Replaying an accepted task keeps the original chat message.
  const { runAsSchedulerTool } = require(path.join(root,'src/main/agent/agentScope.ts'));
  const { delegateTask } = require(path.join(root,'src/main/tasks/delegate.ts'));
  for (const phase of ['needs_you','done']) {
    state.sessions[0].phase={value:phase};
    const replay = await runAsSchedulerTool(()=>delegateTask(ctx,{workspaceId:'ws',creationKey:state.sessions[0].meta.creationKey,task:'work',isolate:false,select:false,statusVocabulary:['新词表']}));
    assert.equal(replay.inject.messageId,chat[0].opts.messageId);assert.equal(chat.length,1);
    assert.equal(state.sessions[0].phase.value,phase,'recovery must retain an existing completed/reviewing phase');
  }
  state.realDelegate=false;
  // Legacy suggestions must no longer constrain a new GUI assignment.
  ctx.sessions.createTerminal=async input=>{creates++;const row={...state.sessions[0],id:'gui-vocab',meta:input.meta};state.sessions.push(row);return row;};
  await runAsSchedulerTool(()=>delegateTask(ctx,{workspaceId:'ws',creationKey:'vocab-key',task:'new work',isolate:false,select:false,statusVocabulary:['实现中']}));
  assert.equal(chat.at(-1).sessionId,'gui-vocab');
  assert.equal(chat.at(-1).text,'new work');
  console.log('workflow-wiring: OK (real assembly, creation key, archive/delete precondition, failure and late compensation)');
} finally {
  for (const item of active) item.dispose();
  Module._load = oldLoad;
  if (oldTs) require.extensions['.ts'] = oldTs; else delete require.extensions['.ts'];
  fs.rmSync(dir, { recursive: true, force: true });
}
