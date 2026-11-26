import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { EventEmitter } from 'node:events';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-capture-cleanup-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { sweepSessionCaptures, startCaptureCleanup, stopCaptureCleanupOnQuit } = await import(pathToFileURL(compile('main/desktop/captureCleanup.ts')));
  const { prepareSessionCaptureDirectory } = await import(pathToFileURL(compile('main/desktop/sessionCaptureAccess.ts')));
  const userData = path.join(temp, 'data'); fs.mkdirSync(userData);
  const decode = async () => ({ width: 1, height: 1 });
  assert.deepEqual(await sweepSessionCaptures(userData, decode, () => 100), { removed: 0, errors: [] });
  const dir = prepareSessionCaptureDirectory(userData, 'one');
  const id = '00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ version: 1, id, taskHash: 'a'.repeat(64), sha256: 'b'.repeat(64), capturedAt: 1, expiresAt: 10, width: 1, height: 1 }));
  fs.writeFileSync(path.join(dir, `${id}.png`), 'old');
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep');
  const bad = '00000000-0000-4000-8000-000000000002';
  fs.writeFileSync(path.join(dir, `${bad}.json`), '{');
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(userData, 'desktop-captures', 'f'.repeat(64)), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await sweepSessionCaptures(userData, decode, () => 100);
  assert.equal(result.removed, 1); assert.equal(result.errors.length, 2);
  assert.equal(fs.existsSync(path.join(dir, `${id}.png`)), false);
  assert.equal(fs.readFileSync(path.join(dir, 'unrelated.txt'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(outside), []);
  const errors = []; let calls = 0, signal;
  const second = new Promise(resolve => { signal = resolve; });
  const janitor = startCaptureCleanup(async () => {
    calls++;
    if (calls === 2) signal();
    return { removed: 0, errors: calls === 1 ? ['problem'] : [] };
  }, error => errors.push(error), 5);
  await janitor.ready;
  await Promise.race([second, new Promise((_, reject) => setTimeout(() => reject(new Error('periodic cleanup did not run')), 1000))]);
  await janitor.stop();
  assert.deepEqual(errors, ['problem']); assert.equal(calls, 2);
  const app = new EventEmitter(); let stopped = 0;
  stopCaptureCleanupOnQuit(app, { stop: async () => { stopped++; } }, error => { throw error; });
  app.emit('before-quit', { defaultPrevented: true }); assert.equal(stopped, 0);
  app.emit('before-quit', { defaultPrevented: false }); assert.equal(stopped, 1);
  app.emit('before-quit', { defaultPrevented: false }); assert.equal(stopped, 1);
  assert.throws(() => startCaptureCleanup(async () => ({ removed: 0, errors: [] }), () => {}, 0), /configuration/);
  console.log('desktop capture cleanup: startup, periodic sweep, expiry and errors passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
