/** Actual Pi archives and orchestrator fork races, with only the SDK-loading boundary deferred. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager, parseSessionEntries } from '@earendil-works/pi-coding-agent';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-fork-'));
const compiled = path.join(temp, 'compiled');
const compile = createSharedCompiler(repo, compiled);
const electron = path.join(compiled, 'node_modules/electron');
fs.mkdirSync(electron, { recursive: true });
fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', exports: './index.mjs' }));
fs.writeFileSync(path.join(electron, 'index.mjs'), `export const app = { getPath: () => ${JSON.stringify(temp)} };\n`);
const entry = compile('main/agent/orchestrator/sessions.ts');
fs.writeFileSync(path.join(compiled, 'main/agent/providers/piProvider.mjs'), `
export const createForkedPiSession = (...args) => globalThis.__schedulerForkCreate(...args);
export const deletePiSession = (...args) => globalThis.__schedulerForkDelete(...args);
export const listPiSessions = async () => [];
export const loadPiSessionDisplay = (...args) => globalThis.__schedulerLoad ? globalThis.__schedulerLoad(...args) : Promise.resolve([]);
export const renamePiSession = async () => ({ok: true});
export const disposePiSessionResources = async () => {};
`);
const bucketsEntry = compile('main/agent/orchestrator/buckets.ts');
fs.writeFileSync(path.join(compiled, 'main/agent/providers/modeExtension.mjs'), 'export const getModeController = () => undefined;\n');
const load = async rel => import(pathToFileURL(compile(rel)).href);
const { forkSession, openSession, deleteSession } = await import(pathToFileURL(entry).href);
const { clearHistory } = await import(pathToFileURL(bucketsEntry).href);
const { SchedulerDesktopEpochRuntime } = await load('main/desktop/schedulerEpochRuntime.ts');
const { writeSchedulerForkFile: writeFork } = await load('main/agent/providers/forkSessionFile.ts');
const { captureSchedulerWorkspaceContext: capture, bindSchedulerSessionContext: bind,
  beginSchedulerWorkspaceContext: begin, getActiveSchedulerContext, SCHEDULER_SOURCE_ENTRY } = await load('main/agent/schedulerWorkspaceContext.ts');
const { workspaceRootUsesFor } = await load('main/workspaceRootUses.ts');
const { SchedulerSessionAdapter, loadSchedulerSessionSnapshot } = await load('main/runtimeKernel/schedulerSession.ts');
const { schedulerSqlitePath } = await load('main/runtimeKernel/schedulerSqlite.ts');
const { schedulerModelRequestId } = await load('shared/modelRequest.ts');
const { listModelRequests, recordingToken, saveModelRequest, setModelRequestRecording } = await load('main/agentSession/modelRequestStore.ts');
const pi = { SessionManager, parseSessionEntries };
const model = { api: 'openai-completions', provider: 'fixture', model: 'fixture' };
const seeds = [{ role: 'user', text: 'first user, no assistant', ts: 123 }];
const nativeFile = (manager, dir, name) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, [manager.getHeader(), ...manager.getEntries()].map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
};
let counter = 0;
const testBuckets = [];
const schedulerAdapters = [];
function makeSchedulerAdapter(...args) {
  const adapter = new SchedulerSessionAdapter(...args);
  schedulerAdapters.push(adapter);
  return adapter;
}
function fixture({ disk = true, legacy = false, cwdInChild = false } = {}) {
  const dir = path.join(temp, `fixture-${counter++}`); fs.mkdirSync(dir);
  const [a, b, sessionDir] = ['a', 'b', 'sessions'].map(name => path.join(dir, name));
  for (const folder of [a, b, sessionDir]) fs.mkdirSync(folder);
  const child = path.join(b, 'child'); fs.mkdirSync(child);
  const ws = { id: 'ws', name: 'Project', path: b, controlRoot: a, defaultRootId: 'b', rootsRevision: 1,
    roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
  const cfg = { workspaces: [ws], activeWorkspaceId: 'elsewhere' }; const config = { get: () => cfg };
  const parent = SessionManager.inMemory(cwdInChild ? child : b);
  const context = capture(cfg, 'ws', { sessionManager: parent });
  if (!legacy) bind(cfg, parent, context);
  parent.appendMessage({ role: 'user', content: seeds[0].text, timestamp: 123 });
  const file = disk ? nativeFile(parent, sessionDir, 'parent.jsonl') : undefined;
  const bucket = { display: [{ id: 'first', role: 'user', content: seeds[0].text, createdAt: 123 },
    { id: 'later', role: 'assistant', content: 'later history', createdAt: 456 }], busy: false,
    piSession: { sessionManager: parent }, piSessionFile: file, queue: [], api: [], resetPiOnNextSend: false };
  testBuckets.push(bucket);
  const buckets = new Map([['ws', bucket]]); const deleted = []; const created = []; const events = [];
  const o = { ctx: { config, store: { getPiSessionDir: () => sessionDir }, getWindow: () => ({ webContents: { send: (...args) => events.push(args) } }) },
    buckets, ensureBucket: () => buckets.get('ws'),
    abortPendingAsk() {}, invalidatePiSession() { bucket.piSession = null; }, persistBucket() {},
    emit: (...args) => events.push(args), emitContextStatus() {} };
  const create = (_ctx, _id, inputSeeds, title, _model, source) => {
    assert.equal(Array.isArray(inputSeeds), false, 'business fork must stream seeds');
    const result = { ok: true, ...writeFork(config, pi, { context: source.workspaceContext,
      sessionDir, seeds: inputSeeds, title, model, parentFile: source.parentFile }) };
    created.push(result.sessionFile); return result;
  };
  globalThis.__schedulerForkCreate = create;
  globalThis.__schedulerForkDelete = async (_ctx, _id, file) => {
    assert.equal(path.dirname(file), sessionDir, 'cleanup is restricted to owned fixture files');
    deleted.push(file); fs.unlinkSync(file); return { ok: true };
  };
  return { a, b, child, ws, cfg, config, context, parent, file, bucket, buckets, o, created, deleted, create, sessionDir, events };
}
const setDefaultA = f => { f.ws.path = f.a; f.ws.defaultRootId = 'a'; f.ws.roots.reverse(); f.ws.rootsRevision++; };
const checkReopen = (f, result, expectedRoot = 'b') => {
  assert.ok(fs.existsSync(result.sessionFile), 'user-only fork exists before the next model turn');
  const reopened = SessionManager.open(result.sessionFile, f.sessionDir);
  assert.equal(reopened.getCwd(), f.parent.getCwd());
  assert.equal(reopened.getHeader().parentSession, result.originalSessionFile ?? f.file);
  const messages = reopened.buildSessionContext().messages;
  assert.deepEqual(messages.map(m => m.role), ['user'], 'no fabricated assistant to force persistence');
  assert.equal(messages[0].content, seeds[0].text);
  assert.ok(!JSON.stringify(messages).includes(SCHEDULER_SOURCE_ENTRY));
  const metadata = reopened.getEntries().find(e => e.customType === SCHEDULER_SOURCE_ENTRY).data;
  assert.equal(metadata.sourceRoot.rootId, expectedRoot);
  assert.equal(metadata.sourceRoot.cwd, f.parent.getCwd());
  assert.ok(reopened.getSessionName().includes('Fork'));
};
try {
  {
  // Revocation must precede publication; failure preserves the original session.
  const revokedEpochFixture = fixture(); const revocations = [];
  revokedEpochFixture.o.ctx.desktopEpochs = { endScheduler: id => revocations.push(id) };
  const revokedResult = await forkSession(revokedEpochFixture.o, 'first', 'ws');
  assert.equal(revokedResult.ok, true, revokedResult.error);
  assert.deepEqual(revocations, ['ws']);
  const denied = fixture(); const originalSession = denied.bucket.piSessionFile;
  denied.o.ctx.desktopEpochs = { endScheduler: () => { throw new Error('epoch persistence failed'); } };
  const deniedResult = await forkSession(denied.o, 'first', 'ws');
  assert.equal(deniedResult.ok, false); assert.match(deniedResult.error, /epoch persistence failed/);
  assert.equal(denied.bucket.piSessionFile, originalSession);
  assert.deepEqual(denied.deleted, denied.created);

  const openDenied = fixture();
  openDenied.o.ctx.desktopEpochs = { endScheduler: () => { throw new Error('cannot revoke'); } };
  const savedDisplay = openDenied.bucket.display, savedFile = openDenied.bucket.piSessionFile;
  const openFailure = await openSession(openDenied.o, 'ws', savedFile);
  assert.equal(openFailure.ok, false); assert.match(openFailure.error, /cannot revoke/);
  assert.equal(openDenied.bucket.display, savedDisplay); assert.equal(openDenied.bucket.piSessionFile, savedFile);
  const opened = fixture(); const openRevocations = [];
  opened.o.ctx.desktopEpochs = { endScheduler: id => openRevocations.push(id) };
  assert.equal((await openSession(opened.o, 'ws', opened.file)).ok, true);
  assert.deepEqual(openRevocations, ['ws']);
  const openRace = fixture(); const raceRevocations = [];
  openRace.o.ctx.desktopEpochs = { endScheduler: id => raceRevocations.push(id) };
  let finishOpen;
  globalThis.__schedulerLoad = () => new Promise(resolve => { finishOpen = resolve; });
  const pendingOpen = openSession(openRace.o, 'ws', openRace.file);
  const changed = [{ id: 'newer', role: 'user', content: 'new conversation', createdAt: 999 }];
  openRace.bucket.display = changed; finishOpen([]);
  const staleOpen = await pendingOpen; delete globalThis.__schedulerLoad;
  assert.equal(staleOpen.ok, false); assert.match(staleOpen.error, /变化/);
  assert.equal(openRace.bucket.display, changed); assert.deepEqual(raceRevocations, []);
  const deleteDenied = fixture();
  deleteDenied.o.ctx.desktopEpochs = { endScheduler: () => { throw new Error('cannot revoke'); } };
  const deleteFailure = await deleteSession(deleteDenied.o, 'ws', deleteDenied.file);
  assert.equal(deleteFailure.ok, false); assert.match(deleteFailure.error, /cannot revoke/);
  assert.ok(fs.existsSync(deleteDenied.file)); assert.equal(deleteDenied.bucket.piSessionFile, deleteDenied.file);
  const deletedCurrent = fixture(); const deleteRevocations = [];
  deletedCurrent.o.ctx.desktopEpochs = { endScheduler: id => deleteRevocations.push(id) };
  assert.equal((await deleteSession(deletedCurrent.o, 'ws', deletedCurrent.file)).ok, true);
  assert.deepEqual(deleteRevocations, ['ws']); assert.equal(deletedCurrent.bucket.piSessionFile, undefined);
  const deleteRace = fixture();
  const lateTarget = path.join(deleteRace.sessionDir, 'late.jsonl'); fs.copyFileSync(deleteRace.file, lateTarget);
  deleteRace.o.ctx.desktopEpochs = { endScheduler: () => { throw new Error('late revoke failed'); } };
  globalThis.__schedulerForkDelete = async () => {
    deleteRace.bucket.piSessionFile = lateTarget; fs.unlinkSync(lateTarget); return { ok: true };
  };
  const lateDelete = await deleteSession(deleteRace.o, 'ws', lateTarget);
  assert.equal(lateDelete.ok, false); assert.match(lateDelete.error, /late revoke failed/);
  assert.equal(deleteRace.bucket.piSessionFile, undefined); assert.equal(fs.existsSync(lateTarget), false);
  const requestId = schedulerModelRequestId('ws');
  const otherRequestId = schedulerModelRequestId('other');
  setModelRequestRecording(temp, requestId, true);
  setModelRequestRecording(temp, otherRequestId, true);
  const activeRecording = recordingToken(temp, requestId);
  saveModelRequest(temp, requestId, activeRecording, { at: 1, model: 'fixture', protocol: 'test', complete: true }, Buffer.from('{}'));
  const clearDenied = fixture(); const clearDisplay = clearDenied.bucket.display;
  clearDenied.o.ctx.desktopEpochs = { endScheduler: () => { throw new Error('cannot revoke'); } };
  assert.throws(() => clearHistory(clearDenied.o, 'ws'), /cannot revoke/);
  assert.equal(clearDenied.bucket.display, clearDisplay); assert.equal(clearDenied.bucket.piSessionFile, clearDenied.file);
  assert.equal(recordingToken(temp, requestId), activeRecording);
  const cleared = fixture(); const clearRevocations = [];
  cleared.o.ctx.desktopEpochs = { endScheduler: id => clearRevocations.push(id) };
  clearHistory(cleared.o, 'ws');
  assert.deepEqual(clearRevocations, ['ws']); assert.equal(cleared.bucket.piSessionFile, undefined);
  assert.equal(recordingToken(temp, requestId), null);
  assert.deepEqual(listModelRequests(temp, requestId), []);
  assert.ok(recordingToken(temp, otherRequestId));
  assert.deepEqual(cleared.events.find(([channel]) => channel === 'modelRequests:recordingChanged'),
    ['modelRequests:recordingChanged', { sessionId: requestId, enabled: false }]);
  const realEpoch = fixture();
  const epochRuntime = new SchedulerDesktopEpochRuntime(path.join(temp, 'real-epoch'), {
    async confirmWithReceipt() { return { approvalId: 'host-receipt', decision: { confirmed: true, kind: 'allowOnce' } }; }
  });
  await epochRuntime.ensureCapture('orchestrator:ws', () => true);
  realEpoch.o.ctx.desktopEpochs = { endScheduler: id => epochRuntime.closeSession(`orchestrator:${id}`) };
  const realFork = await forkSession(realEpoch.o, 'first', 'ws');
  assert.equal(realFork.ok, true, realFork.error);
  assert.equal(epochRuntime.currentBinding('orchestrator:ws'), null);
  epochRuntime.close();
  }

  // Reopen a fork cut at the first user after switching the default directory; parent bytes stay intact.
  for (const legacy of [false, true]) {
    const f = fixture({ legacy }); const before = fs.readFileSync(f.file);
    setDefaultA(f);
    const result = await forkSession(f.o, 'first', 'ws'); assert.equal(result.ok, true, result.error);
    checkReopen(f, result); assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(workspaceRootUsesFor(f.config).list('ws').length, 0);
  }

  // Cold header inference can prefer a newly added child root; persisted source identity still wins.
  const nested = fixture({ cwdInChild: true }); nested.bucket.piSession = null;
  nested.ws.roots.push({ id: 'child', path: nested.child }); nested.ws.rootsRevision++;
  const inferred = capture(nested.cfg, 'ws', null, nested.file); assert.equal(inferred.sourceRootId, 'child');
  const nestedResult = await forkSession(nested.o, 'first', 'ws'); assert.equal(nestedResult.ok, true, nestedResult.error);
  checkReopen(nested, nestedResult, 'b');
  nested.bucket.piSessionFile = nested.file; nested.bucket.piSession = null;
  nested.ws.roots = nested.ws.roots.filter(root => root.id !== 'b'); nested.ws.defaultRootId = 'a'; nested.ws.path = nested.a;
  const count = fs.readdirSync(nested.sessionDir).length;
  const missingIdentity = await forkSession(nested.o, 'first', 'ws'); assert.equal(missingIdentity.ok, false);
  assert.match(missingIdentity.error, /identity changed/); assert.equal(fs.readdirSync(nested.sessionDir).length, count);

  const changedParent = fixture();
  const entries = parseSessionEntries(fs.readFileSync(changedParent.file, 'utf8')); entries[0].cwd = changedParent.a;
  fs.writeFileSync(changedParent.file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const invalidParent = await forkSession(changedParent.o, 'first', 'ws'); assert.equal(invalidParent.ok, false);
  assert.match(invalidParent.error, /parent cwd changed/); assert.equal(changedParent.created.length, 0);

  // Every root is held synchronously before the SDK await; default/order changes don't move the fork.
  const delayed = fixture(); let resume;
  const activeRelease = begin(delayed.config, delayed.context);
  globalThis.__schedulerForkCreate = (...args) => new Promise(resolve => { resume = () => resolve(delayed.create(...args)); });
  const pending = forkSession(delayed.o, 'first', 'ws');
  assert.deepEqual(workspaceRootUsesFor(delayed.config).list('ws').map(r => r.rootId).sort(), ['a', 'a', 'b', 'b']);
  assert.equal(getActiveSchedulerContext(delayed.config, 'ws'), delayed.context, 'fork does not replace live preview');
  setDefaultA(delayed); resume(); const result = await pending; assert.equal(result.ok, true, result.error); checkReopen(delayed, result);
  assert.equal(workspaceRootUsesFor(delayed.config).list('ws').length, 2); activeRelease();

  // Sends, clear/open, and bucket replacement while loading must keep their newer state and files.
  for (const mutation of ['send', 'clear', 'open', 'replace']) {
    const f = fixture(); let finish;
    globalThis.__schedulerForkCreate = (...args) => new Promise(resolve => { finish = () => resolve(f.create(...args)); });
    const task = forkSession(f.o, 'first', 'ws');
    let newerFile;
    if (mutation === 'send') { f.bucket.busy = true; f.bucket.display.push({ id: 'newer', role: 'user', content: 'new send', createdAt: 789 }); }
    if (mutation === 'clear') { f.bucket.display = []; f.bucket.piSessionFile = undefined; f.bucket.resetPiOnNextSend = true; }
    if (mutation === 'open') { newerFile = nativeFile(SessionManager.inMemory(f.b), f.sessionDir, 'newer.jsonl'); f.bucket.piSessionFile = newerFile; }
    if (mutation === 'replace') f.buckets.set('ws', { ...f.bucket, display: [] });
    const snapshot = JSON.stringify(f.buckets.get('ws').display); const expectedFile = f.buckets.get('ws').piSessionFile;
    finish(); const failed = await task; assert.equal(failed.ok, false, mutation); assert.match(failed.error, /变化|changed/);
    assert.equal(JSON.stringify(f.buckets.get('ws').display), snapshot); assert.equal(f.buckets.get('ws').piSessionFile, expectedFile);
    assert.deepEqual(f.deleted, f.created); assert.ok(fs.existsSync(f.file)); if (newerFile) assert.ok(fs.existsSync(newerFile));
    assert.equal(workspaceRootUsesFor(f.config).list('ws').length, 0);
  }

  // Competing forks: the first published archive wins, and the late operation deletes only its own child.
  const competing = fixture(); const finishers = [];
  globalThis.__schedulerForkCreate = (...args) => new Promise(resolve => finishers.push(() => resolve(competing.create(...args))));
  const one = forkSession(competing.o, 'first', 'ws'); const two = forkSession(competing.o, 'first', 'ws');
  finishers[1](); const winner = await two; assert.equal(winner.ok, true, winner.error);
  finishers[0](); const loser = await one; assert.equal(loser.ok, false);
  assert.equal(competing.bucket.piSessionFile, winner.sessionFile); assert.ok(fs.existsSync(winner.sessionFile));
  assert.equal(competing.deleted.length, 1); assert.notEqual(competing.deleted[0], winner.sessionFile);
  assert.equal(workspaceRootUsesFor(competing.config).list('ws').length, 0);

  // An unflushed original is archived at its pinned live cwd, before creating the child.
  const liveOnly = fixture({ disk: false }); setDefaultA(liveOnly);
  const saved = await forkSession(liveOnly.o, 'first', 'ws'); assert.equal(saved.ok, true, saved.error); checkReopen(liveOnly, saved);
  assert.equal(liveOnly.created.length, 2); assert.ok(fs.existsSync(saved.originalSessionFile));
  assert.deepEqual(SessionManager.open(saved.originalSessionFile, liveOnly.sessionDir).buildSessionContext().messages.map(m => m.role), ['user', 'assistant']);

  // Failed child initialization cleans the newly made original; never delete a real parent.
  const failedChild = fixture({ disk: false }); let calls = 0;
  globalThis.__schedulerForkCreate = (...args) => ++calls === 2 ? { ok: false, error: 'child failed' } : failedChild.create(...args);
  const failed = await forkSession(failedChild.o, 'first', 'ws'); assert.equal(failed.ok, false); assert.match(failed.error, /child failed/);
  assert.deepEqual(failedChild.deleted, failedChild.created); assert.equal(failedChild.bucket.piSessionFile, undefined);
  assert.equal(workspaceRootUsesFor(failedChild.config).list('ws').length, 0);

  const cleanupFailed = fixture({ disk: false }); calls = 0;
  globalThis.__schedulerForkCreate = (...args) => ++calls === 2 ? { ok: false, error: 'child failed' } : cleanupFailed.create(...args);
  globalThis.__schedulerForkDelete = async () => { throw new Error('cleanup failed'); };
  const cleanup = await forkSession(cleanupFailed.o, 'first', 'ws'); assert.equal(cleanup.ok, false);
  assert.match(cleanup.error, /child failed[\s\S]*cleanup failed/);
  assert.ok(fs.existsSync(cleanupFailed.created[0])); assert.equal(workspaceRootUsesFor(cleanupFailed.config).list('ws').length, 0);

  // Published archives remain reachable even if notification/persistence fails.
  const published = fixture(); published.o.persistBucket = () => { throw new Error('persist failed'); };
  const partial = await forkSession(published.o, 'first', 'ws'); assert.equal(partial.ok, false); assert.match(partial.error, /persist failed/);
  assert.equal(partial.sessionFile, published.bucket.piSessionFile); checkReopen(published, partial); assert.deepEqual(published.deleted, []);
  assert.equal(workspaceRootUsesFor(published.config).list('ws').length, 0);

  // Root revocation during SDK loading prevents file creation and publication.
  const revoked = fixture(); let continueRevoked;
  globalThis.__schedulerForkCreate = (...args) => new Promise((resolve, reject) => { continueRevoked = () => { try { resolve(revoked.create(...args)); } catch (error) { reject(error); } }; });
  const waiting = forkSession(revoked.o, 'first', 'ws'); revoked.ws.roots = [{ id: 'a', path: revoked.a }]; revoked.ws.path = revoked.a; revoked.ws.defaultRootId = 'a';
  continueRevoked(); const denied = await waiting; assert.equal(denied.ok, false); assert.equal(revoked.created.length, 0);
  assert.equal(revoked.bucket.piSessionFile, revoked.file); assert.equal(workspaceRootUsesFor(revoked.config).list('ws').length, 0);
  // The production business entry publishes the semantic kernel child too,
  // rather than only returning a newly seeded Pi archive.
  const kernel = fixture();
  const kernelRoot = path.dirname(kernel.sessionDir);
  kernel.bucket.display[0].queued = true;
  kernel.bucket.display[0].turnChanges = {id: 'old-authority', state: 'ready'};
  kernel.bucket.schedulerSession = makeSchedulerAdapter(kernelRoot, 'ws', {
    display: kernel.bucket.display, api: [{private: 'old-engine-context'}], piSessionFile: kernel.file});
  const originalKernelId = kernel.bucket.schedulerSession.sessionId;
  const branched = await forkSession(kernel.o, 'first', 'ws');
  assert.equal(branched.ok, true, branched.error);
  checkReopen(kernel, branched);
  assert.notEqual(kernel.bucket.schedulerSession.sessionId, originalKernelId);
  const kernelRestored = loadSchedulerSessionSnapshot(kernelRoot, 'ws');
  assert.deepEqual(kernelRestored.display.map(message => message.id), ['first']);
  assert.equal(kernelRestored.piSessionFile, branched.sessionFile);
  assert.deepEqual(kernelRestored.api, []);
  const branchFile = schedulerSqlitePath(kernelRoot, kernel.bucket.schedulerSession.sessionId);
  assert.ok(fs.existsSync(branchFile));
  assert.ok(!JSON.stringify(kernelRestored).includes('later history'));
  assert.ok(!JSON.stringify(kernelRestored).includes('old-authority'));
  assert.ok(!JSON.stringify(kernelRestored).includes('queued'));
  assert.ok(fs.existsSync(schedulerSqlitePath(kernelRoot, originalKernelId)));

  // A real turn can announce done before its asynchronous undo receipt is
  // ready. The receipt is stripped from forks, so this must not reject an
  // otherwise unchanged user-prefix fork (the real Electron race).
  const receipt = fixture();
  receipt.bucket.display[1].turnChanges = {id: 'late-receipt', state: 'collecting', files: [], warnings: [], finalizing: true};
  receipt.bucket.schedulerSession = makeSchedulerAdapter(path.dirname(receipt.sessionDir), 'ws', {
    display: receipt.bucket.display, api: [], piSessionFile: receipt.file});
  const receiptAdapter = receipt.bucket.schedulerSession;
  const durableBefore = receiptAdapter.revision, forkBefore = receiptAdapter.forkSourceRevision;
  let finishReceipt;
  globalThis.__schedulerForkCreate = (...args) => new Promise(resolve => {finishReceipt = () => resolve(receipt.create(...args));});
  const receiptFork = forkSession(receipt.o, 'first', 'ws');
  receipt.bucket.display[1].turnChanges = {id: 'late-receipt', state: 'ready', files: [{path: 'cold-resume.txt', kind: 'added'}], warnings: []};
  receiptAdapter.recordMessage(receipt.bucket.display[1]);
  assert.ok(receiptAdapter.revision > durableBefore, 'receipt still persists in the parent fact log');
  assert.equal(receiptAdapter.forkSourceRevision, forkBefore, 'non-copied authority must not invalidate fork');
  finishReceipt();
  const receiptResult = await receiptFork;
  assert.equal(receiptResult.ok, true, receiptResult.error); checkReopen(receipt, receiptResult);
  assert.equal(receiptAdapter.snapshot().display[1].turnChanges.state, 'ready');
  assert.ok(!JSON.stringify(loadSchedulerSessionSnapshot(path.dirname(receipt.sessionDir), 'ws')).includes('late-receipt'));

  // Local-message filtering changes which facts are copied, even though the
  // copied DTO itself intentionally has no local flag.
  const eligibility = fixture();
  eligibility.bucket.schedulerSession = makeSchedulerAdapter(path.dirname(eligibility.sessionDir), 'ws', {
    display: eligibility.bucket.display, api: [], piSessionFile: eligibility.file});
  let finishEligibility;
  globalThis.__schedulerForkCreate = (...args) => new Promise(resolve => {finishEligibility = () => resolve(eligibility.create(...args));});
  const eligibilityFork = forkSession(eligibility.o, 'first', 'ws');
  eligibility.bucket.display[1].local = true;
  eligibility.bucket.schedulerSession.recordMessage(eligibility.bucket.display[1]);
  finishEligibility();
  const eligibilityResult = await eligibilityFork;
  assert.equal(eligibilityResult.ok, false); assert.match(eligibilityResult.error, /变化|changed/);
  assert.deepEqual(eligibility.deleted, eligibility.created);
  await eligibility.bucket.schedulerSession.flush('test-finally');

  // Fork uses the same thinking projection as its durable concurrency token.
  // Only the asynchronous SDK-loading boundary is deferred; files and semantic
  // child logs are real and reopened below.
  const { withoutDisplayThinking } = await load('shared/thinkingDisplay.ts');
  const liveThinking = fixture(); liveThinking.cfg.liveThinkingOnly = true;
  liveThinking.bucket.display[1].thinking = 'initial transient reasoning';
  liveThinking.bucket.display[1].parts = [{kind:'thinking',text:'initial transient reasoning'}, {kind:'text',text:'later history'}];
  liveThinking.bucket.schedulerSession = makeSchedulerAdapter(path.dirname(liveThinking.sessionDir), 'ws', {
    display: withoutDisplayThinking(liveThinking.bucket.display), api: [], piSessionFile: liveThinking.file});
  const liveThinkingRevision = liveThinking.bucket.schedulerSession.forkSourceRevision;
  const liveThinkingParentDisplay = liveThinking.bucket.display;
  let finishLiveThinking;
  globalThis.__schedulerForkCreate = (...args) => new Promise(resolve => {finishLiveThinking = () => resolve(liveThinking.create(...args));});
  const liveThinkingFork = forkSession(liveThinking.o, 'later', 'ws');
  liveThinking.bucket.display[1].thinking += ' late transient reasoning';
  liveThinking.bucket.display[1].parts[0].text += ' late transient reasoning';
  liveThinking.bucket.schedulerSession.recordMessage(liveThinking.bucket.display[1], true);
  assert.equal(liveThinking.bucket.schedulerSession.forkSourceRevision, liveThinkingRevision);
  finishLiveThinking();
  const liveThinkingResult = await liveThinkingFork;
  assert.equal(liveThinkingResult.ok, true, liveThinkingResult.error);
  const liveThinkingChild = loadSchedulerSessionSnapshot(path.dirname(liveThinking.sessionDir), 'ws');
  assert.equal(liveThinkingChild.display[1].thinking, undefined);
  assert.deepEqual(liveThinkingChild.display[1].parts, [{kind:'text',text:'later history'}]);
  assert.equal(SessionManager.open(liveThinkingResult.sessionFile, liveThinking.sessionDir).buildSessionContext().messages.length, 2);
  assert.notEqual(liveThinking.bucket.display, liveThinkingParentDisplay);
  assert.match(liveThinkingParentDisplay[1].thinking, /late transient/);

  const keptThinking = fixture(); keptThinking.cfg.liveThinkingOnly = false;
  keptThinking.bucket.schedulerSession = makeSchedulerAdapter(path.dirname(keptThinking.sessionDir), 'ws', {
    display: keptThinking.bucket.display, api: [], piSessionFile: keptThinking.file});
  let finishKeptThinking;
  globalThis.__schedulerForkCreate = (...args) => new Promise(resolve => {finishKeptThinking = () => resolve(keptThinking.create(...args));});
  const keptThinkingFork = forkSession(keptThinking.o, 'later', 'ws');
  keptThinking.bucket.display[1].thinking = 'durable reasoning changed';
  keptThinking.bucket.display[1].parts = [{kind:'thinking',text:'durable reasoning changed'}];
  keptThinking.bucket.schedulerSession.recordMessage(keptThinking.bucket.display[1], false);
  finishKeptThinking();
  const keptThinkingResult = await keptThinkingFork;
  assert.equal(keptThinkingResult.ok, false); assert.match(keptThinkingResult.error, /变化|changed/);
  assert.deepEqual(keptThinking.deleted, keptThinking.created);
  await keptThinking.bucket.schedulerSession.flush('test-finally');

  const thinkingConfig = fixture(); thinkingConfig.cfg.liveThinkingOnly = true;
  let finishThinkingConfig;
  globalThis.__schedulerForkCreate = (...args) => new Promise(resolve => {finishThinkingConfig = () => resolve(thinkingConfig.create(...args));});
  const thinkingConfigFork = forkSession(thinkingConfig.o, 'later', 'ws');
  thinkingConfig.cfg.liveThinkingOnly = false;
  finishThinkingConfig();
  const thinkingConfigResult = await thinkingConfigFork;
  assert.equal(thinkingConfigResult.ok, false); assert.match(thinkingConfigResult.error, /变化|changed/);
  assert.deepEqual(thinkingConfig.deleted, thinkingConfig.created);

  // An in-place edit while SDK loading is detected by event revision even
  // though the display array identity and length remain unchanged.
  const edited = fixture();
  edited.bucket.schedulerSession = makeSchedulerAdapter(path.dirname(edited.sessionDir), 'ws', {
    display: edited.bucket.display, api: [], piSessionFile: edited.file});
  let finishEdit;
  globalThis.__schedulerForkCreate = (...args) => new Promise(resolve => {finishEdit = () => resolve(edited.create(...args));});
  const editFork = forkSession(edited.o, 'first', 'ws');
  edited.bucket.display[0].content = 'edited during fork';
  edited.bucket.schedulerSession.recordMessage(edited.bucket.display[0]);
  finishEdit();
  const editResult = await editFork;
  assert.equal(editResult.ok, false); assert.match(editResult.error, /变化|changed/);
  assert.deepEqual(edited.deleted, edited.created);
  assert.equal(edited.bucket.piSessionFile, edited.file);
  await edited.bucket.schedulerSession.flush('test-finally');

  // The actual SDK can reopen a long streamed archive; the transient manager
  // never retains a second copy of the historical entries.
  const large = fixture(); let yielded = 0, maxEntries = 0;
  const boundedPi = { ...pi, SessionManager: { inMemory(...args) {
    const manager = SessionManager.inMemory(...args);
    const getEntries = manager.getEntries.bind(manager);
    manager.getEntries = () => { const entries = getEntries(); maxEntries = Math.max(maxEntries, entries.length); assert.ok(entries.length <= 1, 'SDK scratch manager is bounded'); return entries; };
    return manager;
  } } };
  function* streamSeeds() {
    for (let i = 0; i < 3000; i++) { yielded++; yield {role: i % 2 ? 'assistant' : 'user', text: `streamed ${i}`, ts: i + 1}; }
  }
  const largeFile = writeFork(large.config, boundedPi, {context: large.context, sessionDir: large.sessionDir,
    seeds: streamSeeds(), title: 'large streamed fork', model, parentFile: large.file});
  assert.equal(yielded, 3000); assert.equal(maxEntries, 1);
  const largeReopen = SessionManager.open(largeFile.sessionFile, large.sessionDir);
  const largeMessages = largeReopen.buildSessionContext().messages;
  assert.equal(largeMessages.length, 3000);
  assert.equal(largeMessages[0].content, 'streamed 0');
  assert.deepEqual(largeMessages.at(-1).content, [{type: 'text', text: 'streamed 2999'}]);

  console.log('scheduler-fork-source: native user-only cold reopen, immutable parent, root inheritance, leases and asynchronous races passed');
} finally {
  delete globalThis.__schedulerForkCreate; delete globalThis.__schedulerForkDelete; delete globalThis.__schedulerLoad;
  for (const bucket of testBuckets) bucket.schedulerSession?.close?.();
  for (const adapter of schedulerAdapters) adapter.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
