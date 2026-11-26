import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-surfaces-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopSurfaceRegistry } = await import(pathToFileURL(compile('main/desktop/surfaces.ts')));
  const registry = new DesktopSurfaceRegistry();
  const surface = { backend: 'adapter', nativeId: '1', appId: 'app', processInstance: 'pid+start', windowInstance: 'window-start', title: 'first',
    bounds: { x: -100, y: 20, width: 640, height: 480 }, dpiScale: 1.5 };
  registry.replace('adapter', [surface]);
  const first = registry.list()[0];
  registry.replace('adapter', [{ ...surface, title: 'changed' }]);
  assert.deepEqual(registry.list()[0], { ...first, title: 'changed' });
  const leaked = registry.list()[0]; leaked.bounds.x = 1000;
  assert.equal(registry.get(first.surfaceId).bounds.x, -100);
  registry.replace('adapter', [{ ...surface, bounds: { ...surface.bounds, x: 1 } }]);
  const moved = registry.list()[0];
  assert.equal(moved.surfaceId, first.surfaceId);
  assert.equal(moved.surfaceGeneration, first.surfaceGeneration);
  assert.notEqual(moved.geometryRevision, first.geometryRevision);
  assert.throws(() => registry.replace('adapter', [surface, surface]), /duplicate/);
  assert.deepEqual(registry.list(), [moved]);
  registry.replace('adapter', [{ ...surface, processInstance: 'new-process' }]);
  const reused = registry.list()[0];
  assert.notEqual(reused.surfaceId, first.surfaceId);
  assert.notEqual(reused.surfaceGeneration, first.surfaceGeneration);
  assert.equal(registry.get(first.surfaceId), undefined);
  registry.replace('adapter', [{ ...surface, windowInstance: 'new-window' }]);
  assert.notEqual(registry.list()[0].surfaceId, reused.surfaceId);
  registry.replace('other', [{ ...surface, backend: 'other' }]);
  registry.replace('adapter', []);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].backend, 'other');
  registry.replace('other', []);

  registry.replace('adapter', [surface]);
  assert.notEqual(registry.list()[0].surfaceId, first.surfaceId);
  for (const invalid of [{ ...surface, appId: '' }, { ...surface, windowInstance: '' }, { ...surface, dpiScale: 0 }, { ...surface, nativeId: 123 },
    { ...surface, bounds: { ...surface.bounds, x: NaN } }, { ...surface, backend: 'other' }]) {
    assert.throws(() => registry.replace('adapter', [invalid]), /Invalid/);
  }
  console.log('desktop surface registry: identity reuse, geometry revisions and atomic enumeration passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
