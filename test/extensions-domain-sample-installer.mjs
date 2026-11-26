import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-sample-install-'));
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-sample-installer-compile'));
const { bundledSampleRoot, installBundledSamples, installLocalPackage, refreshDevelopmentPackage, refreshDevelopmentSample } = await import(pathToFileURL(compile('main/extensions/extensionSampleInstaller.ts')).href);
const sourceRoot = path.join(repo, 'resources', 'extensions');
const globalRoot = path.join(tmp, 'extensions', 'global');
const localRoot = path.join(tmp, 'local-packages');
const localPackage = path.join(sourceRoot, 'daily-report');
assert.equal(await installLocalPackage(tmp, localRoot, localPackage), 'daily-report');
await assert.rejects(() => installLocalPackage(tmp, localRoot, localPackage), /already installed/);
assert.deepEqual(fs.readdirSync(localRoot), ['daily-report']);
const first = await installBundledSamples(tmp, globalRoot, sourceRoot);
assert.deepEqual(first.installed.sort(), ['daily-report']);
assert.deepEqual(first.skipped, []);
const second = await installBundledSamples(tmp, globalRoot, sourceRoot);
assert.deepEqual(second.installed, []);
assert.deepEqual(second.skipped.sort(), ['daily-report']);
assert.equal(second.errors.length, 0);
// Installed-app lookup prefers its extraResources directory over the checkout.
const packaged = path.join(tmp, 'packaged-resources');
fs.cpSync(sourceRoot, path.join(packaged, 'extensions'), { recursive: true, filter: source => source === sourceRoot || source.startsWith(path.join(sourceRoot, 'daily-report')) });
Object.defineProperty(process, 'resourcesPath', { value: packaged, configurable: true });
try {
  assert.equal(bundledSampleRoot(), path.join(packaged, 'extensions'));
  const installedFromPackage = await installBundledSamples(tmp, path.join(tmp, 'fresh-packaged-profile'));
  assert.deepEqual(installedFromPackage.installed, ['daily-report']);
  assert.deepEqual(installedFromPackage.errors, []);
} finally {
  delete process.resourcesPath;
}
const marker = path.join(globalRoot, 'daily-report', 'ui', 'panel.html');
fs.appendFileSync(marker, '\n<!-- development refresh -->\n');
const refreshed = await installBundledSamples(tmp, globalRoot, sourceRoot, ['daily-report'], { overwriteExisting: true });
assert.deepEqual(refreshed.installed, ['daily-report']);
assert.equal(fs.readFileSync(marker, 'utf8').includes('development refresh'), false, 'development refresh replaces stale bundled sample files');

// Repository edits, installed-only edits, and conflicting edits during a dev session.
const devSources = path.join(tmp, 'dev-sources');
fs.cpSync(localPackage, path.join(devSources, 'daily-report'), { recursive: true });
let baseline;
await installBundledSamples(tmp, globalRoot, devSources, ['daily-report'], { overwriteExisting: true, installedFingerprint: (_id, hash) => { baseline = hash; } });
const installed = path.join(globalRoot, 'daily-report');
const reload = () => refreshDevelopmentSample(tmp, installed, 'daily-report', baseline, devSources);
const entry = path.join(devSources, 'daily-report', 'ui', 'panel.html');
fs.appendFileSync(entry, 'repo-v2');
baseline = await reload();
assert.ok(fs.readFileSync(marker, 'utf8').endsWith('repo-v2'));
fs.appendFileSync(marker, 'installed-v3');
assert.equal(await reload(), baseline);
assert.ok(fs.readFileSync(marker, 'utf8').endsWith('installed-v3'));

// A repository extension outside the bundled sample list is refreshed before
// reload, so generated panel assets are visible from the installed package.
const codeSource = path.join(tmp, 'repo-extensions', 'code-animation');
fs.cpSync(localPackage, codeSource, { recursive: true });
const codeInstalled = path.join(tmp, 'dev-installed', 'code-animation');
fs.mkdirSync(path.dirname(codeInstalled), { recursive: true });
fs.cpSync(codeSource, codeInstalled, { recursive: true });
const codePanel = path.join(codeSource, 'ui', 'panel.html');
fs.appendFileSync(codePanel, '<!-- source-v2 -->');
await refreshDevelopmentPackage(codeInstalled, codeSource, 'daily-report');
assert.equal(fs.readFileSync(path.join(codeInstalled, 'ui', 'panel.html'), 'utf8').includes('source-v2'), true);
fs.appendFileSync(entry, 'repo-v3');
await assert.rejects(reload(), /Both sample directories changed/);
assert.ok(fs.readFileSync(marker, 'utf8').endsWith('installed-v3'));

// 退役样例清理：profile 里残留的已下线内置包目录在安装时被移除，catalog 重扫后即消失。
const migratedRoot = path.join(globalRoot, 'gomoku');
fs.mkdirSync(migratedRoot, { recursive: true });
fs.writeFileSync(path.join(migratedRoot, 'keep.txt'), 'previously installed extension');
const retiredRoot = path.join(globalRoot, 'bookshelf');
fs.mkdirSync(path.join(retiredRoot, 'ui'), { recursive: true });
fs.writeFileSync(path.join(retiredRoot, 'extension.json'), '{"id":"bookshelf"}');
await installBundledSamples(tmp, globalRoot, sourceRoot, ['daily-report']);
assert.equal(fs.existsSync(retiredRoot), false, 'retired bundled samples are removed from the profile during install');
assert.equal(fs.existsSync(path.join(globalRoot, 'daily-report', 'extension.json')), true, 'active samples survive retired cleanup');
assert.equal(fs.readFileSync(path.join(migratedRoot, 'keep.txt'), 'utf8'), 'previously installed extension');
console.log('extensions-sample-installer: ok');


