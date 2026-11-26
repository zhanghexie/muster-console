import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-rename-'));
try {
  const compiled = path.join(temp, 'compiled');
  const compile = createSharedCompiler(repo, compiled);
  const shim = path.join(compiled, 'node_modules', 'koffi'); fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ name: 'koffi', main: 'index.cjs' }));
  fs.writeFileSync(path.join(shim, 'index.cjs'), `module.exports = require(${JSON.stringify(createRequire(import.meta.url).resolve('koffi'))});\n`);
  const { createExtensionAtomicRenamer, ExtensionAtomicRenameError } = await import(pathToFileURL(compile('main/extensions/extensionAtomicRename.ts')));
  const mock = (platform, fail = false, windowsError = 183) => {
    const calls = [];
    const ffi = { load(name) { calls.push(['load', name]); return { func(...declaration) {
      calls.push(['func', ...declaration]);
      if (declaration.includes('GetLastError')) return () => windowsError;
      return (...args) => { calls.push(['move', ...args]); return platform === 'win32' ? (fail ? 0 : 1) : (fail ? -1 : 0); };
    } }; }, errno: () => 95 };
    return { calls, ffi };
  };
  for (const platform of ['win32', 'darwin', 'linux']) {
    const { calls, ffi } = mock(platform);
    const rename = createExtensionAtomicRenamer(platform, ffi);
    if (platform === 'win32') rename('C:\\项目\\source', 'C:\\项目\\target'); else rename('/project/source', '/project/target');
    const invoked = calls.find(call => call[0] === 'move');
    if (platform === 'win32') assert.deepEqual(invoked.slice(1), ['\\\\?\\C:\\项目\\source', '\\\\?\\C:\\项目\\target']);
    if (platform === 'darwin') assert.deepEqual(invoked.slice(1), ['/project/source', '/project/target', 4]);
    if (platform === 'linux') assert.deepEqual(invoked.slice(1), [-100, '/project/source', -100, '/project/target', 1]);
    assert.throws(() => platform === 'win32' ? rename('C:\\a\\x', 'C:\\b\\y') : rename('/a/x', '/b/y'), /same parent/);
    const privateRename = createExtensionAtomicRenamer(platform, ffi, 'x64', true);
    const root = platform === 'win32' ? 'C:\\project' : '/project';
    const p = platform === 'win32' ? path.win32 : path.posix;
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    privateRename(p.join(root, `.extension-previous-${id}`, 'data'), p.join(root, `.extension-stage-${id}`, 'data'));
    assert.throws(() => privateRename(p.join(root, `.extension-previous-${id}`, 'user.txt'), p.join(root, `.extension-stage-${id}`, 'user.txt')), /same parent/);
    assert.throws(() => privateRename(p.join(root, `.extension-previous-${id}`, 'data'), p.join(root, `.extension-stage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, 'data')), /same parent/);
    const failure = mock(platform, true);
    assert.throws(() => platform === 'win32' ? createExtensionAtomicRenamer(platform, failure.ffi)('C:\\a\\x', 'C:\\a\\y') : createExtensionAtomicRenamer(platform, failure.ffi)('/a/x', '/a/y'), error => error instanceof ExtensionAtomicRenameError && error.errorNumber === (platform === 'win32' ? 183 : 95));
  }
  for (const number of [5, 32, 33, 80, 183]) {
    const { ffi } = mock('win32', true, number);
    ffi.errno = () => { throw new Error('POSIX errno is not the Win32 last error'); };
    assert.throws(() => createExtensionAtomicRenamer('win32', ffi)('C:\\project\\source', 'C:\\project\\target'), error => error instanceof ExtensionAtomicRenameError && error.errorNumber === number);
  }
  assert.throws(() => createExtensionAtomicRenamer('linux', { load() { throw new Error('unavailable'); }, errno: () => 0 }), /unavailable/);
  for (const [architecture, number] of [['x64', 316], ['arm64', 276], ['arm', 382], ['ia32', 353], ['ppc64', 357], ['s390x', 347], ['riscv64', 276]]) {
    let received;
    const noWrapper = { load(name) { assert.equal(name, null); return { func(declaration) { if (declaration.includes('renameat2')) throw new Error('libc wrapper missing'); return (...args) => { received = args; return 0; }; } }; }, errno: () => 95 };
    createExtensionAtomicRenamer('linux', noWrapper, architecture)('/project/from', '/project/to');
    assert.deepEqual(received, [number, 'int', -100, 'str', '/project/from', 'int', -100, 'str', '/project/to', 'uint', 1]);
  }
  assert.throws(() => createExtensionAtomicRenamer('linux', { load() { return { func() { throw new Error('missing'); } }; }, errno: () => 0 }, 'unknown'), /unknown/);
  if (process.platform === 'win32') {
    const source = path.join(temp, '中文 source'); const occupied = path.join(temp, '中文 occupied'); const free = path.join(temp, '中文 free');
    fs.mkdirSync(source); fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(source, 'source.txt'), 'source'); fs.writeFileSync(path.join(occupied, 'occupied.txt'), 'occupied');
    const actual = createExtensionAtomicRenamer();
    assert.throws(() => actual(source, occupied), error => error instanceof ExtensionAtomicRenameError && error.errorNumber === 183);
    assert.equal(fs.readFileSync(path.join(source, 'source.txt'), 'utf8'), 'source');
    assert.equal(fs.readFileSync(path.join(occupied, 'occupied.txt'), 'utf8'), 'occupied');
    actual(source, free);
    assert.equal(fs.existsSync(source), false); assert.equal(fs.readFileSync(path.join(free, 'source.txt'), 'utf8'), 'source');
  }
  console.log('extensions-atomic-rename: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
