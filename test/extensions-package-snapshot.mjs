import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-snapshot-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { captureExtensionPackage, captureExtensionPackageAsync, fingerprintExtensionSnapshot, fingerprintExtensionSnapshotAsync, extensionSafetyEvidence, saveExtensionPackageSnapshot, writeExtensionPackageDirectory } = await import(pathToFileURL(compile('main/extensions/extensionPackageSnapshot.ts')));
  const { ExtensionAtomicRenameError } = await import(pathToFileURL(compile('main/extensions/extensionAtomicRename.ts')));
  const dir = path.join(temp, 'source');
  fs.mkdirSync(path.join(dir, 'assets', 'empty'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ id: 'demo', name: 'Demo', scope: 'global' }));
  fs.writeFileSync(path.join(dir, 'background.mjs'), 'throw new Error("capture must not execute code")');
  fs.writeFileSync(path.join(dir, 'assets', 'image.bin'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(dir, 'data', 'old.txt'), 'preserve private data');
  const first = captureExtensionPackage(dir);
  assert.deepEqual(await captureExtensionPackageAsync(dir), first, 'async capture preserves the full review fingerprint and bytes');
  assert.match(first.fingerprint, /^package-extension:[a-f0-9]{64}$/);
  assert.deepEqual(first.excluded, ['data']);
  assert.ok(first.directories.includes('assets/empty'));
  assert.equal(first.files.some(file => file.path.startsWith('data/')), false);
  assert.equal(fingerprintExtensionSnapshot(first), first.fingerprint);
  assert.equal(await fingerprintExtensionSnapshotAsync(first), first.fingerprint);
  const large = { directories: ['nested'], files: [{ path: 'nested/large.bin', bytes: Buffer.alloc(16 * 1024 * 1024, 42), executable: false }] };
  let yielded = false;
  const hashing = fingerprintExtensionSnapshotAsync(large);
  setImmediate(() => { yielded = true; });
  assert.equal(await hashing, fingerprintExtensionSnapshot(large), 'chunked hashing preserves the exact fingerprint');
  assert.equal(yielded, true, 'large package hashing yields to other event-loop work');
  const evidence = JSON.parse(extensionSafetyEvidence(first));
  assert.equal(evidence.fingerprint, first.fingerprint);
  assert.equal(evidence.files.find(file => file.path === 'assets/image.bin').content, 'base64:AAEC');

  const boundary = { directories: [], files: [{ path: 'asset.bin', bytes: Buffer.alloc(50 * 1024 * 1024), executable: false }] };
  assert.ok(extensionSafetyEvidence({ ...boundary, fingerprint: fingerprintExtensionSnapshot(boundary), excluded: [] }).includes('base64:'));
  boundary.files.push({ path: 'extra.bin', bytes: Buffer.alloc(1), executable: false });
  assert.throws(() => extensionSafetyEvidence({ ...boundary, fingerprint: fingerprintExtensionSnapshot(boundary), excluded: [] }), /50 MiB/);

  const store = path.join(temp, 'packages');
  const saved = await saveExtensionPackageSnapshot(store, 'demo', first);
  assert.equal(captureExtensionPackage(saved).fingerprint, first.fingerprint);
  assert.equal(fs.existsSync(path.join(saved, 'data')), false);
  assert.equal(await saveExtensionPackageSnapshot(store, 'demo', first), saved);
  for (const [platform, number] of [['win32', 32], ['darwin', 16], ['linux', 16]]) {
    const delays = []; let attempts = 0;
    const result = await saveExtensionPackageSnapshot(path.join(temp, `retry-${platform}`), 'demo', first, {
      rename(from, to) { if (++attempts === 1) throw new ExtensionAtomicRenameError(platform, number, 'temporary lock'); fs.renameSync(from, to); },
      wait: async ms => { delays.push(ms); }
    });
    assert.equal(captureExtensionPackage(result).fingerprint, first.fingerprint);
    assert.equal(attempts, 2); assert.deepEqual(delays, [25]);
  }
  const concurrentStore = path.join(temp, 'concurrent');
  const concurrent = await saveExtensionPackageSnapshot(concurrentStore, 'demo', first, {
    rename(_from, to) { writeExtensionPackageDirectory(to, first); throw new ExtensionAtomicRenameError('win32', 183, 'destination exists'); }
  });
  assert.equal(captureExtensionPackage(concurrent).fingerprint, first.fingerprint, 'a winning concurrent snapshot is verified rather than overwritten');
  assert.equal(fs.readdirSync(path.dirname(concurrent)).some(name => name.startsWith('.stage-')), false);
  let failedAttempts = 0;
  await assert.rejects(saveExtensionPackageSnapshot(path.join(temp, 'permanent'), 'demo', first, {
    rename() { failedAttempts++; throw new ExtensionAtomicRenameError('linux', 22, 'unsupported'); }, wait: async () => { throw Error('must not retry'); }
  }), /unsupported/);
  assert.equal(failedAttempts, 1, 'permanent failures surface without pretending success');
  const waits = []; let lockedAttempts = 0;
  await assert.rejects(saveExtensionPackageSnapshot(path.join(temp, 'locked'), 'demo', first, {
    rename() { lockedAttempts++; throw new ExtensionAtomicRenameError('win32', 5, 'still locked'); }, wait: async ms => { waits.push(ms); }
  }), /still locked/);
  assert.equal(lockedAttempts, 4); assert.deepEqual(waits, [25, 75, 150], 'persistent locks fail after a bounded number of attempts');
  fs.writeFileSync(path.join(dir, 'data', 'old.txt'), 'private data changed');
  assert.equal(captureExtensionPackage(dir).fingerprint, first.fingerprint);
  fs.writeFileSync(path.join(dir, 'background.mjs'), 'export const changed = true;');
  assert.notEqual(captureExtensionPackage(dir).fingerprint, first.fingerprint);

  const altered = { ...first, files: first.files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) })) };
  altered.files[0].bytes[0] ^= 1;
  await assert.rejects(saveExtensionPackageSnapshot(store, 'demo', altered), /modified/);
  assert.throws(() => fingerprintExtensionSnapshot({ directories: [], files: [{ path: '../escape', bytes: Buffer.from('x'), executable: false }] }), /Invalid extension package path/);
  assert.throws(() => fingerprintExtensionSnapshot({ directories: ['A'], files: [{ path: 'a', bytes: Buffer.from('x'), executable: false }] }), /Duplicate extension package path/);
  await assert.rejects(saveExtensionPackageSnapshot(store, '../escape', first), /identity/);
  fs.writeFileSync(path.join(saved, 'background.mjs'), 'tampered');
  assert.equal(await saveExtensionPackageSnapshot(store, 'demo', first), saved);
  assert.equal(captureExtensionPackage(saved).fingerprint, first.fingerprint, 'the exact approved snapshot is rebuilt');
  const preserved = fs.readdirSync(path.dirname(saved)).find(name => name.startsWith('.corrupt-'));
  assert.ok(preserved, 'corrupt snapshot bytes must be preserved');
  assert.equal(fs.readFileSync(path.join(path.dirname(saved), preserved, 'background.mjs'), 'utf8'), 'tampered');

  const linked = path.join(dir, 'linked');
  try {
    fs.symlinkSync(path.join(dir, 'assets'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => captureExtensionPackage(dir), /symbolic link/);
    await assert.rejects(captureExtensionPackageAsync(dir), /symbolic link/);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    console.log('symlink test skipped: creating links is unavailable');
  }
  console.log('extensions-package-snapshot: ok');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
