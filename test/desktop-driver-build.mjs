import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import beforePack from '../scripts/before-pack.mjs';
import { afterPack, assertBuildModes, buildTarget, cachePath, verifyBuildCache } from '../scripts/desktop-driver/build.mjs';
import { assertUnlinkedDirectory, directoryIdentity } from '../scripts/desktop-driver/cache.mjs';

const require = createRequire(import.meta.url);
const YAML = require('yaml');
// Initialize the package entry point before its mutually dependent internals.
require('app-builder-lib');
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher');
const { expandMacro } = require('app-builder-lib/out/util/macroExpander');
const { WinPackager } = require('app-builder-lib/out/winPackager');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = YAML.parse(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tmpRoot = path.join(root, '.tmp');
assertUnlinkedDirectory(root);
try { fs.mkdirSync(tmpRoot); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
assertUnlinkedDirectory(tmpRoot);
const temp = fs.mkdtempSync(path.join(tmpRoot, 'desktop-driver-build-test-'));
const identity = directoryIdentity(temp);

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
}

try {
  const targets = [
    ['win32', 1, 'win-x64'], ['win32', 3, 'win-arm64'],
    ['darwin', 1, 'mac-x64'], ['darwin', 3, 'mac-arm64'],
    ['linux', 1, 'linux-x64'], ['linux', 3, 'linux-arm64']
  ];
  for (const [platform, arch, expected] of targets) {
    const target = buildTarget(platform, arch);
    assert.equal(target.cacheName, expected);
    assert.equal(cachePath(root, target), path.join(root, '.tmp', 'desktop-driver', expected));
  }
  assert.deepEqual(buildTarget('darwin', 4), { platform: 'darwin', arch: 'universal', assetArch: 'x64', cacheName: 'mac-universal' });
  assert.doesNotThrow(() => assertBuildModes({ modeVerified: null }, buildTarget('win32', 1)));
  for (const platform of ['darwin', 'linux']) {
    assert.doesNotThrow(() => assertBuildModes({ modeVerified: true }, buildTarget(platform, 1)));
    assert.throws(() => assertBuildModes({ modeVerified: false }, buildTarget(platform, 1)), /Cannot verify Unix executable modes/);
  }
  for (const [platform, arch] of [['linux', 0], ['win32', 3 + 1], ['freebsd', 1], ['linux', 'riscv64']]) {
    assert.throws(() => buildTarget(platform, arch), /Unsupported|No pinned/);
  }
  assert.equal(config.beforePack, './scripts/before-pack.mjs');
  assert.equal(config.afterPack, './scripts/desktop-driver/after-pack.mjs');
  assert.equal(pkg.scripts['desktop-driver:check'], 'node scripts/desktop-driver/build.mjs --check-host');

  // Execute the actual npm lifecycle definitions in a fixture with no driver
  // cache. Stub only the underlying app/vite process to avoid opening a GUI.
  const lifecycle = path.join(temp, 'lifecycle-fixture'), calls = path.join(lifecycle, 'calls.log');
  fs.mkdirSync(path.join(lifecycle, 'scripts'), { recursive: true });
  const commands = ['dev', 'dev:run', 'dev:no-sandbox', 'dev:clean', 'build', 'start'];
  const scripts = {};
  for (const command of commands) {
    for (const key of [command, `pre${command}`]) if (pkg.scripts[key] !== undefined) scripts[key] = pkg.scripts[key];
  }
  fs.writeFileSync(path.join(lifecycle, 'package.json'), JSON.stringify({ name: 'driver-lifecycle-fixture', version: '1.0.0', private: true, scripts }));
  for (const [file, name] of [['dev.mjs', 'dev'], ['dev-no-sandbox.mjs', 'dev-no-sandbox'], ['clean-dev-sandbox.mjs', 'clean']]) {
    fs.writeFileSync(path.join(lifecycle, 'scripts', file), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(`${name}\n`)});\n`);
  }
  const bin = path.join(lifecycle, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  const viteStub = path.join(bin, 'electron-vite-fixture.cjs');
  fs.writeFileSync(viteStub, `require('node:fs').appendFileSync(${JSON.stringify(calls)}, (process.argv[2] || '') + '\\n');\n`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'electron-vite.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0electron-vite-fixture.cjs" %*\r\n`);
  } else {
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(path.join(bin, 'electron-vite'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(viteStub)} "$@"\n`, { mode: 0o755 });
  }
  const npmEnv = { ...process.env };
  const localEnvNames = new Set(['npm_config_cache', 'npm_config_logs_dir', 'npm_config_userconfig',
    'npm_config_update_notifier', 'tmp', 'temp', 'tmpdir']);
  for (const key of Object.keys(npmEnv)) if (localEnvNames.has(key.toLowerCase())) delete npmEnv[key];
  Object.assign(npmEnv, { npm_config_cache: path.join(lifecycle, 'npm-cache'),
    npm_config_logs_dir: path.join(lifecycle, 'npm-logs'), npm_config_userconfig: path.join(lifecycle, 'npmrc'),
    npm_config_update_notifier: 'false', TMP: lifecycle, TEMP: lifecycle, TMPDIR: lifecycle });
  for (const command of commands) {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command], {
      cwd: lifecycle, env: npmEnv, encoding: 'utf8', windowsHide: true,
      shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe']
    });
  }
  assert.equal(fs.existsSync(path.join(lifecycle, '.tmp', 'desktop-driver')), false, 'fixture must not contain a driver cache');
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/), ['dev', 'dev', 'dev-no-sandbox', 'clean', 'dev', 'build', 'preview']);

  // Exercise electron-builder's real matcher and copy implementation. Its os
  // macro is the target's build configuration key, not process.platform.
  const extra = config.extraResources.find(item => item && item.to === 'desktop-driver/contents');
  assert.deepEqual(extra, { from: '.tmp/desktop-driver/${os}-${arch}/contents', to: 'desktop-driver/contents' });
  const fixtureRoot = path.join(temp, 'copy-fixture'), resources = path.join(temp, 'staged', 'resources');
  fs.mkdirSync(fixtureRoot);
  let winMatcher;
  for (const [platform, arch, expected] of targets) {
    const target = buildTarget(platform, arch), os = expected.split('-')[0];
    const matchers = getFileMatchers(config, 'extraResources', resources, {
      defaultSrc: fixtureRoot,
      globalOutDir: path.join(fixtureRoot, 'release'),
      customBuildOptions: config[os] ?? {},
      macroExpander: value => expandMacro(value, target.arch, {}, { os })
    });
    const matcher = matchers.find(item => item.to === path.join(resources, 'desktop-driver', 'contents'));
    assert.ok(matcher, `missing extraResources mapping for ${platform}/${target.arch}`);
    assert.equal(matcher.from, path.join(fixtureRoot, '.tmp', 'desktop-driver', expected, 'contents'));
    if (expected === 'win-x64') winMatcher = matcher;
  }
  for (const [relative, text] of Object.entries({
    'driver/cua-driver.exe': 'fixture executable',
    'driver/cua-driver-uia.exe': 'fixture UIA',
    'driver/LICENSE': 'fixture license',
    'driver/THIRD_PARTY_NOTICES.md': 'fixture notice',
    'notices/MPL-2.0.txt': 'fixture MPL',
    'notices/SOURCES.md': 'fixture sources'
  })) {
    const file = path.join(winMatcher.from, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  await copyFiles([winMatcher], null, false);
  for (const relative of ['driver/cua-driver-uia.exe', 'driver/LICENSE', 'driver/THIRD_PARTY_NOTICES.md', 'notices/MPL-2.0.txt', 'notices/SOURCES.md']) {
    assert.equal(fs.readFileSync(path.join(winMatcher.to, relative), 'utf8'), fs.readFileSync(path.join(winMatcher.from, relative), 'utf8'));
  }

  // Use electron-builder's actual Windows signing selection, not a hand-written approximation.
  const shouldSign = WinPackager.prototype.shouldSignFile.bind({ platformSpecificBuildOptions: config.win });
  for (const name of ['cua-driver.exe', 'cua-driver-uia.exe', 'cua-cursor-theme.exe', 'cua_driver_sdk.dll', 'cua_driver_node_runtime.node']) {
    assert.equal(shouldSign(path.join('desktop-driver', name)), false, `upstream file must retain its signature: ${name}`);
    assert.equal(shouldSign(path.join('desktop-driver', name), true), false, `forced signing must also exclude upstream file: ${name}`);
  }
  assert.equal(shouldSign('MetaAgent.exe'), true);
  assert.equal(shouldSign('unrelated.exe'), true);

  // Real Git fixture, entirely inside this test's workspace-owned directory.
  const gitRoot = path.join(temp, 'git-fixture');
  fs.mkdirSync(gitRoot);
  git(gitRoot, 'init', '--quiet');
  fs.writeFileSync(path.join(gitRoot, '.gitignore'), '.tmp/\n');
  fs.mkdirSync(path.join(gitRoot, '.tmp', 'desktop-driver'), { recursive: true });
  const context = { packager: { projectDir: gitRoot }, electronPlatformName: 'win32', arch: 1 };
  const wouldPrune = path.join(gitRoot, 'node_modules', '@esbuild', 'linux-x64');
  fs.mkdirSync(wouldPrune, { recursive: true });
  fs.writeFileSync(path.join(wouldPrune, 'keep'), 'untouched');
  await assert.rejects(verifyBuildCache(gitRoot, 'win32', 'x64'), /cache is missing or invalid.*--archive/s);
  await assert.rejects(beforePack(context), /cache is missing or invalid/);
  assert.equal(fs.readFileSync(path.join(wouldPrune, 'keep'), 'utf8'), 'untouched', 'fail before pruning dependencies');

  const tracked = path.join(gitRoot, '.tmp', 'desktop-driver', 'win-x64', 'tracked');
  fs.mkdirSync(path.dirname(tracked));
  fs.writeFileSync(tracked, 'must not package');
  git(gitRoot, 'add', '--force', '--', '.tmp/desktop-driver/win-x64/tracked');
  await assert.rejects(verifyBuildCache(gitRoot, 'win32', 'x64'), /Git-tracked files/);
  git(gitRoot, 'rm', '--cached', '--quiet', '--', '.tmp/desktop-driver/win-x64/tracked');
  fs.writeFileSync(path.join(path.dirname(tracked), '.git'), 'gitdir: elsewhere');
  await assert.rejects(verifyBuildCache(gitRoot, 'win32', 'x64'), /Nested Git worktree/);

  const copiedContext = { electronPlatformName: 'win32', arch: 1, appOutDir: temp, packager: { getResourcesDir: () => resources } };
  await assert.rejects(afterPack(copiedContext), /missing or differs from the pinned/);
  await assert.rejects(afterPack({ ...copiedContext, electronPlatformName: 'linux', arch: 0 }), /No pinned/);

  console.log('desktop-driver-build: offline target, matcher, signing and failure checks passed');
} finally {
  assertUnlinkedDirectory(tmpRoot);
  const resolved = fs.realpathSync.native(temp), current = directoryIdentity(temp);
  if (path.relative(path.dirname(resolved), tmpRoot) !== '' || path.relative(resolved, temp) !== '' ||
      !path.basename(resolved).startsWith('desktop-driver-build-test-') || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error('Refusing to remove a replaced or unexpected test directory');
  }
  fs.rmSync(resolved, { recursive: true });
}
