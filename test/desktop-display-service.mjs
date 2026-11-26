import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-display-service-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopDisplayService } = await import(pathToFileURL(compile('main/desktop/displayService.ts')));
  const { ElectronDisplayRegistry } = await import(pathToFileURL(compile('main/desktop/displayRegistry.ts')));
  const { ScreenReadAuthority } = await import(pathToFileURL(compile('main/desktop/screenReadAuthority.ts')));
  const { VisibleScreenGuard } = await import(pathToFileURL(compile('main/desktop/visibleScreenGuard.ts')));
  const { DesktopDispatchJournal } = await import(pathToFileURL(compile('main/desktop/dispatchJournal.ts')));
  const provider = new EventEmitter();
  const display = { id: 1, label: 'Monitor', bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1, rotation: 0 };
  provider.getAllDisplays = () => [display];
  const power = new EventEmitter();
  const registry = new ElectronDisplayRegistry(provider, power), journal = new DesktopDispatchJournal(path.join(temp, 'journal'));
  let approvals = 0, creates = 0, removes = 0, actorCurrent = true, sourceImpl;
  const audits = [];
  const authority = new ScreenReadAuthority(journal, async () => { approvals++; return true; }, async () => {});
  const fakePng = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fakePng);
  fakePng.writeUInt32BE(13, 8); fakePng.write('IHDR', 12); fakePng.writeUInt32BE(10, 16); fakePng.writeUInt32BE(10, 20);
  const image = { isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }), toPNG: () => fakePng };
  sourceImpl = async () => [{ display_id: '1', thumbnail: image }];
  const service = new DesktopDisplayService(registry, authority, () => sourceImpl(), () => ({
    create: async () => { creates++; return { artifactId: 'id', path: '/private/id.png', mimeType: 'image/png', width: 10, height: 10, capturedAt: 1, expiresAt: 2 }; },
    remove: async () => { removes++; }
  }), async (_actor, _target, stage) => { audits.push(stage); }, () => image);
  const actor = { sessionId: 'session', taskId: 'task', isCurrent: () => actorCurrent };
  const listed = service.list(actor);
  assert.equal(listed.surfaces.length, 1);
  assert.equal('nativeId' in listed.surfaces[0], false);
  const surfaceId = listed.surfaces[0].surfaceId;
  const first = await service.look(actor, surfaceId, 1000);
  assert.equal(first.authorizationCurrent(), true);
  assert.equal(first.semanticStatus, 'unsupported');
  assert.equal(first.surfaceId, surfaceId);
  assert.equal('displayId' in first, false);
  await service.look(actor, surfaceId, 1000);
  assert.equal(approvals, 1); assert.equal(creates, 2);
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  sourceImpl = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const pending = service.look(actor, surfaceId, 1000);
  await started;
  const revoked = authority.revoke('session');
  assert.equal(first.authorizationCurrent(), false, 'capture proof is invalid immediately after revocation');
  finish([{ display_id: '1', thumbnail: image }]);
  await assert.rejects(pending, /changed/);
  await revoked;
  assert.equal(creates, 2, 'revocation during capture never publishes an artifact');
  await assert.rejects(service.look(actor, surfaceId, 1000), /previously declined/);
  let geometryEntered, geometryFinish;
  const geometryStarted = new Promise(resolve => { geometryEntered = resolve; });
  sourceImpl = () => { geometryEntered(); return new Promise(resolve => { geometryFinish = resolve; }); };
  const otherActor = { ...actor, sessionId: 'other-session' };
  const geometryPending = service.look(otherActor, surfaceId, 1000);
  await geometryStarted;
  provider.emit('display-metrics-changed', {}, display, ['bounds']);
  geometryFinish([{ display_id: '1', thumbnail: image }]);
  await assert.rejects(geometryPending, /geometry changed/);
  assert.equal(creates, 2, 'a moved display cannot publish the old capture');
  let sleepEntered, sleepFinish;
  const sleepStarted = new Promise(resolve => { sleepEntered = resolve; });
  sourceImpl = () => { sleepEntered(); return new Promise(resolve => { sleepFinish = resolve; }); };
  const sleepPending = service.look(otherActor, surfaceId, 1000);
  await sleepStarted;
  power.emit('suspend'); power.emit('resume');
  sleepFinish([{ display_id: '1', thumbnail: image }]);
  await assert.rejects(sleepPending, /geometry changed/);
  assert.equal(creates, 2, 'sleep and resume during capture cannot publish the old capture');
  actorCurrent = false;
  assert.throws(() => service.list(actor), /no longer current/);
  assert.equal(removes, 0);
  assert.ok(audits.includes('capture-failed'));

  let visibility = 1, visibleCreates = 0;
  const visibleGuard = new VisibleScreenGuard(() => visibility);
  const visibleService = new DesktopDisplayService(registry, visibleGuard, () => sourceImpl(), () => ({
    create: async () => { visibleCreates++; return { artifactId: 'visible', path: '/private/visible.png', mimeType: 'image/png', width: 10, height: 10, capturedAt: 1, expiresAt: 2 }; },
    remove: async () => {}
  }), async () => {}, () => image);
  const visibleActor = { sessionId: 'visible-worker', taskId: 'visible-task', isCurrent: () => true };
  const visibleSurfaceId = visibleService.list(visibleActor).surfaces[0].surfaceId;
  sourceImpl = async () => [{ display_id: '1', thumbnail: image }];
  const visibleCapture = await visibleService.look(visibleActor, visibleSurfaceId, 1000);
  assert.equal(visibleCapture.authorizationCurrent(), true);
  assert.equal(visibleCreates, 1, 'a visible run captures without the legacy confirmation callback');
  visibility = undefined;
  assert.equal(visibleCapture.authorizationCurrent(), false);
  visibility = 2;
  assert.equal(visibleCapture.authorizationCurrent(), false, 'indicator recreation must not resurrect the earlier capture');
  let enteredVisible, finishVisible;
  const visibleStarted = new Promise(resolve => { enteredVisible = resolve; });
  sourceImpl = () => { enteredVisible(); return new Promise(resolve => { finishVisible = resolve; }); };
  const visiblePending = visibleService.look(visibleActor, visibleSurfaceId, 1000);
  await visibleStarted;
  visibility = undefined;
  finishVisible([{ display_id: '1', thumbnail: image }]);
  await assert.rejects(visiblePending, /changed/, 'hiding the indicator during capture must prevent artifact publication');
  assert.equal(visibleCreates, 1);
  registry.dispose();
  console.log('display service: trusted scope, session consent, identity and in-flight revocation passed');
} finally { removeWorkspaceFixture(temp, 'desktop-display-service-'); }
