import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-visible-read-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { VisibleScreenGuard } = await import(pathToFileURL(compile('main/desktop/visibleScreenGuard.ts')));
  let visibleEpoch;
  const guard = new VisibleScreenGuard(() => visibleEpoch);
  const target = { taskId: 'task', surfaceId: 'display', surfaceGeneration: 'g', geometryRevision: 'r', displayId: 1,
    bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1 };
  await assert.rejects(guard.authorize('worker', target, () => true), /not visible/);
  visibleEpoch = 1;
  const first = await guard.authorize('worker', target, () => true);
  assert.equal(guard.isAuthorized('worker', 'task', first), true);
  assert.equal(await guard.authorize('worker', target, () => true), first);
  visibleEpoch = undefined;
  assert.equal(guard.isAuthorized('worker', 'task', first), false);
  visibleEpoch = 2;
  assert.equal(guard.isAuthorized('worker', 'task', first), false, 'a recreated indicator must not revive old captures');
  const second = await guard.authorize('worker', target, () => true);
  assert.notEqual(first, second);
  const newTask = await guard.authorize('worker', { ...target, taskId: 'new-task' }, () => true);
  assert.equal(guard.isAuthorized('worker', 'task', second), false);
  assert.equal(guard.isAuthorized('worker', 'new-task', newTask), true);
  guard.end('worker');
  assert.equal(guard.isAuthorized('worker', 'new-task', newTask), false);
  await assert.rejects(guard.authorize('worker', target, () => false), /not visible/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(guard.authorize('worker', target, () => true, cancelled.signal), /abort/i);
  const invalid = new VisibleScreenGuard(() => { throw new Error('indicator crashed'); });
  await assert.rejects(invalid.authorize('worker', target, () => true), /not visible/);
  console.log('visible screen guard: no dialog, indicator lifetime and stale capture proof passed');
} finally { removeWorkspaceFixture(temp, 'desktop-visible-read-'); }
