import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-continuation-source-'));
let queue, sources;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { ResumeWaitStore } = await import(pathToFileURL(compile('main/resumeWait/store.ts')));
  const { ResumeWaitService } = await import(pathToFileURL(compile('main/resumeWait/service.ts')));
  const { DesktopContinuationSources, bindDesktopContinuationDelivery } = await import(pathToFileURL(compile('main/resumeWait/desktopSources.ts')));
  const { DesktopResumeStateLedger } = await import(pathToFileURL(compile('main/desktop/desktopResumeState.ts')));
  const sourceFile = path.join(temp, 'desktop', 'continuations.sqlite');
  const queueDir = path.join(temp, 'queue');
  queue = new ResumeWaitStore(queueDir);
  sources = new DesktopContinuationSources(sourceFile);
  const input = { owner: 'owner-A', workspaceId: 'workspace-A', condition: { kind: 'time', at: '2026-11-06T00:00:00Z' },
    note: 'continue', priority: 'normal', deadlineAt: null, desktopEpoch: null, desktopEpochGeneration: null, desktopEpochUnknown: false };
  const origin = { owner: input.owner, workspaceId: input.workspaceId, stopGeneration: 3 };
  const first = queue.arm(input, 100);
  sources.record(first, origin);
  assert.throws(() => sources.record(first, { ...origin, stopGeneration: 4 }), /UNIQUE/);
  assert.equal(sources.matches(first, origin), true);
  assert.equal(sources.matches(first, { ...origin, stopGeneration: 4 }), false, 'a later stop revokes an earlier source');
  assert.equal(sources.matches({ ...first, owner: 'owner-B' }, origin), false);
  assert.equal(sources.matches({ ...first, workspaceId: 'workspace-B' }, origin), false);
  assert.equal(sources.matches({ ...first, note: 'tampered' }, origin), false);
  assert.equal(sources.matches({ ...first, condition: { kind: 'time', at: '2026-11-07T00:00:00Z' } }, origin), false);
  assert.throws(() => sources.matches({ ...first, condition: { ...first.condition, injected: true } }, origin), /condition/);
  assert.equal(sources.matches({ ...first, desktopEpochUnknown: true }, origin), false);
  assert.equal(sources.matches({ ...first, id: 'wait-unrecognized' }, origin), false);
  assert.throws(() => sources.matches(first, { ...origin, stopGeneration: -1 }), /generation/);
  assert.throws(() => sources.record(first, { ...origin, owner: 'owner-B' }), /owner changed/);

  assert.equal(queue.fire(first.id, 'time:fixture', '{"untrusted":true}'), true);
  const fired = queue.get(first.id);
  assert.equal(sources.matches(fired, origin), true, 'normal trigger and delivery transitions do not change the source');
  assert.ok(queue.attempted(first.id, 200));
  assert.equal(sources.matches(queue.get(first.id), origin), true);

  sources.close(); queue.close(); sources = queue = undefined;
  queue = new ResumeWaitStore(queueDir);
  sources = new DesktopContinuationSources(sourceFile);
  assert.equal(sources.matches(queue.get(first.id), origin), true, 'source remains verifiable after restart');
  const delivery = bindDesktopContinuationDelivery(sources, [queue.get(first.id)], queue, 'owner-A', 'workspace-A');
  assert.equal(delivery.allows(origin), true);
  assert.equal(delivery.allows({ ...origin, stopGeneration: 4 }), false, 'a new stop invalidates an already-bound delivery');
  assert.equal(delivery.allows({ ...origin, owner: 'owner-B' }), false);
  const queueDb = new DatabaseSync(path.join(queueDir, 'event-log.sqlite'));
  queueDb.prepare('UPDATE resume_waits SET note=? WHERE id=?').run('forged', first.id);
  assert.equal(sources.matches(queue.get(first.id), origin), false, 'editing the durable queue cannot alter a source');
  assert.equal(delivery.allows(origin), false, 'a previously-bound delivery rechecks durable queue identity');
  queueDb.close();

  const unicode = { ...first, id: 'wait-utf16', owner: 'owner-\ud800' };
  const unicodeOrigin = { ...origin, owner: unicode.owner };
  sources.record(unicode, unicodeOrigin);
  assert.equal(sources.matches(unicode, unicodeOrigin), true);
  assert.equal(sources.matches({ ...unicode, owner: 'owner-\udc00' }, { ...unicodeOrigin, owner: 'owner-\udc00' }), false,
    'owner comparison preserves UTF-16 even when both supplied owners change');
  sources.forget(unicode.id);
  assert.equal(sources.matches(unicode, unicodeOrigin), false);

  let logged;
  const workingService = new ResumeWaitService(queue, {
    now: () => 299, isBusy: () => false,
    deliver: async () => ({ status: 'submitted' }), alert: () => {}, desktopEpoch: () => null,
    recordDesktopSource: wait => sources.record(wait, origin)
  });
  const recorded = workingService.arm('owner-A', 'workspace-A', { condition: input.condition, note: 'host source' });
  assert.equal(sources.matches(queue.get(recorded.id), origin), true, 'real arm records the trusted source after the wait exists');
  const service = new ResumeWaitService(queue, {
    now: () => 300, isBusy: () => false,
    deliver: async () => ({ status: 'submitted' }), alert: () => {}, desktopEpoch: () => null,
    recordDesktopSource: () => { throw new Error('simulated source failure'); }
  });
  const originalError = console.error;
  let stillArmed;
  try {
    console.error = (...args) => { logged = args; };
    stillArmed = service.arm('owner-A', 'workspace-A', { condition: input.condition, note: 'text may continue' });
  } finally { console.error = originalError; }
  assert.equal(stillArmed.state, 'armed', 'source storage failure does not block the wait');
  assert.match(String(logged?.[0]), /source unavailable/);
  assert.equal(sources.matches(stillArmed, origin), false, 'a failed source write cannot authorize desktop use');
  const mixed = bindDesktopContinuationDelivery(sources, [recorded, stillArmed], queue, 'owner-A', 'workspace-A');
  assert.equal(mixed.allows(origin), false, 'an unknown source freezes the whole delivered batch');

  const stopFile = path.join(temp, 'desktop', 'stop.sqlite');
  let stop = new DesktopResumeStateLedger(stopFile);
  stop.markStopped(); stop.markResumed('owner-A');
  let inspector = new DatabaseSync(stopFile, { readOnly: true });
  const generation = () => Number(inspector.prepare('SELECT generation FROM desktop_stop_generation WHERE slot=1').get().generation);
  const prior = queue.arm({ ...input, note: 'prior stop generation' }, 400);
  sources.record(prior, { ...origin, stopGeneration: generation() });
  stop.markStopped(); stop.markResumed('owner-A');
  const current = { ...origin, stopGeneration: generation() };
  assert.equal(sources.matches(prior, current), false, 'a fresh instruction does not revive a wait from before the latest stop');
  const after = queue.arm({ ...input, note: 'current stop generation' }, 401);
  sources.record(after, current);
  stop.close(); inspector.close();
  stop = new DesktopResumeStateLedger(stopFile); inspector = new DatabaseSync(stopFile, { readOnly: true });
  assert.equal(stop.isResumed('owner-A'), true);
  assert.equal(sources.matches(after, { ...origin, stopGeneration: generation() }), true, 'post-stop source and resume survive restart');
  assert.equal(sources.matches(prior, { ...origin, stopGeneration: generation() }), false);
  inspector.close(); stop.close();

  // Cleanup never removes a live wait's source and only follows queue removal.
  const cleanup = queue.arm({ ...input, note: 'cleanup source' }, 402);
  sources.record(cleanup, current);
  sources.pruneRemoved(queue, 512);
  assert.equal(sources.matches(cleanup, current), true);
  const cleanupDb = new DatabaseSync(path.join(queueDir, 'event-log.sqlite'));
  cleanupDb.prepare('DELETE FROM resume_waits WHERE id=?').run(cleanup.id); cleanupDb.close();
  sources.pruneRemoved(queue, 512);
  assert.equal(sources.matches(cleanup, current), false);

  sources.close(); sources = undefined;
  const sourceDb = new DatabaseSync(sourceFile);
  sourceDb.exec('DROP TABLE desktop_continuation_sources'); sourceDb.close();
  assert.throws(() => new DesktopContinuationSources(sourceFile), /desktop_continuation_sources/,
    'damaged storage cannot be recreated as an empty authority');
  console.log('desktop continuation source: durable wait identity, generation and tamper boundaries passed');
} finally {
  sources?.close(); queue?.close();
  removeWorkspaceFixture(temp, 'desktop-continuation-source-');
}
