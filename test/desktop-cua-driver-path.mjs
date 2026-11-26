import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'cua-driver-path-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { resolveCuaDriverPath } = await import(pathToFileURL(compile('main/desktop/cuaDriverPath.ts')));
  const appPath = path.join(temp, 'app'), resourcesPath = path.join(temp, 'resources');
  for (const [platform, folder, executable] of [['win32', 'win', 'cua-driver.exe'], ['darwin', 'mac', 'cua-driver'], ['linux', 'linux', 'cua-driver']]) {
    for (const arch of ['x64', 'arm64']) {
      const driverDir = path.join(appPath, '.tmp', 'desktop-driver', `${folder}-${arch}`, 'contents', 'driver');
      fs.mkdirSync(driverDir, { recursive: true });
      fs.writeFileSync(path.join(driverDir, executable), 'fixture', { mode: 0o755 });
      const location = { appPath, resourcesPath, isPackaged: false, platform, arch };
      assert.equal(resolveCuaDriverPath(location), fs.realpathSync(path.join(driverDir, executable)));
    }
  }
  const packagedDir = path.join(resourcesPath, 'desktop-driver', 'contents', 'driver');
  fs.mkdirSync(packagedDir, { recursive: true });
  fs.writeFileSync(path.join(packagedDir, 'cua-driver.exe'), 'fixture');
  fs.writeFileSync(path.join(packagedDir, 'cua-driver'), 'fixture', { mode: 0o755 });
  for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
    const expected = path.join(packagedDir, platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
    assert.equal(resolveCuaDriverPath({ appPath, resourcesPath, isPackaged: true, platform, arch }), fs.realpathSync(expected));
  }
  const valid = { appPath, resourcesPath, isPackaged: false, platform: 'win32', arch: 'x64' };
  assert.throws(() => resolveCuaDriverPath({ ...valid, arch: 'ia32' }), /No pinned/);
  assert.throws(() => resolveCuaDriverPath({ ...valid, platform: 'freebsd' }), /No pinned/);
  assert.throws(() => resolveCuaDriverPath({ ...valid, appPath: 'relative' }), /host paths/);
  assert.throws(() => resolveCuaDriverPath({ ...valid, appPath: path.join(temp, 'absent') }), /prepare.mjs/);
  assert.throws(() => resolveCuaDriverPath({ ...valid, isPackaged: true, resourcesPath: path.join(temp, 'absent') }), /reinstall/);
  const binary = path.join(appPath, '.tmp', 'desktop-driver', 'win-x64', 'contents', 'driver', 'cua-driver.exe');
  fs.unlinkSync(binary); fs.mkdirSync(binary);
  assert.throws(() => resolveCuaDriverPath(valid), /missing or inaccessible/);
  fs.rmdirSync(binary);
  if (process.platform !== 'win32') {
    const unixBinary = path.join(appPath, '.tmp', 'desktop-driver', 'linux-x64', 'contents', 'driver', 'cua-driver');
    fs.chmodSync(unixBinary, 0o600);
    assert.throws(() => resolveCuaDriverPath({ ...valid, platform: 'linux' }), /missing or inaccessible/);
  }
  if (process.env.MUSTER_TEST_CUA_LOCATOR === '1') {
    const { CuaTransport } = await import(pathToFileURL(compile('main/desktop/cuaTransport.ts')));
    const realBinary = resolveCuaDriverPath({ appPath: process.cwd(), resourcesPath: path.join(process.cwd(), '.tmp'),
      isPackaged: false, platform: process.platform, arch: process.arch });
    const driver = new CuaTransport(realBinary);
    await driver.connect();
    try {
      const result = await driver.call('list_apps', {});
      assert.notEqual(result.isError, true);
    } finally { await driver.close(); }
    console.log('Cua driver path: resolved real development driver and list_apps passed');
  }
  console.log('Cua driver path: development/package mapping and missing driver errors passed');
} finally { removeWorkspaceFixture(temp, 'cua-driver-path-'); }
