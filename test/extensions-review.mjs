import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-review-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { ExtensionReviewStore, ExtensionReviewCoordinator } = await import(pathToFileURL(compile('main/extensions/extensionReview.ts')));
  const reviewFile = path.join(temp, 'state', 'reviews.json');
  const packages = path.join(temp, 'state', 'packages');
  function writePackage(workspace, scope = 'global') {
    const dir = path.join(temp, workspace, 'demo'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ id: 'demo', name: 'Demo', scope, ...(scope === 'project' ? { project: { kind: 'relative', path: 'demo' } } : {}), surface: { kind: 'sidebar', entry: 'panel.html' }, domain: { entry: 'domain.mjs', queries: [], commands: [], events: [] }, agent: { profile: 'scheduler-pi', skills: [], mcp: [] }, data: { workspace: true, shared: false }, permissions: ['agent.state'] }));
    fs.writeFileSync(path.join(dir, 'panel.html'), '<p>one</p>');
    fs.writeFileSync(path.join(dir, 'domain.mjs'), 'export function createDomainRuntime() { return {}; }');
    return dir;
  }
  const a = writePackage('a'), b = writePackage('b');
  let reviewCount = 0, release, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const coordinator = new ExtensionReviewCoordinator(new ExtensionReviewStore(reviewFile), packages, async request => {
    reviewCount++;
    markStarted();
    assert.ok(request.evidence);
    await gate;
    return { approved: true };
  });
  const first = coordinator.submit({ workspaceId: 'a', id: 'demo', directory: a });
  const second = coordinator.submit({ workspaceId: 'b', id: 'demo', directory: b });
  await started;
  while ([...coordinator.observed.values()].filter(item => item.fingerprint).length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reviewCount, 1, 'identical global copies share one review');
  fs.writeFileSync(path.join(a, 'panel.html'), '<p>changed during review</p>');
  release();
  assert.equal((await first).status, 'stale');
  const approved = await second;
  assert.equal(approved.status, 'approved');
  assert.ok(fs.existsSync(approved.snapshotDirectory));
  let laterCalls = 0;
  const restarted = new ExtensionReviewCoordinator(new ExtensionReviewStore(reviewFile), packages, async () => { laterCalls++; return { approved: true }; });
  const reused = await restarted.submit({ workspaceId: 'b', id: 'demo', directory: b });
  assert.equal(reused.status, 'approved'); assert.equal(reused.reused, true); assert.equal(laterCalls, 0);
  let concurrentCount = 0, releaseConcurrent, startConcurrent;
  const concurrentGate = new Promise(resolve => { releaseConcurrent = resolve; });
  const concurrentStarted = new Promise(resolve => { startConcurrent = resolve; });
  const concurrentReview = new ExtensionReviewCoordinator(new ExtensionReviewStore(path.join(temp, 'same-source.json')), packages, async () => { concurrentCount++; startConcurrent(); await concurrentGate; return { approved: true }; });
  const sameInput = { workspaceId: 'b', id: 'demo', directory: b };
  const sameFirst = concurrentReview.submit(sameInput), sameSecond = concurrentReview.submit(sameInput);
  await concurrentStarted; releaseConcurrent();
  assert.deepEqual((await Promise.all([sameFirst, sameSecond])).map(item => item.status), ['approved', 'approved']);
  assert.equal(concurrentCount, 1, 'concurrent submissions from the same source reuse the review');
  const originalOpenSync = fs.openSync;
  let synchronousPackageReads = 0;
  fs.openSync = function(file, ...args) { if (typeof file === 'string' && file.startsWith(b + path.sep)) synchronousPackageReads++; return originalOpenSync.call(this, file, ...args); };
  try { assert.equal((await restarted.submit({ workspaceId: 'b', id: 'demo', directory: b })).status, 'approved'); }
  finally { fs.openSync = originalOpenSync; }
  assert.equal(synchronousPackageReads, 0, 'review must not synchronously read the source package');
  await assert.rejects(() => restarted.submit({ workspaceId: 'a', id: 'demo', directory: a, expectedFingerprint: approved.fingerprint }), /changed since/);

  const p1 = writePackage('p1', 'project'), p2 = writePackage('p2', 'project');
  let projectReviews = 0;
  const projectCoordinator = new ExtensionReviewCoordinator(new ExtensionReviewStore(path.join(temp, 'project-reviews.json')), path.join(temp, 'project-packages'), async () => { projectReviews++; return { approved: true }; });
  assert.equal((await projectCoordinator.submit({ workspaceId: 'p1', id: 'demo', directory: p1 })).status, 'approved');
  assert.equal((await projectCoordinator.submit({ workspaceId: 'p2', id: 'demo', directory: p2 })).status, 'approved');
  assert.equal(projectReviews, 2, 'project trust is workspace and binding scoped');

  let decisions = 0;
  const rejectStore = path.join(temp, 'rejected.json');
  const rejectCoordinator = new ExtensionReviewCoordinator(new ExtensionReviewStore(rejectStore), packages, async () => { decisions++; return decisions === 1 ? { approved: false, reason: 'review rejected' } : { approved: true }; });
  const input = { workspaceId: 'b', id: 'demo', directory: b };
  assert.equal((await rejectCoordinator.submit(input)).status, 'rejected');
  assert.equal((await rejectCoordinator.submit(input)).reused, true);
  assert.equal(decisions, 1);
  assert.equal((await rejectCoordinator.submit(input, { retryRejected: true })).status, 'approved');
  assert.equal(decisions, 2);

  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  const revocation = new ExtensionReviewCoordinator(new ExtensionReviewStore(path.join(temp, 'revoked.json')), packages, async () => { await delayed; return { approved: true }; });
  const revoked = revocation.submit({ ...input });
  revocation.invalidate('b', 'demo'); finish();
  assert.equal((await revoked).status, 'stale');
  assert.equal(fs.existsSync(path.join(temp, 'revoked.json')), false);

  let startIdentityCheck, releaseIdentityCheck, identityCurrent = true;
  const identityStarted = new Promise(resolve => { startIdentityCheck = resolve; });
  const identityGate = new Promise(resolve => { releaseIdentityCheck = resolve; });
  const identityFile = path.join(temp, 'identity-revoked.json');
  const identityReview = new ExtensionReviewCoordinator(new ExtensionReviewStore(identityFile), packages, async () => ({ approved: true }));
  const pendingIdentity = identityReview.submit({ ...input, isCurrentAsync: async () => { startIdentityCheck(); await identityGate; return identityCurrent; } });
  await identityStarted; identityCurrent = false; releaseIdentityCheck();
  assert.equal((await pendingIdentity).status, 'stale', 'asynchronous target revocation cannot publish a review decision');
  assert.equal(fs.existsSync(identityFile), false);

  let finishIgnored, cancelledSignal, cancelCalls = 0, markCancelStarted;
  const cancelStarted = new Promise(resolve => { markCancelStarted = resolve; });
  const ignored = new Promise(resolve => { finishIgnored = resolve; });
  const cancelling = new ExtensionReviewCoordinator(new ExtensionReviewStore(path.join(temp, 'cancelled.json')), packages, async request => {
    cancelCalls++;
    if (cancelCalls === 1) { cancelledSignal = request.signal; markCancelStarted(); await ignored; }
    return { approved: true };
  });
  const obsolete = cancelling.submit(input);
  await cancelStarted;
  cancelling.cancelPending();
  assert.equal(cancelledSignal.aborted, true);
  assert.equal((await obsolete).status, 'stale', 'cancellation does not wait for a reviewer that ignores its signal');
  assert.equal((await cancelling.submit(input)).status, 'approved', 'a new scan does not reuse a cancelled review');
  finishIgnored();
  await Promise.resolve();
  assert.equal(cancelCalls, 2);

  let owned = true, identityReached, releaseBundleCheck;
  const bundleReached = new Promise(resolve => { identityReached = resolve; });
  const bundleGate = new Promise(resolve => { releaseBundleCheck = resolve; });
  const bundleFile = path.join(temp, 'bundled-revoked.json');
  const bundleReview = new ExtensionReviewCoordinator(new ExtensionReviewStore(bundleFile), packages,
    async () => { throw new Error('a bundled package must not call the reviewer'); }, () => owned);
  let bundleIdentityCalls = 0;
  const bundlePending = bundleReview.submit({ ...input, isCurrentAsync: async () => { bundleIdentityCalls++; if (bundleIdentityCalls >= 2) { identityReached(); await bundleGate; } return true; } });
  await bundleReached; owned = false; releaseBundleCheck();
  assert.equal((await bundlePending).status, 'stale', 'revoked bundled ownership cannot create trust');
  assert.equal(fs.existsSync(bundleFile), false);

  let bundled = false, startedReview, releaseReview;
  const reviewerStarted = new Promise(resolve => { startedReview = resolve; });
  const reviewerGate = new Promise(resolve => { releaseReview = resolve; });
  const promotedFile = path.join(temp, 'bundled-promotion.json');
  const promoted = new ExtensionReviewCoordinator(new ExtensionReviewStore(promotedFile), packages, async () => {
    startedReview(); await reviewerGate; return { approved: false, reason: 'late denial' };
  }, () => bundled);
  const oldReview = promoted.submit(input);
  await reviewerStarted; bundled = true;
  assert.equal((await promoted.submit(input)).status, 'approved');
  assert.equal((await oldReview).status, 'stale', 'the obsolete in-flight review is cancelled');
  releaseReview(); await Promise.resolve();
  assert.equal(Object.values(JSON.parse(fs.readFileSync(promotedFile, 'utf8')).records)[0].decision, 'approved', 'a late denial cannot replace bundled trust');

  let readyToTrust = false, reachedOldCheck, releaseOldCheck;
  const oldCheckStarted = new Promise(resolve => { reachedOldCheck = resolve; });
  const oldCheckGate = new Promise(resolve => { releaseOldCheck = resolve; });
  const settledFile = path.join(temp, 'bundled-after-decision.json');
  const settled = new ExtensionReviewCoordinator(new ExtensionReviewStore(settledFile), packages,
    async () => ({ approved: false, reason: 'obsolete decision' }), () => readyToTrust);
  let settledIdentityCalls = 0;
  const settledOld = settled.submit({ ...input, isCurrentAsync: async () => { settledIdentityCalls++; if (settledIdentityCalls >= 2) { reachedOldCheck(); await oldCheckGate; } return true; } });
  await oldCheckStarted; readyToTrust = true;
  assert.equal((await settled.submit(input)).status, 'approved');
  releaseOldCheck();
  assert.equal((await settledOld).status, 'stale', 'a reviewer already checking its target cannot overwrite newer bundled trust');
  assert.equal(Object.values(JSON.parse(fs.readFileSync(settledFile, 'utf8')).records)[0].decision, 'approved');
  fs.writeFileSync(path.join(temp, 'corrupt.json'), '{broken');
  assert.throws(() => new ExtensionReviewStore(path.join(temp, 'corrupt.json')));
  console.log('extensions-review: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
