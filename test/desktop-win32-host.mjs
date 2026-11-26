import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-win32-host-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { createWin32DesktopHost } = await import(pathToFileURL(compile('main/desktop/win32DesktopHost.ts')));
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const events = [];
  const authority = { sentinel: 'the same authority' };
  let targetCount = 0, resolveComposition;
  const compositionGate = new Promise(resolve => { resolveComposition = resolve; });
  const targets = { close() { events.push('targets closed'); } };
  const composition = { dispatcher: { run() { throw new Error('unused'); } },
    desktopEngineDelivery() { return authority; }, async close() { events.push('composition closing'); await compositionGate; events.push('composition closed'); } };
  const selector = { hasScope: () => true, cua() { throw new Error('unused'); }, win32() { throw new Error('unused'); } };
  const host = createWin32DesktopHost({ composition, selector, labels,
    createTargets() { targetCount++; return targets; }, dipToPhysical: point => point,
    driverPath() { throw new Error('unused'); }, reportStopError(error) { throw error; },
    createIndicator: () => ({ async show() { events.push('shown'); }, close() { events.push('indicator closed'); } }) });
  assert.equal(targetCount, 0, 'native target discovery is lazy');
  assert.equal(host.desktopTargets(), targets);
  assert.equal(host.desktopTargets(), targets);
  assert.equal(targetCount, 1, 'all bindings share one target registry');
  assert.equal(host.desktopTurns(), host.desktopTurns());
  assert.equal(host.desktopPtyTurns(), host.desktopPtyTurns());
  assert.equal(host.desktopEngineDelivery(), authority, 'tool drivers use the composition that owns the dispatcher');
  const turns = host.desktopTurns();
  turns.begin('session', 'turn', () => true);
  await turns.use('session', 'turn', 'fixture', async () => 'observed', false);
  assert.ok(host.visibilityEpoch() !== undefined);
  const closing = host.close();
  assert.equal(host.close(), closing, 'concurrent shutdown shares one completion');
  assert.equal(host.visibilityEpoch(), undefined, 'closing immediately revokes visibility');
  assert.throws(() => host.desktopTurns(), /closed/);
  assert.throws(() => host.desktopEngineDelivery(), /closed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.indexOf('indicator closed') < events.indexOf('targets closed'));
  assert.ok(events.indexOf('targets closed') < events.indexOf('composition closing'));
  assert.ok(!events.includes('composition closed'), 'shutdown waits for the durable authority');
  resolveComposition(); await closing;
  assert.equal(events.filter(value => value === 'targets closed').length, 1);
  assert.equal(events.filter(value => value === 'composition closed').length, 1);

  let authorityClosed = false;
  const failing = createWin32DesktopHost({ composition: { ...composition, async close() { authorityClosed = true; } }, selector, labels,
    createTargets: () => ({ close() { throw new Error('target cleanup failed'); } }), dipToPhysical: point => point,
    driverPath() { throw new Error('unused'); }, reportStopError() {},
    createIndicator: () => ({ async show() {}, close() {} }) });
  failing.desktopTargets();
  await assert.rejects(failing.close(), /Windows desktop host cleanup failed/);
  assert.equal(authorityClosed, true, 'one cleanup failure must not skip the authority cleanup');
  let closedAfterRuntimeFailure = false, targetClosedAfterRuntimeFailure = false;
  const unconfirmed = createWin32DesktopHost({ composition: { ...composition, async close() { closedAfterRuntimeFailure = true; } }, selector, labels,
    createTargets: () => ({ close() { targetClosedAfterRuntimeFailure = true; } }), dipToPhysical: point => point,
    driverPath() { throw new Error('unused'); }, reportStopError() {},
    createIndicator: () => ({ async show() {}, close() { throw new Error('indicator cleanup failed'); } }) });
  unconfirmed.desktopTargets();
  await assert.rejects(unconfirmed.close(), /runtime cleanup is unconfirmed/);
  assert.equal(targetClosedAfterRuntimeFailure, false, 'unconfirmed runtime cleanup retains target identity');
  assert.equal(closedAfterRuntimeFailure, false, 'unconfirmed runtime cleanup retains the durable authority');
  const local = createWin32DesktopHost({ composition: { dispatcher: composition.dispatcher, async close() {} }, labels,
    createTargets: () => ({ close() {} }), dipToPhysical: point => point,
    driverPath() { throw new Error('unused'); }, reportStopError() {},
    createIndicator: () => ({ async show() {}, close() {} }) });
  assert.equal('desktopEngineDelivery' in local, false, 'an engine-delivery tracker is not fabricated for the local receipt mode');
  await local.close();
  assert.throws(() => createWin32DesktopHost({}), /dependencies/);
  console.log('Windows desktop host: shared bindings, immediate revocation and ordered cleanup passed');
} finally { removeWorkspaceFixture(temp, 'desktop-win32-host-'); }
