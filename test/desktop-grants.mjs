import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-grants-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopGrantStore } = await import(pathToFileURL(compile('main/desktop/grants.ts')));
  let now = 100;
  const store = new DesktopGrantStore(() => now);
  const target = { appId: 'app', processInstance: 'process-1', surfaceId: 'window', surfaceGeneration: '1' };
  const scope = { taskId: 'task', appId: 'app', processInstance: 'process-1',
    surfaces: [{ surfaceId: 'window', generation: '1' }], actions: ['click', 'type'],
    expiresAt: 200, foreground: false, irreversibleObjects: ['send-to-A'] };
  const id = store.issue(scope);
  const request = { taskId: 'task', target, action: 'click', foreground: false, effect: { kind: 'reversible' } };
  assert.deepEqual(store.check(id, request), { allowed: true });
  scope.actions.push('delete'); scope.surfaces[0].generation = '2'; scope.irreversibleObjects.push('send-to-B');
  assert.equal(store.check(id, { ...request, action: 'delete' }).reason, 'out_of_scope');
  assert.equal(store.check(id, { ...request, target: { ...target, surfaceGeneration: '2' } }).reason, 'out_of_scope');
  assert.equal(store.check(id, { ...request, effect: { kind: 'irreversible', objectFingerprint: 'send-to-B' } }).reason, 'object_confirmation_required');
  assert.equal(store.check(id, { ...request, effect: { kind: 'irreversible', objectFingerprint: 'send-to-A' } }).allowed, true);
  assert.equal(store.check(id, { ...request, effect: { kind: 'irreversible', objectFingerprint: '' } }).reason, 'object_confirmation_required');
  assert.equal(store.check(id, { ...request, effect: undefined }).reason, 'out_of_scope');
  for (const changed of [
    { taskId: 'other' }, { foreground: true }, { action: 'scroll' },
    { target: { ...target, appId: 'other' } }, { target: { ...target, processInstance: 'process-2' } },
    { target: { ...target, surfaceId: 'other' } }
  ]) assert.equal(store.check(id, { ...request, ...changed }).reason, 'out_of_scope');
  now = 200;
  assert.equal(store.check(id, request).reason, 'expired');
  now = 100;
  store.revokeTask('task');
  assert.equal(store.check(id, request).reason, 'revoked');
  assert.equal(store.check('unknown', request).reason, 'missing');
  assert.throws(() => store.issue({ ...scope, expiresAt: 100 }), /Invalid/);
  assert.throws(() => store.issue({ ...scope, expiresAt: now + 24 * 60 * 60 * 1000 + 1 }), /Invalid/);
  assert.ok(store.issue({ ...scope, expiresAt: now + 24 * 60 * 60 * 1000 }));
  console.log('desktop grants: scope, exact object, expiry and revocation passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
