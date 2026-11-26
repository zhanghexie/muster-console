import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-pty-helper-'));
try {
  const compile = createSharedCompiler(path.resolve(import.meta.dirname, '..'), tmp);
  const { preparePtySpawnHelper } = await import(pathToFileURL(compile('main/pty/spawnHelper.ts')).href);
  const unused = () => assert.fail('This environment does not use the macOS Electron helper');
  for (const platform of ['linux', 'win32']) preparePtySpawnHelper(platform, true, unused);
  preparePtySpawnHelper('darwin', false, unused);

  const file = path.join(tmp, 'spawn-helper');
  const check = packaged => preparePtySpawnHelper('darwin', true, () => ({ file, packaged }));
  assert.throws(() => check(true), /请重新安装集序/);
  const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')));
  applyLocaleSetting('en');
  try {
    assert.throws(() => check(true), error =>
      error.message === 'Cannot start the macOS terminal. The helper is unavailable (' + file + '). Reinstall Muster Console.'
      && error.cause?.code === 'ENOENT');
  } finally {
    applyLocaleSetting('zh-CN');
  }
  fs.mkdirSync(file);
  assert.throws(() => check(false), /重新安装或构建 node-pty/);
  fs.rmdirSync(file);
  if (process.platform !== 'win32') {
    fs.writeFileSync(file, 'fixture', { mode: 0o644 });
    assert.throws(() => check(true), error => error.cause?.code === 'EACCES');
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'signed installation stays untouched');
    check(false);
    fs.accessSync(file, fs.constants.X_OK);
    check(true);
    fs.chmodSync(file, 0o700);
    check(false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o700, 'an executable retains its original permissions');
    fs.chmodSync(file, 0o644);
    check(false);
    fs.accessSync(file, fs.constants.X_OK);
    const target = path.join(tmp, 'unrelated');
    fs.renameSync(file, target); fs.chmodSync(target, 0o644); fs.symlinkSync(target, file);
    assert.throws(() => check(false), /辅助程序不可用/);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  }
  console.log('pty-spawn-helper: platform routing, source permissions and packaged error handling passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
