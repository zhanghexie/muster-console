import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-display-'));
function fakePng(width, height, suffix = '') {
  const header = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(13, 8); header.write('IHDR', 12); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.from(suffix)]);
}
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { captureDisplay } = await import(pathToFileURL(compile('main/desktop/displayCapture.ts')));
  const target = { taskId: 'task', surfaceId: 'surface', surfaceGeneration: 'generation', geometryRevision: 'geometry', displayId: 12,
    bounds: { x: -1000, y: 0, width: 1000, height: 500 }, scaleFactor: 2 };
  let sourceCalls = 0, confirmed = 0, removed = 0, current = true, rejectAudit = '';
  const events = [], thumbnail = { isEmpty: () => false, getSize: () => ({ width: 1600, height: 800 }), toPNG: () => fakePng(1600, 800) };
  const deps = { normalizePng: () => thumbnail, confirmAllDisplays: async value => { assert.equal(value.displayId, 12); confirmed++; return true; },
    audit: async (_value, stage) => { events.push(stage); if (stage === rejectAudit) throw new Error('audit unavailable'); },
    getSources: async options => { sourceCalls++; assert.deepEqual(options, { types: ['screen'], thumbnailSize: { width: 2000, height: 1000 } });
      return [{ display_id: '99', thumbnail }, { display_id: '12', thumbnail }]; },
    artifacts: { create: async () => ({ artifactId: 'id', path: '/private/id.png', mimeType: 'image/png', width: 1600, height: 800, capturedAt: 1, expiresAt: 2 }),
      remove: async (task, id) => { assert.equal(task, 'task'); assert.equal(id, 'id'); removed++; } } };
  const capture = () => captureDisplay(deps, target, () => current, 1000);
  const result = await capture();
  assert.equal(result.width, 1600); assert.equal(result.height, 800);
  assert.equal(result.captureId, result.artifactId, 'task-scoped artifact lookup can use the returned capture ID');
  assert.equal(result.coordinateSpace, 'capture-pixel-v1');
  assert.deepEqual(result.stability, { status: 'not_requested', samples: 1 });
  assert.deepEqual(result.sourceSize, { width: 1600, height: 800 });
  assert.deepEqual(result.region, { x: 0, y: 0, width: 1600, height: 800 });
  assert.ok(result.limitations.includes('all_display_thumbnails_requested'));
  assert.ok(result.limitations.includes('input_coordinate_mapping_unverified'));
  assert.equal('transform' in result, false, 'unverified OS coordinates cannot be used for input');
  assert.deepEqual(events, ['approved', 'capture-start', 'capture-ready']);
  const denied = { ...deps, confirmAllDisplays: async () => false };
  await assert.rejects(captureDisplay(denied, target, () => true, 1000), /declined/);
  assert.equal(sourceCalls, 1, 'denial never captures');
  rejectAudit = 'capture-start';
  await assert.rejects(capture(), /audit unavailable/); assert.equal(sourceCalls, 1);
  rejectAudit = 'capture-ready';
  await assert.rejects(capture(), /audit unavailable/); assert.equal(removed, 1);
  const cleanupFailure = { ...deps, artifacts: { ...deps.artifacts, remove: async () => { throw new Error('disk error'); } } };
  await assert.rejects(captureDisplay(cleanupFailure, target, () => true, 1000), error =>
    error instanceof AggregateError && /cleanup failed/.test(error.message));
  rejectAudit = '';
  const ambiguous = { ...deps, getSources: async () => [{ display_id: '12', thumbnail }, { display_id: '12', thumbnail }] };
  await assert.rejects(captureDisplay(ambiguous, target, () => true, 1000), /uniquely/);
  const missing = { ...deps, getSources: async () => [{ display_id: '', thumbnail }] };
  await assert.rejects(captureDisplay(missing, target, () => true, 1000), /portal selection/);
  assert.equal(events.at(-1), 'capture-failed');
  const region = { x: 15, y: 25, width: 100, height: 80 };
  const regionImage = { ...thumbnail, crop: value => {
    assert.deepEqual(value, region);
    return { isEmpty: () => false, getSize: () => ({ width: 100, height: 80 }), toPNG: () => Buffer.from('cropped') };
  } };
  const regionDeps = { ...deps, normalizePng: () => regionImage, getSources: async () => [{ display_id: '12', thumbnail: regionImage }],
    artifacts: { ...deps.artifacts, create: async (_task, png) => {
      assert.equal(png.toString(), 'cropped');
      return { artifactId: 'crop', path: '/private/crop.png', mimeType: 'image/png', width: 100, height: 80, capturedAt: 1, expiresAt: 2 };
    } } };
  const cropped = await captureDisplay(regionDeps, target, () => true, 1000, undefined, region);
  assert.deepEqual(cropped.region, region);
  assert.deepEqual(cropped.sourceSize, { width: 1600, height: 800 });
  assert.equal(cropped.width, 100); assert.equal(cropped.height, 80);
  await assert.rejects(captureDisplay(regionDeps, target, () => true, 1000, undefined, { ...region, x: 1590 }), /outside/);
  await assert.rejects(captureDisplay(regionDeps, target, () => true, 1000, undefined, { ...region, x: -1 }), /Invalid capture region/);
  await assert.rejects(captureDisplay(deps, target, () => true, 1000, undefined, region), /unsupported/);
  let cropWrites = 0;
  const wrongCropImage = { ...thumbnail, crop: () => ({ isEmpty: () => false, getSize: () => ({ width: 99, height: 80 }), toPNG: () => Buffer.from('wrong') }) };
  const wrongCrop = { ...regionDeps, normalizePng: () => wrongCropImage, getSources: async () => [{ display_id: '12', thumbnail: wrongCropImage }],
    artifacts: { ...regionDeps.artifacts, create: async () => { cropWrites++; throw new Error('unexpected write'); } } };
  await assert.rejects(captureDisplay(wrongCrop, target, () => true, 1000, undefined, region), /dimensions changed/);
  assert.equal(cropWrites, 0, 'a malformed crop is never published');
  const badNormalizer = { ...deps, normalizePng: () => ({ ...thumbnail, getSize: () => ({ width: 800, height: 400 }) }) };
  await assert.rejects(captureDisplay(badNormalizer, target, () => true, 1000), /normalization does not match/);
  let normalizations = 0;
  const oversizedPng = { ...deps, normalizePng: () => { normalizations++; return thumbnail; },
    getSources: async () => [{ display_id: '12', thumbnail: { ...thumbnail, toPNG: () => fakePng(8193, 8193) } }] };
  await assert.rejects(captureDisplay(oversizedPng, target, () => true, 1000), /invalid image dimensions/);
  assert.equal(normalizations, 0, 'oversized images are rejected before decoding');
  let sampleCalls = 0;
  const stableDeps = { ...deps, getSources: async () => { sampleCalls++; return [{ display_id: '12', thumbnail }]; } };
  const stable = await captureDisplay(stableDeps, target, () => true, 1000, undefined, undefined, { intervalMs: 20, timeoutMs: 1000 });
  assert.deepEqual(stable.stability, { status: 'observed_stable', samples: 2 });
  assert.equal(sampleCalls, 2, 'only two identical samples are needed');
  let changingCalls = 0;
  const changing = { ...deps, normalizePng: png => ({ ...thumbnail, toPNG: () => png }), getSources: async () => {
    const value = ++changingCalls;
    return [{ display_id: '12', thumbnail: { ...thumbnail, toPNG: () => fakePng(1600, 800, String(value)) } }];
  } };
  const timedOut = await captureDisplay(changing, target, () => true, 1000, undefined, undefined, { intervalMs: 20, timeoutMs: 75 });
  assert.equal(timedOut.stability.status, 'timeout');
  assert.ok(timedOut.stability.samples >= 2);
  let staleSample = 0, staleWrites = 0;
  const changingGeometry = { ...deps, getSources: async () => { if (++staleSample === 2) current = false; return [{ display_id: '12', thumbnail }]; },
    artifacts: { ...deps.artifacts, create: async () => { staleWrites++; throw new Error('unexpected write'); } } };
  await assert.rejects(captureDisplay(changingGeometry, target, () => current, 1000, undefined, undefined, { intervalMs: 20, timeoutMs: 1000 }), /geometry changed/);
  current = true;
  assert.equal(staleWrites, 0, 'a stale sample cannot publish an artifact');
  await assert.rejects(captureDisplay(deps, target, () => true, 1000, undefined, undefined, { intervalMs: 0, timeoutMs: 100 }), /Invalid capture stability/);
  const samplingAbort = new AbortController();
  const sampling = captureDisplay(stableDeps, target, () => true, 1000, samplingAbort.signal, undefined, { intervalMs: 100, timeoutMs: 1000 });
  setTimeout(() => samplingAbort.abort(), 10);
  await assert.rejects(sampling, /abort/i);
  const missingAudit = { ...missing, audit: async (_value, stage) => { if (stage === 'capture-failed') throw new Error('audit offline'); } };
  await assert.rejects(captureDisplay(missingAudit, target, () => true, 1000), error =>
    error instanceof AggregateError && /audit/.test(error.message) && error.errors.length === 2);
  const empty = { ...deps, getSources: async () => [{ display_id: '12', thumbnail: { ...thumbnail, isEmpty: () => true } }] };
  await assert.rejects(captureDisplay(empty, target, () => true, 1000), /empty image/);
  const changed = { ...deps, getSources: async () => { current = false; return [{ display_id: '12', thumbnail }]; } };
  await assert.rejects(captureDisplay(changed, target, () => current, 1000), /geometry changed/); current = true;
  const controller = new AbortController();
  const cancelled = { ...deps, artifacts: { ...deps.artifacts, create: async () => {
    const value = await deps.artifacts.create(); controller.abort(); return value;
  } } };
  await assert.rejects(captureDisplay(cancelled, target, () => true, 1000, controller.signal), /abort/i);
  assert.equal(removed, 2, 'cancelled unpublished artifact is retracted');
  await assert.rejects(captureDisplay(deps, { ...target, displayId: -1 }, () => true, 1000), /Invalid/);
  assert.ok(confirmed >= 2);
  console.log('display capture: full-scope consent, source binding, audit, stale geometry and cancellation passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
