import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

if (process.argv[2] === '--child') {
  const { DesktopTaskLock } = await import(process.argv[3]);
  const release = await new DesktopTaskLock(process.argv[4]).acquire('shared-task');
  process.send?.('locked');
  process.on('message', async message => {
    if (message !== 'release') return;
    await release(); process.send?.('released');
    process.disconnect();
  });
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-lock-'));
  let child;
  try {
    const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
    const moduleUrl = pathToFileURL(compile('main/desktop/taskLock.ts')).href;
    const { DesktopTaskLock, DesktopTaskLockCleanupError, DesktopTaskLockContendedError, DesktopTaskLockReleaseError } = await import(moduleUrl);
    const dir = path.join(temp, 'locks'), lock = new DesktopTaskLock(dir);
    assert.deepEqual(await lock.inspect('shared-task'), { state: 'unlocked' });
    const spawn = () => fork(new URL(import.meta.url), ['--child', moduleUrl, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const waitMessage = (proc, expected) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 5000);
      proc.once('error', reject);
      proc.on('message', function onMessage(value) {
        if (value !== expected) return;
        clearTimeout(timer); proc.off('message', onMessage); resolve();
      });
    });
    child = spawn(); await waitMessage(child, 'locked');
    assert.equal((await lock.inspect('shared-task')).state, 'locked');
    await assert.rejects(lock.acquire('shared-task'), error => {
      assert.ok(error instanceof DesktopTaskLockContendedError);
      assert.match(error.message, /locked by another/); return true;
    });
    assert.equal(await lock.run('different-task', async () => 'independent'), 'independent');
    const released = waitMessage(child, 'released'); child.send('release'); await released;
    const again = await lock.acquire('shared-task'); await again(); await again();
    child = spawn(); await waitMessage(child, 'locked');
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    await assert.rejects(lock.acquire('shared-task'), /locked by another/, 'crash is not treated as consent to recover');
    assert.equal((await lock.inspect('shared-task')).state, 'locked');
    const tampered = await lock.acquire('tampered-task');
    const tamperedFile = path.join(dir, `${createHash('sha256').update('tampered-task').digest('hex')}.lock`);
    fs.writeFileSync(tamperedFile, '{}');
    assert.equal((await lock.inspect('tampered-task')).state, 'invalid');
    await assert.rejects(tampered(), /ownership changed/);
    assert.equal(fs.existsSync(tamperedFile), true, 'unknown lock is never removed automatically');
    for (const operationFails of [false, true]) {
      const id = `failed-release-${operationFails}`;
      const file = path.join(dir, `${createHash('sha256').update(id).digest('hex')}.lock`);
      await assert.rejects(lock.run(id, async () => {
        fs.writeFileSync(file, '{}');
        if (operationFails) throw new Error('simulated pre-dispatch failure');
        return 'operation finished';
      }), error => {
        assert.ok(error instanceof DesktopTaskLockReleaseError);
        assert.equal(error.errors.length, operationFails ? 2 : 1);
        return true;
      });
      assert.equal(fs.existsSync(file), true, 'a failed release leaves the lock for inspection');
    }
    // Exercise failure after exclusive file creation. Only incomplete cleanup
    // is a recovery condition; an ordinary contention or cleaned failure is not.
    const originalOpen = fsp.open, originalUnlink = fsp.unlink;
    const failureFile = path.join(dir, `${createHash('sha256').update('failed-create').digest('hex')}.lock`);
    let failUnlink = false;
    try {
      fsp.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] !== failureFile) return handle;
        return new Proxy(handle, { get(target, key) {
          if (key === 'writeFile') return async () => { throw new Error('simulated lock write failure'); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      fsp.unlink = async file => {
        if (file === failureFile && failUnlink) throw new Error('simulated lock cleanup failure');
        return originalUnlink(file);
      };
      await assert.rejects(lock.acquire('failed-create'), error => {
        assert.match(error.message, /simulated lock write failure/);
        assert.equal(error instanceof DesktopTaskLockCleanupError, false); return true;
      });
      assert.equal(fs.existsSync(failureFile), false, 'a fully cleaned lock failure leaves no lock');
      failUnlink = true;
      await assert.rejects(lock.acquire('failed-create'), error => {
        assert.ok(error instanceof DesktopTaskLockCleanupError);
        assert.match(error.errors[0].message, /simulated lock write failure/);
        assert.match(error.errors[1].message, /simulated lock cleanup failure/); return true;
      });
      assert.equal(fs.existsSync(failureFile), true, 'failed cleanup preserves the unresolved lock for recovery');
    } finally { fsp.open = originalOpen; fsp.unlink = originalUnlink; }
    console.log('desktop task lock: cross-process exclusion, release and crash fail-closed passed');
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
