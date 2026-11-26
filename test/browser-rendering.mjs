/** Deterministic native-webview rendering regression.
 * The fixture stubs Electron's debugger and renderer WebCodecs bridge; no
 * external browser, Playwright process, or Python is involved. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-rendering-'));
const compile = createSharedCompiler(root, tmp);
const { BrowserRecordingService } = await import(pathToFileURL(compile('main/browser/browserRecording.ts')));

const commands = [];
const debug = {
  isAttached: () => true,
  async sendCommand(method, params) {
    commands.push({ method, params });
    if (method === 'Runtime.evaluate') return { result: { value: { ok: true } } };
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('frame').toString('base64') };
    return {};
  }
};
const wc = { debugger: debug, isDestroyed: () => false };
const host = { webContents: { isDestroyed: () => false, executeJavaScript: async script => {
  assert.match(script, /VideoEncoder/);
  return { ok: true, chunks: [0, 100, 250].map(ts => ({ data: Buffer.from([1, 2, 3]).toString('base64'), ts, key: true })) };
} } };
const throttles = [];
const service = new BrowserRecordingService(() => wc, () => host, path.join(tmp, 'captures'),
  (tabId, busy) => throttles.push({ tabId, busy }));

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const started = await service.startRender('tab-a', { times: [0, 100, 250], width: 64, height: 48 });
assert.equal(started.totalFrames, 3);
await waitFor(() => service.renderJob(started.id)?.status === 'completed', 'render completion');
const completed = service.renderJob(started.id);
assert.equal(completed.status, 'completed');
assert.deepEqual(completed.artifact, {
  path: completed.artifact.path,
  mimeType: 'video/webm',
  width: 64,
  height: 48,
  durationMs: 250,
  frameCount: 3
});
assert.ok(fs.existsSync(completed.artifact.path));
assert.equal(commands.filter(command => command.method === 'Runtime.evaluate').length, 3);
assert.equal(commands.filter(command => command.method === 'Page.captureScreenshot').length, 3);
assert.ok(commands.some(command => command.method === 'Runtime.evaluate' && command.params.expression.includes('fn(0)')));
assert.ok(commands.some(command => command.method === 'Runtime.evaluate' && command.params.expression.includes('fn(0.1)')));
assert.deepEqual(throttles, [{ tabId: 'tab-a', busy: true }, { tabId: 'tab-a', busy: false }]);

let missing = true;
const failingDebug = {
  isAttached: () => true,
  async sendCommand(method, params) {
    if (method === 'Runtime.evaluate') {
      if (params.expression.trim().startsWith('typeof (globalThis')) return { result: { value: !missing } };
      return { result: { value: missing ? { ok: false, error: 'window.renderAt(t) is not defined' } : { ok: true } } };
    }
    return { data: Buffer.from('frame').toString('base64') };
  }
};
const failingWc = { debugger: failingDebug, isDestroyed: () => false };
const failing = new BrowserRecordingService(() => failingWc, () => host, path.join(tmp, 'fail'));
const failedStart = await failing.startRender('tab-b', { times: [0], width: 64, height: 48 });
await waitFor(() => failing.renderJob(failedStart.id)?.status === 'failed', 'render failure');
assert.match(failing.renderJob(failedStart.id).error, /renderAt/);
assert.equal(failing.renderJob(failedStart.id).failure.frameIndex, 0);
assert.equal(failing.renderJob(failedStart.id).failure.stage, 'rendering');
missing = false;
const validation = await failing.validateRender('tab-b', undefined, { times: [100] });
assert.deepEqual(validation.frames, [{ timeMs: 100, consistent: true, bytes: 5 }]);

let release;
const blocked = new Promise(resolve => { release = resolve; });
const cancelDebug = {
  isAttached: () => true,
  async sendCommand(method, params) {
    if (method === 'Runtime.evaluate') {
      if (params.expression.trim().startsWith('typeof (globalThis')) return { result: { value: true } };
      await blocked;
      return { result: { value: { ok: true } } };
    }
    return { data: Buffer.from('frame').toString('base64') };
  }
};
const cancelWc = { debugger: cancelDebug, isDestroyed: () => false };
const cancellable = new BrowserRecordingService(() => cancelWc, () => host, path.join(tmp, 'cancel'));
const cancelStart = await cancellable.startRender('tab-c', { times: [0, 100], width: 64, height: 48 });
await waitFor(() => cancellable.renderJob(cancelStart.id)?.status === 'rendering', 'render cancellation start');
assert.equal(cancellable.cancelRender(cancelStart.id), true);
release();
await waitFor(() => cancellable.renderJob(cancelStart.id)?.status === 'cancelled', 'render cancellation');
assert.equal(cancellable.renderJob(cancelStart.id).artifact, undefined);

console.log('browser-rendering: all assertions passed');
