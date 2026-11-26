import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync, zipSync } from 'fflate';
import { resolveAsset, supportedTargets } from '../scripts/desktop-driver/catalog.mjs';
import { extractVerifiedArchive, verifyBundle } from '../scripts/desktop-driver/archive.mjs';
import { downloadPinned } from '../scripts/desktop-driver/download.mjs';
import { describeDesktopEnvironment, describeTarget, inspectPrepared, prepareDriver, verifyNotices } from '../scripts/desktop-driver/prepare.mjs';
import { assertUnlinkedDirectory, cleanupOwnedScratch, directoryIdentity, outputLocation, publishContents } from '../scripts/desktop-driver/cache.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.from(value, 'utf8');
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = path.join(workspace, '.tmp'), testParent = path.join(tmpRoot, 'desktop-driver');
assertUnlinkedDirectory(workspace);
for (const directory of [tmpRoot, testParent]) {
  try { fs.mkdirSync(directory); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  assertUnlinkedDirectory(directory);
}
const temp = fs.mkdtempSync(path.join(testParent, 'metaagent-driver-test-'));
const tempIdentity = directoryIdentity(temp);
let index = 0;
const location = name => path.join(temp, `${++index}-${name}`);
function fixtureGit(root, ...args) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
}
function fixtureRepo() {
  const root = location('fixture-repo');
  fs.mkdirSync(root);
  fixtureGit(root, 'init', '--quiet');
  const emptyExcludes = path.join(root, 'empty-excludes');
  fs.writeFileSync(emptyExcludes, '');
  fixtureGit(root, 'config', 'core.excludesFile', emptyExcludes);
  fs.writeFileSync(path.join(root, '.gitignore'), '.tmp/\n');
  const cache = path.join(root, '.tmp', 'desktop-driver');
  fs.mkdirSync(cache, { recursive: true });
  return { root, cache };
}
function directoryLink(target, link) { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
function metadata(files, mode = null) {
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { size: content.length, sha256: sha(content), mode }]));
}
function spec(format, archive, files) {
  return { root: 'fixture', format, size: archive.length, sha256: sha(archive), files };
}
function zipFile(entries) { return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [`fixture/${name}`, value])))); }
function writeOctal(header, offset, length, value) { header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii'); }
function tarFile(entries) {
  const blocks = [];
  for (const { name, data = Buffer.alloc(0), type = '0', mode = 0o644 } of entries) {
    const header = Buffer.alloc(512);
    header.write(`fixture/${name}`, 0, 100, 'utf8');
    writeOctal(header, 100, 8, mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header.write(type, 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.from(gzipSync(Buffer.concat(blocks)));
}
async function extract(archive, asset) {
  const archivePath = location('archive'), output = location('payload'), scratch = location('expanded.tar');
  fs.writeFileSync(archivePath, archive);
  await extractVerifiedArchive(archivePath, output, asset, scratch);
  return output;
}

try {
  await verifyNotices(path.join(workspace, 'scripts', 'desktop-driver', 'notices'));
  assert.deepEqual(supportedTargets().sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
  for (const target of supportedTargets()) {
    const [platform, arch] = target.split('-'), info = describeTarget(platform, arch), asset = resolveAsset(platform, arch);
    assert.equal(info.signatureVerified, false);
    assert.equal(info.distributionReady, false);
    assert.match(info.sha256, /^[a-f0-9]{64}$/);
    assert.ok(asset.files.LICENSE && asset.files['THIRD_PARTY_NOTICES.md']);
    if (platform === 'win32') assert.ok(asset.files['cua-driver-uia.exe'], 'UIA helper must be pinned');
  }
  assert.equal(resolveAsset('darwin', 'x64'), resolveAsset('darwin', 'arm64'));
  assert.throws(() => resolveAsset('linux', 'ia32'), /No pinned/);
  assert.throws(() => describeTarget('freebsd', 'x64'), /No pinned/);
  assert.equal(describeDesktopEnvironment('linux', { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }).session, 'wayland');
  assert.equal(describeDesktopEnvironment('linux', { DISPLAY: ':0' }).session, 'x11');
  assert.equal(describeDesktopEnvironment('linux', { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }).session, 'ambiguous');
  assert.equal(describeDesktopEnvironment('linux', {}).session, 'unknown');
  assert.equal(describeDesktopEnvironment('win32', {}).session, 'unverified');
  assert.equal(describeDesktopEnvironment('darwin', {}).session, 'unverified');

  const content = bytes('verified payload'), data = { 'sub/one.txt': content, 'LICENSE': bytes('license') };
  const zip = zipFile(data), zipAsset = spec('zip', zip, metadata(data));
  const zipDir = await extract(zip, zipAsset);
  assert.equal(fs.readFileSync(path.join(zipDir, 'sub', 'one.txt'), 'utf8'), 'verified payload');
  assert.deepEqual(await verifyBundle(zipDir, zipAsset), { files: 2 });
  fs.writeFileSync(path.join(zipDir, 'sub', 'one.txt'), 'altered');
  await assert.rejects(verifyBundle(zipDir, zipAsset), /checksum mismatch/);

  const tar = tarFile([{ name: 'sub/one.txt', data: content }, { name: 'LICENSE', data: data.LICENSE }]);
  const tarAsset = spec('tar.gz', tar, metadata(data, 0o644));
  const tarDir = await extract(tar, tarAsset);
  assert.equal(fs.readFileSync(path.join(tarDir, 'sub', 'one.txt'), 'utf8'), 'verified payload');
  assert.deepEqual(await verifyBundle(tarDir, tarAsset), { files: 2 });

  const wrong = { ...zipAsset, sha256: '0'.repeat(64) };
  await assert.rejects(extract(zip, wrong), /archive checksum mismatch/);
  const tamperedZip = zipFile({ 'sub/one.txt': bytes('malicious data!!'), 'LICENSE': data.LICENSE });
  await assert.rejects(extract(tamperedZip, spec('zip', tamperedZip, metadata(data))), /size mismatch|checksum mismatch/);
  const traversal = zipFile({ '../outside.txt': bytes('bad') });
  await assert.rejects(extract(traversal, spec('zip', traversal, metadata({ '../outside.txt': bytes('bad') }))), /Unsafe archive path/);
  const collision = zipFile({ 'A.txt': bytes('a'), 'a.txt': bytes('b') });
  await assert.rejects(extract(collision, spec('zip', collision, metadata({ 'A.txt': bytes('a'), 'a.txt': bytes('b') }))), /colliding/);
  const special = zipFile({ 'link': bytes('target') });
  const central = special.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  special.writeUInt16LE(3 << 8, central + 4);
  special.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  await assert.rejects(extract(special, spec('zip', special, metadata({ link: bytes('target') }))), /Links and special/);
  const tarLink = tarFile([{ name: 'link', data: bytes('target'), type: '2' }]);
  await assert.rejects(extract(tarLink, spec('tar.gz', tarLink, metadata({ link: bytes('target') }, 0o644))), /Links, extensions/);
  const tarTraversal = tarFile([{ name: '../outside.txt', data: bytes('bad') }]);
  await assert.rejects(extract(tarTraversal, spec('tar.gz', tarTraversal, metadata({ '../outside.txt': bytes('bad') }, 0o644))), /Unsafe archive path/);

  const downloaded = bytes('offline fixture');
  const downloadAsset = { url: 'https://github.com/trycua/cua/releases/download/test', size: downloaded.length, sha256: sha(downloaded) };
  const downloadPath = location('download');
  let requests = 0;
  await downloadPinned(downloadAsset, downloadPath, async (_url, init) => { requests++; assert.equal(init.headers['User-Agent'], 'Muster-Desktop-Driver-Prep'); return new Response(downloaded, { status: 200 }); });
  assert.equal(requests, 1);
  assert.deepEqual(fs.readFileSync(downloadPath), downloaded);
  await assert.rejects(downloadPinned({ ...downloadAsset, sha256: '0'.repeat(64) }, location('bad-download'), async () => new Response(downloaded)), /pinned SHA-256/);
  await assert.rejects(downloadPinned(downloadAsset, location('bad-host'), async () => new Response(null, { status: 302, headers: { location: 'https://example.com/file' } })), /untrusted origin/);
  await assert.rejects(downloadPinned(downloadAsset, location('bad-length'), async () => new Response(downloaded, { headers: { 'content-length': '999' } })), /length/);
  await assert.rejects(downloadPinned(downloadAsset, location('http-error'), async () => new Response(null, { status: 404 })), /HTTP 404/);

  const platform = process.platform, arch = 'x64';
  if (['win32', 'linux', 'darwin'].includes(platform)) {
    const existing = location('existing');
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, 'keep'), 'untouched');
    await assert.rejects(prepareDriver({ output: existing, platform, arch }), /already exists/);
    assert.equal(fs.readFileSync(path.join(existing, 'keep'), 'utf8'), 'untouched');
    await assert.rejects(prepareDriver({ output: path.resolve('.desktop-driver-must-not-write'), platform, arch }), /Only the project/);
    const fakeGit = location('git'), sub = path.join(fakeGit, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(fakeGit, '.git'), 'gitdir: somewhere');
    await assert.rejects(prepareDriver({ output: path.join(sub, 'driver'), platform, arch }), /Nested Git worktree/);
    const fakeArchive = location('small-archive'), failed = location('failed-output');
    fs.writeFileSync(fakeArchive, zip);
    await assert.rejects(prepareDriver({ output: failed, platform, arch, archivePath: fakeArchive }), /Pinned archive checksum mismatch/);
    assert.equal(fs.existsSync(failed), false);
    assert.equal(fs.readdirSync(temp).some(name => name.startsWith('.cua-driver-')), false, 'failed preparation must clean its own scratch');
    await assert.rejects(inspectPrepared(failed, { platform, arch }));
    if (platform === 'win32') await assert.rejects(prepareDriver({ output: location('unix-output'), platform: 'linux', arch: 'x64' }), /cannot preserve executable modes/);
  }

  // Use isolated real Git indexes inside the test-owned workspace directory.
  const fixture = fixtureRepo(), allowed = path.join(fixture.cache, 'allowed');
  assert.equal(outputLocation(allowed, fixture.root).target, allowed);
  assert.throws(() => outputLocation(path.join(fixture.root, 'other-output'), fixture.root), /Only the project/);
  assert.throws(() => outputLocation(`${fixture.cache}${path.sep}..${path.sep}escape`, fixture.root), /parent traversal/);

  fs.writeFileSync(path.join(fixture.root, '.gitignore'), '');
  assert.throws(() => outputLocation(allowed, fixture.root), /not Git-ignored/);
  fs.writeFileSync(path.join(fixture.root, '.gitignore'), '.tmp/\n');
  const tracked = path.join(fixture.cache, 'tracked.txt');
  fs.writeFileSync(tracked, 'tracked');
  fixtureGit(fixture.root, 'add', '--force', '--', '.tmp/desktop-driver/tracked.txt');
  assert.throws(() => outputLocation(allowed, fixture.root), /Git-tracked files/);
  fixtureGit(fixture.root, 'rm', '--cached', '--quiet', '--', '.tmp/desktop-driver/tracked.txt');
  const blob = fixtureGit(fixture.root, 'hash-object', '-w', '--', tracked).trim();
  fixtureGit(fixture.root, 'update-index', '--add', '--cacheinfo', '100644', blob, '.TMP/DESKTOP-DRIVER/case.txt');
  assert.throws(() => outputLocation(allowed, fixture.root), /Git-tracked files/);
  fixtureGit(fixture.root, 'update-index', '--force-remove', '--', '.TMP/DESKTOP-DRIVER/case.txt');

  const rootLink = location('project-link');
  directoryLink(fixture.root, rootLink);
  assert.throws(() => outputLocation(path.join(rootLink, '.tmp', 'desktop-driver', 'out'), rootLink), /link or not a directory/);
  const destination = location('link-destination');
  fs.mkdirSync(destination);
  const linkedParent = path.join(fixture.cache, 'parent-link');
  directoryLink(destination, linkedParent);
  assert.throws(() => outputLocation(path.join(linkedParent, 'out'), fixture.root), /link or not a directory/);
  await assert.rejects(inspectPrepared(linkedParent, { platform: 'win32', arch: 'x64' }), /link or not a directory/);

  const rootLinked = fixtureRepo(), linkedCacheTarget = location('cache-link-target');
  fs.mkdirSync(linkedCacheTarget);
  fs.rmdirSync(rootLinked.cache);
  directoryLink(linkedCacheTarget, rootLinked.cache);
  assert.throws(() => outputLocation(path.join(rootLinked.cache, 'out'), rootLinked.root), /link or not a directory/);
  const ancestorLinked = fixtureRepo(), linkedTmpTarget = location('tmp-link-target');
  fs.mkdirSync(path.join(linkedTmpTarget, 'desktop-driver'), { recursive: true });
  fs.rmdirSync(ancestorLinked.cache);
  fs.rmdirSync(path.join(ancestorLinked.root, '.tmp'));
  directoryLink(linkedTmpTarget, path.join(ancestorLinked.root, '.tmp'));
  assert.throws(() => outputLocation(path.join(ancestorLinked.root, '.tmp', 'desktop-driver', 'out'), ancestorLinked.root), /link or not a directory/);

  const staged = location('staged-contents');
  fs.mkdirSync(staged);
  const conflict = path.join(fixture.cache, 'conflict'), beforeConflict = outputLocation(conflict, fixture.root);
  fs.mkdirSync(conflict);
  fs.writeFileSync(path.join(conflict, 'keep'), 'existing');
  assert.throws(() => publishContents(staged, beforeConflict), /already exists/);
  assert.equal(fs.readFileSync(path.join(conflict, 'keep'), 'utf8'), 'existing');
  assert.ok(fs.existsSync(staged));

  // A target may appear after the final check but before mkdir; exclusive mkdir must win.
  const race = path.join(fixture.cache, 'creation-race'), beforeRace = outputLocation(race, fixture.root);
  const nativeMkdir = fs.mkdirSync;
  try {
    fs.mkdirSync = function (candidate, ...args) {
      if (candidate === race) {
        nativeMkdir.call(fs, candidate, ...args);
        fs.writeFileSync(path.join(candidate, 'keep'), 'raced');
      }
      return nativeMkdir.call(fs, candidate, ...args);
    };
    assert.throws(() => publishContents(staged, beforeRace), /EEXIST/);
  } finally { fs.mkdirSync = nativeMkdir; }
  assert.equal(fs.readFileSync(path.join(race, 'keep'), 'utf8'), 'raced');
  assert.ok(fs.existsSync(staged));

  // If a target is replaced after creation and rename fails, do not remove the replacement.
  const replacedTarget = path.join(fixture.cache, 'replacement-race');
  const beforeReplacement = outputLocation(replacedTarget, fixture.root), nativeRename = fs.renameSync;
  try {
    fs.renameSync = function (from, to) {
      if (from === staged && to === path.join(replacedTarget, 'contents')) {
        nativeRename.call(fs, replacedTarget, `${replacedTarget}-original`);
        fs.mkdirSync(replacedTarget);
        fs.writeFileSync(path.join(replacedTarget, 'keep'), 'replacement');
        throw new Error('simulated publication conflict');
      }
      return nativeRename.call(fs, from, to);
    };
    assert.throws(() => publishContents(staged, beforeReplacement), /simulated publication conflict/);
  } finally { fs.renameSync = nativeRename; }
  assert.equal(fs.readFileSync(path.join(replacedTarget, 'keep'), 'utf8'), 'replacement');
  assert.ok(fs.existsSync(staged));

  const failedTarget = path.join(fixture.cache, 'failed-rename'), beforeFailedRename = outputLocation(failedTarget, fixture.root);
  try {
    fs.renameSync = function (from, to) {
      if (from === staged && to === path.join(failedTarget, 'contents')) throw new Error('simulated rename failure');
      return nativeRename.call(fs, from, to);
    };
    assert.throws(() => publishContents(staged, beforeFailedRename), /simulated rename failure/);
  } finally { fs.renameSync = nativeRename; }
  assert.ok(fs.statSync(failedTarget).isDirectory(), 'failed publication must preserve its target');
  assert.ok(fs.existsSync(staged));

  const replacedScratch = fs.mkdtempSync(path.join(temp, '.cua-driver-'));
  const ownedIdentity = directoryIdentity(replacedScratch);
  fs.renameSync(replacedScratch, `${replacedScratch}-original`);
  fs.mkdirSync(replacedScratch);
  assert.throws(() => cleanupOwnedScratch(replacedScratch, temp, ownedIdentity), /replaced/);
  assert.ok(fs.existsSync(replacedScratch));
  console.log('desktop-driver-preparation: offline checks passed');
} finally {
  assertUnlinkedDirectory(testParent);
  const resolved = fs.realpathSync.native(temp), currentIdentity = directoryIdentity(temp);
  if (path.relative(path.dirname(resolved), testParent) !== '' || path.relative(resolved, temp) !== '' ||
      !path.basename(resolved).startsWith('metaagent-driver-test-') ||
      currentIdentity.dev !== tempIdentity.dev || currentIdentity.ino !== tempIdentity.ino) {
    throw new Error('Refusing to remove a replaced or unexpected test directory');
  }
  fs.rmSync(resolved, { recursive: true });
}
