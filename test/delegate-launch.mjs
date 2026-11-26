/** First assignment uses GUI chat or CLI launch, including recovery of existing mail. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const root = process.cwd(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-launch-'));
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const originalLoad = Module._load, oldTs = require.extensions['.ts'];
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file
}).outputText, file);
Module._load = function(name, parent) {
  if (name === 'electron') return { app: { getPath: () => tmp, getAppPath: () => tmp, isReady: () => true }, ipcMain: { on() {}, handle() {} } };
  if (parent?.filename === path.join(root, 'src/main/tasks/delegate.ts') && name === '../capabilities/hosts/chat') {
    return { buildBriefWithNamedSkills: async (_ctx, _id, task) => ({ brief: task, vocab: [] }) };
  }
  return originalLoad.apply(this, arguments);
};
const off = [];
try {
  // Exercise the same attachment worker on a fresh checkout as in the packaged app.
  fs.symlinkSync(path.dirname(path.dirname(require.resolve('i18next/package.json'))), path.join(tmp, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await build({ entryPoints: [path.join(root, 'src/main/attachments/worker.ts')],
    outfile: path.join(tmp, 'out/main/attachments/worker.mjs'), bundle: true, platform: 'node',
    format: 'esm', packages: 'external', logLevel: 'silent' });
  const load = name => require(path.join(root, 'src', name));
  const { delegateTask } = load('main/tasks/delegate.ts');
  const { waitForSessionLaunch } = load('main/tasks/delegateLaunch.ts');
  const { sessionObservation } = load('shared/sessionObservation.ts');
  const { setAgentMessagesUserDataDir, readAgentMessageLedger, updateAgentMessageWakeInStore } = load('main/metaAgent/messageStore.ts');
  const { attachMailboxWakes, flushMailboxWake } = load('main/messages/wake.ts');
  const { sendSessionMail } = load('main/messages/assignment.ts');
  setAgentMessagesUserDataDir(path.join(tmp, 'userdata'));
  const rows = [], cfg = { activeWorkspaceId: 'w', defaultRuntime: 'fixture-cli', workspaces: [{ id: 'w', path: tmp }] };
  let outcome = 'running', live;
  const ctx = { config: { get: () => cfg }, resolveBubbleWorkspaceId: () => 'w', workspaces: { list: () => cfg.workspaces },
    sessions: { list: () => rows, listByWorkspace: () => rows, get: id => rows.find(s => s.id === id),
      peek: id => rows.find(s => s.id === id), isChatRuntime: () => false, onLifecycle: () => () => {}, broadcastMessagesChanged() {},
      ensureStatusToken() {}, clearDonePhase() {},
      createTerminal: async input => {
        live = { ...input, id: input.reservedSessionId ?? 'session-' + rows.length, type: 'terminal', runtime: input.runtime,
          status: outcome === 'failed' ? 'exited' : outcome === 'slow' ? 'starting' : 'running',
          lifecycle: outcome === 'failed' ? 'exited' : outcome === 'slow' ? 'starting' : 'working',
          ...(outcome === 'failed' ? { meta: { launchError: 'runtime missing' } } : {}) };
        rows.push(live); return live;
      }
    }, pty: { isRunning: id => { const s = rows.find(row => row.id === id); return s?.status === 'running'; } } };
  off.push(attachMailboxWakes(ctx));
  const run = () => delegateTask(ctx, { task: 'first assignment', runtime: 'fixture-cli', workspaceId: 'w', isolate: false, select: false, notifyOrchestrator: false });
  const ready = await run();
  assert.equal(ready.status, 'started'); assert.equal(ready.inject.mode, 'cli-prompt');
  assert.equal(ready.session.initialPrompt, 'first assignment', 'first CLI turn gets the real assignment');
  assert.equal(readAgentMessageLedger(tmp, 'w').messages.length, 0, 'no second task waiting for first idle');
  outcome = 'failed';
  await assert.rejects(run(), error => {
    assert.match(error.message, /启动失败.*runtime missing.*原会话保留/);
    assert.equal(error.sessionId, live.id); return true;
  });
  assert.equal(sessionObservation(live).launchError, 'runtime missing');
  assert.equal(live.initialPrompt, 'first assignment', 'failed creation still retains its launch input in this fixture');
  outcome = 'slow';
  const slow = await run();
  assert.equal(slow.status, 'starting', 'bounded startup reports pending instead of false success');
  assert.equal(sessionObservation(live).processStatus, 'starting');
  assert.equal(rows.length, 3, 'slow startup never creates a duplicate');
  live.status = 'running'; live.lifecycle = 'working';
  assert.equal(await waitForSessionLaunch(ctx, live.id, 5), 'running', 'same session may finish starting later');
  await assert.rejects(waitForSessionLaunch(ctx, 'gone', 5), /会话不存在/);
  const existing = ready.session;existing.meta={creationKey:'cold-recovery'};existing.sourceRoot=existing.capturedSource;
  existing.status='starting';existing.lifecycle='working';existing.worktreePath=path.join(tmp,'existing-task-tree');
  let resumes=0, wakeText='';
  ctx.sessions.respawn=async id=>{assert.equal(id,existing.id);resumes++;existing.status='running';existing.lifecycle='idle';existing.runtimeStartedAt=Date.now();};
  ctx.sessions.getCliWorkspaceContext=()=>undefined;ctx.sessions.injectStrategy=async()=> 'initial-prompt';ctx.sessions.pasteInput=async()=>false;
  const write=(id,text)=>{assert.equal(id,existing.id);wakeText+=text;return true;};ctx.pty.write=write;ctx.pty.captureWriter=()=>({write});
  const before=rows.length;
  const recovered=await delegateTask(ctx,{task:'first assignment',workspaceId:'w',creationKey:'cold-recovery',isolate:false,select:false,notifyOrchestrator:false});
  assert.equal(resumes,1);assert.equal(rows.length,before);assert.equal(recovered.session.id,existing.id);assert.equal(recovered.status,'started');
  assert.ok(recovered.inject.messageId, 'resuming an existing CLI uses a durable recovery assignment');
  assert.equal(recovered.isolate,true,'recovery keeps the existing resource choice instead of reselecting from the new input or dirty status');
  await flushMailboxWake(ctx,existing.id,'w');
  assert.match(wakeText,/宿主收信提醒/,'a previously notified unread first task gets a fresh recovery notice');
  existing.phase={value:'done'};existing.status='exited';existing.lifecycle='exited';
  const complete=await delegateTask(ctx,{task:'first assignment',workspaceId:'w',creationKey:'cold-recovery',isolate:false,select:false,notifyOrchestrator:false});
  assert.equal(complete.session.phase.value,'done');assert.equal(resumes,1,'completed cold CLI is not restarted or treated as a failed new launch');
  outcome = 'running';
  const childInput = { task: '', runtime: 'fixture-cli', parentSessionId: existing.id, workspaceId: 'w', isolate: false, select: false, notifyOrchestrator: false };
  const child1 = await delegateTask(ctx, { ...childInput, creationKey: 'avatar-retry' });
  const child2 = await delegateTask(ctx, childInput);
  assert.notEqual(child1.session.subagentCharacterId, child2.session.subagentCharacterId, 'same-task children rotate avatars');
  const retriedChild = await delegateTask(ctx, { ...childInput, creationKey: 'avatar-retry' });
  assert.equal(retriedChild.session.id, child1.session.id);
  assert.equal(retriedChild.session.subagentCharacterId, child1.session.subagentCharacterId, 'idempotent replay preserves avatar');
  ctx.sessions.isChatRuntime = id => id === 'pi';
  const sent = [];
  let guiOpen = true, acceptGui = true;
  ctx.agentSessions = {
    isOpen: () => guiOpen,
    async send(sessionId, task, images, opts) {
      sent.push({ sessionId, task, images, opts });
      return acceptGui ? { ok: true } : { ok: false, error: 'test admission failure' };
    }
  };
  const guiTask = 'GUI assignment\n\n' + '完整正文'.repeat(1000);
  const guiInput = { task: guiTask, workspaceId: 'w', isolate: false, select: false, notifyOrchestrator: false,
    creationKey: 'gui-chat', desktopUserInstruction: true };
  const [gui, replay] = await Promise.all([delegateTask(ctx, guiInput), delegateTask(ctx, guiInput)]);
  assert.equal(gui.session.runtime, 'pi', 'a configured CLI does not become the implicit task runtime');
  assert.deepEqual(replay.inject, gui.inject);
  assert.equal(gui.inject.mode, 'gui-prompt');
  assert.equal(gui.inject.briefChars, guiTask.length);
  assert.deepEqual(sent, [{ sessionId: gui.session.id, task: guiTask, images: undefined,
    opts: { messageId: gui.inject.messageId, steerOnBusy: false } }]);
  assert.equal(readAgentMessageLedger(tmp, 'w').messages.some(mail => mail.to === gui.session.id), false);
  const blank = await delegateTask(ctx, { ...guiInput, task: '', creationKey: 'blank-gui' });
  assert.equal(blank.inject, undefined);
  assert.equal(sent.length, 1, 'opening a blank GUI session does not start a turn');
  const old = await sendSessionMail(ctx, { sessionId: blank.session.id, text: 'Saved task mail',
    idempotencyKey: 'initial-assignment', initialAssignment: true });
  const resumed = await delegateTask(ctx, { ...guiInput, creationKey: 'blank-gui' });
  assert.equal(resumed.inject.mode, 'mailbox');
  assert.equal(resumed.inject.messageId, old.messageId);
  assert.equal(sent.length, 1, 'existing GUI task mail never produces another task message');
  const guiChild = await delegateTask(ctx, { task: 'child assignment', parentSessionId: existing.id, workspaceId: 'w', isolate: false, select: false, notifyOrchestrator: false });
  assert.equal(guiChild.session.runtime, 'pi', 'a CLI parent does not implicitly create a CLI child');
  assert.equal(guiChild.inject.mode, 'gui-prompt');
  assert.equal(sent.at(-1).opts.source, 'agent');
  assert.equal(sent.at(-1).opts.fromInject, true);
  assert.equal(sent.at(-1).opts.sourceAgent.sessionId, existing.id);
  const cliChild = await delegateTask(ctx, { task: 'CLI child', runtime: 'fixture-cli', parentSessionId: existing.id, workspaceId: 'w', isolate: false, select: false, notifyOrchestrator: false });
  assert.equal(cliChild.session.runtime, 'fixture-cli', 'an explicit CLI child is still supported');
  assert.equal(cliChild.inject.mode, 'cli-prompt');

  acceptGui = false;
  const retryInput = { ...guiInput, creationKey: 'failed-gui' };
  await assert.rejects(delegateTask(ctx, retryInput), error => {
    assert.match(error.message, /test admission failure/);
    assert.equal(error.sessionId, live.id);
    return true;
  });
  const failedSend = sent.at(-1);
  guiOpen = false;
  acceptGui = true;
  let guiResumes = 0;
  ctx.sessions.respawn = async id => { assert.equal(id, failedSend.sessionId); guiResumes++; guiOpen = true; };
  const retry = await delegateTask(ctx, retryInput);
  assert.equal(retry.session.id, failedSend.sessionId);
  assert.deepEqual(sent.at(-1), failedSend);
  assert.equal(guiResumes, 1);
  guiOpen = false;
  const acceptedWhileClosed = await delegateTask(ctx, retryInput);
  assert.deepEqual(acceptedWhileClosed.inject, retry.inject);
  assert.equal(guiResumes, 1, 'replaying an accepted first message does not reopen a closed GUI session');
  assert.equal(sent.filter(call => call.sessionId === failedSend.sessionId).length, 2);
  const cliFiles = { ...guiInput, creationKey: 'desktop-cli-file', runtime: 'fixture-cli', task: '',
    attachments: [{ id: 'doc', name: 'task.txt', mimeType: 'text/plain', data: Buffer.from('startup attachment body').toString('base64') }] };
  const withFile = await delegateTask(ctx, cliFiles);
  assert.equal(withFile.inject.mode, 'cli-prompt');
  assert.ok(withFile.session.initialPrompt.includes('startup attachment body'));
  assert.equal(withFile.session.name, 'task.txt');
  assert.equal((await delegateTask(ctx, cliFiles)).session.id, withFile.session.id);
  assert.equal(readAgentMessageLedger(tmp, 'w').messages.some(mail => mail.to === withFile.session.id), false);
  console.log('delegate-launch: OK (direct GUI task, retained recovery and CLI startup)');
} finally {
  for (const dispose of off) dispose();
  Module._load = originalLoad;
  if (oldTs) require.extensions['.ts'] = oldTs; else delete require.extensions['.ts'];
  fs.rmSync(tmp, { recursive: true, force: true });
}
