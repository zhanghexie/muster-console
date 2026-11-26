import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-action-evidence-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { DesktopActionEvidence } = await import(pathToFileURL(compile('main/desktop/actionEvidence.ts')));
  const { DesktopActionGate } = await import(pathToFileURL(compile('main/desktop/actionGate.ts')));
  const { DesktopAuthority } = await import(pathToFileURL(compile('main/desktop/authority.ts')));
  const { DesktopUnknownState } = await import(pathToFileURL(compile('main/desktop/unknownState.ts')));
  const { UnknownActionChains } = await import(pathToFileURL(compile('main/desktop/unknownActionChain.ts')));
  const { DesktopDispatchJournal } = await import(pathToFileURL(compile('main/desktop/dispatchJournal.ts')));
  const { DesktopTaskLock } = await import(pathToFileURL(compile('main/desktop/taskLock.ts')));
  let clock = 100, sourceCurrent = true;
  const store = new DesktopActionEvidence(async () => ({ width: 2, height: 3 }), () => clock);
  const identity = { taskId: 'task', appId: 'app', processInstance: 'proc', surfaceId: 'surface', surfaceGeneration: 'generation',
    captureId: 'capture', geometryRevision: 'geometry', region: { x: 1, y: 2, width: 2, height: 3 } };
  const bytes = Buffer.alloc(64, 10), expected = createHash('sha256').update(bytes).digest('hex');
  const digest = await store.register('session', identity, bytes, 200, () => sourceCurrent);
  assert.equal(digest, expected);
  bytes.fill(20); identity.region.x = 90;
  const boundary = { ...identity, region: { x: 1, y: 2, width: 2, height: 3 }, actionClass: 'click', evidenceSha256: digest };
  const bound = store.bind('session'), proof = await bound.verify(boundary);
  assert.equal(proof(), true);
  const preview = await bound.preview(boundary);
  assert.equal(createHash('sha256').update(preview.png).digest('hex'), expected, 'registration snapshots bytes');
  preview.png.fill(0);
  assert.equal(createHash('sha256').update((await bound.preview(boundary)).png).digest('hex'), expected, 'previews cannot mutate evidence');
  for (const invalid of [{ ...boundary, processInstance: 'other' }, { ...boundary, surfaceGeneration: 'other' },
    { ...boundary, region: { ...boundary.region, x: 8 } }, { ...boundary, evidenceSha256: '0'.repeat(64) }]) {
    await assert.rejects(bound.verify(invalid), /unavailable or changed/);
  }
  await assert.rejects(store.bind('other-session').verify(boundary), /unavailable or changed/);
  await assert.rejects(bound.verify({ ...boundary, taskId: 'other-task' }), /unavailable or changed/);
  await assert.rejects(store.register('session', { ...boundary, region: boundary.region }, Buffer.alloc(64), 200, () => true), /already exists/);
  sourceCurrent = false; assert.equal(proof(), false); store.cleanup();
  await assert.rejects(bound.preview(boundary), /unavailable or changed/);
  sourceCurrent = true;
  await store.register('session', { ...boundary, captureId: 'next', region: boundary.region }, Buffer.alloc(64, 1), 200, () => sourceCurrent);
  const nextProof = await bound.verify({ ...boundary, captureId: 'next', evidenceSha256: createHash('sha256').update(Buffer.alloc(64, 1)).digest('hex') });
  clock = 200; assert.equal(nextProof(), false); store.cleanup();
  let release;
  const slow = new DesktopActionEvidence(() => new Promise(resolve => { release = resolve; }), () => clock);
  const pending = slow.register('session', { ...boundary, region: boundary.region }, Buffer.alloc(64), 300, () => sourceCurrent);
  sourceCurrent = false; release({ width: 2, height: 3 });
  await assert.rejects(pending, /no longer current/);
  let resume;
  const closing = new DesktopActionEvidence(() => new Promise(resolve => { resume = resolve; }), () => clock);
  sourceCurrent = true;
  const late = closing.register('session', { ...boundary, region: boundary.region }, Buffer.alloc(64), 300, () => true);
  closing.endSession('session'); resume({ width: 2, height: 3 });
  await assert.rejects(late, /no longer current/, 'close invalidates in-flight evidence even if a stale source callback returns true');
  sourceCurrent = true; clock = 100;
  await store.register('session', { ...boundary, captureId: 'last', region: boundary.region }, Buffer.alloc(64, 2), 200, () => true);
  const last = await bound.verify({ ...boundary, captureId: 'last', evidenceSha256: createHash('sha256').update(Buffer.alloc(64, 2)).digest('hex') });
  store.endSession('session'); assert.equal(last(), false);
  const integration = new DesktopActionEvidence(async () => ({ width: 2, height: 3 }), () => clock);
  const integrationBytes = Buffer.alloc(64, 3), integrationId = { ...boundary, captureId: 'integrated', region: boundary.region };
  const integrationHash = await integration.register('session', integrationId, integrationBytes, 200, () => sourceCurrent);
  const actionBoundary = { ...integrationId, evidenceSha256: integrationHash }, scoped = integration.bind('session');
  const journal = new DesktopDispatchJournal(path.join(temp, 'integrated-journal'));
  let prompts = 0, dispatches = 0;
  const gate = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(journal), async item => { prompts++; assert.deepEqual((await scoped.preview(item)).png, integrationBytes); return true; },
  async () => {}, new DesktopTaskLock(path.join(temp, 'integrated-lock')), scoped.verify);
  const request = { taskId: 'task', target: { appId: 'app', processInstance: 'proc', surfaceId: 'surface', surfaceGeneration: 'generation' },
    action: 'click', foreground: false };
  await gate.runUnknown(request, actionBoundary, () => true, async () => ++dispatches);
  await gate.runUnknown(request, actionBoundary, () => true, async () => ++dispatches);
  assert.equal(prompts, 1); assert.equal(dispatches, 2);
  sourceCurrent = false;
  await assert.rejects(gate.runUnknown(request, actionBoundary, () => true, async () => ++dispatches), /unavailable or changed/);
  assert.equal(dispatches, 2, 'a stale capture cannot be used even when the chain was approved');
  const bounded = new DesktopActionEvidence(async () => ({ width: 2, height: 3 }), () => clock);
  for (let i = 0; i < 32; i++) await bounded.register('session', { ...boundary, captureId: `cap-${i}`, region: boundary.region }, Buffer.alloc(64), 200, () => true);
  await assert.rejects(bounded.register('session', { ...boundary, captureId: 'overflow', region: boundary.region }, Buffer.alloc(64), 200, () => true), /capacity reached/);
  clock = 200; bounded.cleanup();
  await bounded.register('session', { ...boundary, captureId: 'replacement', region: boundary.region }, Buffer.alloc(64), 300, () => true);
  console.log('desktop action evidence: immutable bytes, actor scope, expiry and lifecycle races passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
