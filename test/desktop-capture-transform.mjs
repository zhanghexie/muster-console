import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-transform-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { capturePointToInput } = await import(pathToFileURL(compile('main/desktop/captureTransform.ts')));
  const capture = { captureId: 'capture', surfaceId: 'window', surfaceGeneration: 'generation', geometryRevision: 'geometry', expiresAt: Date.now() + 10000,
    width: 800, height: 600, coordinateSpace: 'capture-pixel-v1', targetSpace: 'platform-input-v1',
    transform: { originX: -1200, originY: 100, scaleX: 1.5, scaleY: 2 } };
  const current = { surfaceId: 'window', surfaceGeneration: 'generation', geometryRevision: 'geometry' };
  assert.deepEqual(capturePointToInput(capture, current, { x: 200, y: 50 }), { x: -900, y: 200, coordinateSpace: 'platform-input-v1' });
  for (const next of [{ ...current, surfaceId: 'other' }, { ...current, surfaceGeneration: 'new' }, { ...current, geometryRevision: 'moved' }]) {
    assert.throws(() => capturePointToInput(capture, next, { x: 0, y: 0 }), /Stale/);
  }
  assert.throws(() => capturePointToInput(capture, current, { x: 0, y: 0 }, capture.expiresAt), /Stale/);
  for (const point of [{ x: -1, y: 0 }, { x: 800, y: 0 }, { x: 0, y: 600 }, { x: NaN, y: 1 }]) {
    assert.throws(() => capturePointToInput(capture, current, point), /Invalid/);
  }
  for (const transform of [{ ...capture.transform, scaleX: 0 }, { ...capture.transform, scaleY: Infinity }]) {
    assert.throws(() => capturePointToInput({ ...capture, transform }, current, { x: 0, y: 0 }), /Invalid/);
  }
  console.log('desktop capture transform: stale geometry, scaled crop and negative origin passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
