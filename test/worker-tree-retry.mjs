/** Real guard entry points; deterministic Git boundary and event pump, no real Git processes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-tree-retry-'));
const compile = createSharedCompiler(root, tmp);
const entry = compile('main/agentSession/workerTreeGuard.ts');
// Keep both entry points and their policy real; control only Git IO and the event queue boundary.
fs.writeFileSync(path.join(tmp, 'main/git/worktreeTaskWorker.mjs'), `
export async function guardTaskWorktrees(ctx, session, snapshot) { return ctx.probe(snapshot); }
`);
fs.mkdirSync(path.join(tmp, 'main/orchestrator'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'main/orchestrator/events.mjs'), `
let pump;
export function bindOrchestratorEventPump(value) { pump = value; }
export function getOrchestratorEventPump() { return pump; }
`);
const { afterNeedsYouReported, beforeRequestIntegrate } = await import(pathToFileURL(entry));
const { bindOrchestratorEventPump } = await import(pathToFileURL(path.join(tmp, 'main/orchestrator/events.mjs')));
const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')));
const { isTransientWorkerTreeError, retryWorkerTreeRead } = await import(pathToFileURL(compile('main/agentSession/workerTreeRetry.ts')));
const lock = marker => `root-private/group-private/.: repository has an active Git operation: ${marker}`;
function fixture() {
  const calls = [], nudges = [], events = [], waits = [];
  const owner = { id: 'worker', name: 'Task', workspaceId: 'workspace', worktreeGroups: {
    version: 1, primaryGroupId: 'group-private', cwdPolicy: 'source', groups: [{
      id: 'group-private', path: path.join(tmp, 'task'), branch: 'ao/task', repos: [],
      sourceRoot: { rootId: 'root-private', path: tmp, cwd: tmp },
      source: { mainRepo: tmp, commonDir: path.join(tmp, '.git') }
    }]
  } };
  const ctx = { sessions: { get: () => owner }, probe: async snapshot => {
    calls.push(snapshot);
    return { paths: [], snapshots: [], worktreeGroups: [], committed: false };
  }, agentSessions: { getTurnStartedAt: () => undefined, injectHostNudge: async (_id, text) => {
    nudges.push(text); return { ok: true };
  } } };
  bindOrchestratorEventPump({ enqueue: event => events.push(event) });
  return { ctx, calls, nudges, events, retry: { sleep: async ms => waits.push(ms) }, waits };
}
try {
  applyLocaleSetting('zh-CN');
  for (const marker of ['index.lock', 'HEAD.lock', 'locked']) {
    const f = fixture(); const probe = f.ctx.probe; let attempts = 0;
    f.ctx.probe = async snapshot => ++attempts < 3 ? { failure: lock(marker) } : probe(snapshot);
    const result = await afterNeedsYouReported(f.ctx, 'worker', undefined, f.retry);
    assert.deepEqual(f.nudges, [], 'transient lock must never wake the Worker');
    assert.deepEqual(f.events, [], 'recovered lock must never wake the scheduler');
    assert.equal(result.dirty, false); assert.equal(attempts, 3);
    assert.deepEqual(f.waits, [200, 200]);
  }
  const persistent = fixture(); let attempts = 0;
  persistent.ctx.probe = async () => { attempts++; return { failure: lock('index.lock') }; };
  for (let i = 0; i < 2; i++) await afterNeedsYouReported(persistent.ctx, 'worker', undefined, persistent.retry);
  assert.equal(attempts, 8); assert.equal(persistent.events.length, 1);
  assert.deepEqual(persistent.nudges, []);
  assert.equal(persistent.events[0].kind, 'merge_blocked');
  assert.equal(persistent.events[0].touchActivity, false);
  assert.match(persistent.events[0].detail, /宿主提示/);
  assert.doesNotMatch(persistent.events[0].detail, /root-private|group-private|index.lock|active Git/);
  persistent.ctx.probe = async () => ({ paths: [] });
  await afterNeedsYouReported(persistent.ctx, 'worker', undefined, persistent.retry);
  persistent.ctx.probe = async () => ({ failure: lock('index.lock') });
  await afterNeedsYouReported(persistent.ctx, 'worker', undefined, persistent.retry);
  assert.equal(persistent.events.length, 2, 'a new incident after recovery can notify the scheduler');

  const dirty = fixture();
  dirty.ctx.probe = async () => ({ paths: ['root-private/group-private/.: source.ts'] });
  await afterNeedsYouReported(dirty.ctx, 'worker', undefined, dirty.retry);
  await afterNeedsYouReported(dirty.ctx, 'worker', undefined, dirty.retry);
  assert.equal(dirty.nudges.length, 1); assert.deepEqual(dirty.events, []);
  assert.match(dirty.nudges[0], /宿主提示.*未提交.*source.ts/);
  assert.doesNotMatch(dirty.nudges[0], /root-private|group-private/);
  dirty.ctx.probe = async () => ({ paths: [] });
  await afterNeedsYouReported(dirty.ctx, 'worker', undefined, dirty.retry);
  dirty.ctx.probe = async () => ({ paths: ['root-private/group-private/.: source.ts'] });
  await afterNeedsYouReported(dirty.ctx, 'worker', undefined, dirty.retry);
  assert.equal(dirty.nudges.length, 2, 'new dirt after recovery can be reported');

  applyLocaleSetting('en');
  const english = fixture();
  english.ctx.probe = async () => ({ paths: ['root-private/group-private/.: source.ts'] });
  await afterNeedsYouReported(english.ctx, 'worker', undefined, english.retry);
  assert.match(english.nudges[0], /Host notice.*uncommitted/);
  assert.doesNotMatch(english.nudges[0], /[\u4e00-\u9fff]/);
  english.ctx.probe = async () => { throw new Error('identity changed: root-private'); };
  await afterNeedsYouReported(english.ctx, 'worker', undefined, english.retry);
  assert.equal(english.events.length, 1); assert.equal(english.waits.length, 0);
  assert.match(english.events[0].detail, /Host notice/);
  assert.equal(english.nudges.length, 1, 'host identity failure adds no nudge');

  const integrate = fixture(); let reads = 0, writes = 0;
  integrate.ctx.probe = async snapshot => {
    if (!snapshot && ++reads === 1) return { failure: lock('HEAD.lock') };
    if (snapshot) writes++;
    return { paths: [], snapshots: [], worktreeGroups: [], committed: snapshot };
  };
  assert.equal((await beforeRequestIntegrate(integrate.ctx, 'worker', integrate.retry)).fallbackCommit, true);
  assert.equal(writes, 1); assert.equal(reads, 2);
  assert.deepEqual(integrate.nudges, []); assert.deepEqual(integrate.events, []);
  const blocked = fixture(); let writesBlocked = 0;
  blocked.ctx.probe = async snapshot => { if (snapshot) writesBlocked++; return { failure: lock('locked') }; };
  assert.equal((await beforeRequestIntegrate(blocked.ctx, 'worker', blocked.retry)).fallbackCommit, false);
  assert.equal(writesBlocked, 0); assert.equal(blocked.waits.length, 3);
  assert.equal(blocked.events.length, 1); assert.deepEqual(blocked.nudges, []);

  dirty.ctx.probe = async () => ({ paths: [], snapshots: [], worktreeGroups: [], committed: true });
  await beforeRequestIntegrate(dirty.ctx, 'worker', dirty.retry);
  dirty.ctx.probe = async () => ({ paths: ['root-private/group-private/.: source.ts'] });
  await afterNeedsYouReported(dirty.ctx, 'worker', undefined, dirty.retry);
  assert.equal(dirty.nudges.length, 3, 'successful integration preflight/snapshot clears the old dirty reminder');
  const partial = fixture(); let snapshots = 0;
  partial.ctx.probe = async snapshot => snapshot
    ? (++snapshots, { failure: lock('index.lock'), committed: true, snapshots: [{ committed: true }], paths: [], worktreeGroups: [] })
    : { paths: [] };
  const failed = await beforeRequestIntegrate(partial.ctx, 'worker', partial.retry);
  assert.equal(snapshots, 1, 'never replay a write after partial success');
  assert.equal(failed.snapshots[0].committed, true); assert.equal(failed.fallbackCommit, false);
  assert.equal(partial.events.length, 1); assert.deepEqual(partial.nudges, []);
  assert.doesNotMatch(failed.fallbackError, /root-private|group-private|active Git operation/);

  for (const marker of ['MERGE_HEAD', 'rebase-apply', 'sequencer']) assert.equal(isTransientWorkerTreeError(lock(marker)), false);
  assert.equal(isTransientWorkerTreeError('permission denied: /locked'), false);
  const delays = []; let count = 0;
  await assert.rejects(retryWorkerTreeRead(async () => { count++; throw new Error(lock('locked')); }, {
    attempts: 100, delayMs: 1, sleep: async ms => delays.push(ms)
  }));
  assert.equal(count, 4); assert.deepEqual(delays, [150, 150, 150]);
  console.log('[ok] transient recovery, persistent event, actionable dirt, dedupe, locales, snapshot safety');
} finally {
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'worker-tree-retry-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
