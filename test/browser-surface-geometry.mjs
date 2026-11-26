import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-surface-geometry-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { browserSurfaceVisibility } = await import(pathToFileURL(compile('renderer/src/browserSurfaceGeometry.ts')));
  const surface = { x: -20.2, y: 10.4, width: 200, height: 100 }, viewport = { x: 0, y: 0, width: 500, height: 500 };
  assert.deepEqual(browserSurfaceVisibility(surface, viewport, [{ kind: 'rect', rect: { x: 10.1, y: 20.7, width: 100, height: 40 } }]),
    { kind: 'visible', inset: { top: 11, right: 70, bottom: 50, left: 31 } });
  assert.deepEqual(browserSurfaceVisibility(surface, viewport, [{ kind: 'rect', rect: { x: 300, y: 0, width: 20, height: 20 } }]), { kind: 'hidden' });
  assert.deepEqual(browserSurfaceVisibility(surface, viewport, [{ kind: 'unsupported' }]), { kind: 'unsupported' });
  assert.throws(() => browserSurfaceVisibility({ ...surface, width: -1 }, viewport, []), /Invalid/);
  assert.throws(() => browserSurfaceVisibility({ ...surface, x: 1e308, width: 1e308 }, viewport, []), /Invalid/);
  assert.throws(() => browserSurfaceVisibility(surface, viewport, [{ kind: 'rect', rect: { ...viewport, x: NaN } }]), /Invalid/);
  assert.deepEqual(browserSurfaceVisibility({ x: 0.1, y: 0, width: 0.8, height: 10 }, { x: 0.2, y: 0, width: 0.2, height: 10 }, []), { kind: 'hidden' });
  console.log('browser surface geometry: intersection, conservative rounding and unsupported clips passed');
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('browser-surface-geometry-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
