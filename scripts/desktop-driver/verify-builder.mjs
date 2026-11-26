// Optional Windows x64 packaging fixture. Uses the checked-in builder config,
// local Electron distribution and pinned workspace cache; never publishes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertUnlinkedDirectory, directoryIdentity } from './cache.mjs';
import { inspectPrepared } from './prepare.mjs';
import { verifyBuildCache } from './build.mjs';
import { acquireTestLease } from '../../test/helpers/lease.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoot = path.join(root, '.tmp');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This local packaging fixture requires a Windows x64 host');
assertUnlinkedDirectory(root);
assertUnlinkedDirectory(tmpRoot);
await verifyBuildCache(root, 'win32', 'x64');
const require = createRequire(import.meta.url);
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) throw new Error('Local Electron distribution is missing; this fixture does not download it');
const electronVersion = require('electron/package.json').version;
const releaseLease = acquireTestLease(root);
let owned, identity;

try {
  owned = fs.mkdtempSync(path.join(tmpRoot, 'desktop-driver-builder-fixture-'));
  identity = directoryIdentity(owned);
  const app = path.join(owned, 'app'), output = path.join(owned, 'output'), temp = path.join(owned, 'temp');
  fs.mkdirSync(path.join(app, 'out', 'main'), { recursive: true });
  fs.mkdirSync(temp);
  fs.writeFileSync(path.join(app, 'out', 'main', 'index.js'), 'console.log("desktop driver packaging fixture");\n');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
    name: 'desktop-driver-packaging-fixture', version: '1.0.0', main: 'out/main/index.js',
    description: 'Local packaging fixture', author: 'MetaAgent', private: true
  }));
  // Keep builder temporary files and caches inside the owned workspace fixture.
  process.env.TMP = temp;
  process.env.TEMP = temp;
  process.env.TMPDIR = temp;
  process.env.ELECTRON_CACHE = path.join(owned, 'electron-cache');
  process.env.ELECTRON_BUILDER_CACHE = path.join(owned, 'builder-cache');
  process.env.ELECTRON_BUILDER_OFFLINE = 'true';
  const { build, Platform } = require('app-builder-lib');
  const { Arch } = require('builder-util');
  await build({
    projectDir: root,
    targets: Platform.WINDOWS.createTarget('dir', Arch.x64),
    publish: 'never',
    config: {
      directories: { app, output }, electronDist, electronVersion, npmRebuild: false,
      // The production hook additionally prunes shared node_modules. In this
      // isolated fixture use the same driver guard without that unrelated step.
      beforePack: path.join(root, 'scripts', 'desktop-driver', 'build.mjs'),
      win: { signAndEditExecutable: false, signExecutable: false }
    }
  });
  const staged = path.join(output, 'win-unpacked', 'resources', 'desktop-driver');
  const checked = await inspectPrepared(staged, { platform: 'win32', arch: 'x64' });
  assert.equal(checked.files, 8);
  for (const name of ['cua-driver-uia.exe', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(fs.statSync(path.join(staged, 'contents', 'driver', name)).isFile(), `Missing packaged ${name}`);
  }
  for (const name of ['MPL-2.0.txt', 'node-runtime-NOTICE.md', 'SOURCES.md']) {
    assert.ok(fs.statSync(path.join(staged, 'contents', 'notices', name)).isFile(), `Missing packaged ${name}`);
  }
  console.log('desktop-driver: local electron-builder Windows x64 fixture passed (no signing or installer)');
} finally {
  try {
    if (owned) {
      if (!identity) throw new Error(`Cannot identify builder fixture; preserved at ${owned}`);
      assertUnlinkedDirectory(tmpRoot);
      const resolved = fs.realpathSync.native(owned), current = directoryIdentity(owned);
      if (path.relative(path.dirname(resolved), tmpRoot) !== '' || path.relative(resolved, owned) !== '' ||
          !path.basename(resolved).startsWith('desktop-driver-builder-fixture-') || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('Refusing to remove a replaced or unexpected builder fixture');
      }
      fs.rmSync(resolved, { recursive: true });
    }
  } finally {
    releaseLease();
  }
}
