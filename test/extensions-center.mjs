import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-center-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { DEFAULT_EXTENSION_CENTER_URL, ExtensionCenterService } = await import(pathToFileURL(compile('main/extensions/extensionCenter.ts')));
  const { ExtensionPackageCatalog } = await import(pathToFileURL(compile('main/extensions/extensionPackageCatalog.ts')));
  const { ExtensionSourceLayout } = await import(pathToFileURL(compile('main/extensions/extensionSourceLayout.ts')));
  const { ExtensionDevelopmentTrustStore } = await import(pathToFileURL(compile('main/extensions/extensionDevelopmentTrust.ts')));
  const { captureExtensionPackageAsync, fingerprintExtensionSnapshot } = await import(pathToFileURL(compile('main/extensions/extensionPackageSnapshot.ts')));
  const userData = path.join(temp, 'profile');
  const globalRoot = path.join(userData, 'extensions', 'global');
  const layout = new ExtensionSourceLayout({ userData, globalRoot });
  const catalog = new ExtensionPackageCatalog({ layout });
  const center = new ExtensionCenterService(userData, globalRoot, catalog, { catalogUrl: null });
  const previousCenterUrl = process.env.MUSTER_EXTENSION_CENTER_URL;
  const previousCenterLocal = process.env.MUSTER_EXTENSION_CENTER_LOCAL;
  delete process.env.MUSTER_EXTENSION_CENTER_URL;
  delete process.env.MUSTER_EXTENSION_CENTER_LOCAL;
  let defaultCatalogRequest;
  const defaultCenter = new ExtensionCenterService(userData, globalRoot, catalog, {
    token: 'fixture-token',
    fetchImpl: async (url, options) => {
      defaultCatalogRequest = String(url);
      const headers = new Headers(options.headers);
      assert.equal(headers.get('Accept'), 'application/vnd.github.raw+json');
      assert.equal(headers.get('Authorization'), 'Bearer fixture-token');
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ schemaVersion: 1, releases: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.deepEqual(await defaultCenter.listCatalog(), { source: 'github', releases: [] });
  assert.equal(defaultCatalogRequest, 'https://api.github.com/repos/zhanghexie/muster-extension-index/contents/catalog.json?ref=main');
  if (previousCenterUrl === undefined) delete process.env.MUSTER_EXTENSION_CENTER_URL;
  else process.env.MUSTER_EXTENSION_CENTER_URL = previousCenterUrl;
  if (previousCenterLocal === undefined) delete process.env.MUSTER_EXTENSION_CENTER_LOCAL;
  else process.env.MUSTER_EXTENSION_CENTER_LOCAL = previousCenterLocal;
  const { source: bundledSource, releases } = await center.listCatalog();
  assert.equal(bundledSource, 'bundled');
  assert.equal(releases[0].category, 'productivity');
  assert.deepEqual(releases.map(release => release.extensionId), ['daily-report']);
  assert.ok(releases.every(release => release.sourceKind === 'center'));
  const target = releases.find(release => !release.installed);
  assert.ok(target);
  const installed = await center.install(target.packageKey);
  assert.equal(installed.extensionId, target.extensionId);
  assert.equal(installed.installed, true);
  await catalog.syncGlobal();
  const after = (await center.list()).find(release => release.packageKey === target.packageKey);
  assert.equal(after?.installed, true);
  assert.equal(fs.existsSync(layout.global(target.extensionId).directory), true);
  const uninstalled = await center.uninstall(target.packageKey);
  assert.equal(uninstalled.uninstalled, true);
  assert.equal(fs.existsSync(layout.global(target.extensionId).directory), false);
  const remoteRoot = path.join(temp, 'remote-profile');
  const remoteLayout = new ExtensionSourceLayout({ userData: remoteRoot, globalRoot: path.join(remoteRoot, 'extensions', 'global') });
  const remoteCatalog = new ExtensionPackageCatalog({ layout: remoteLayout });
  const sourceLayout = new ExtensionSourceLayout({ userData: repo, globalRoot: path.join(repo, 'resources', 'extensions') });
  const source = await sourceLayout.discover({ scope: 'global', extensionId: 'daily-report' });
  const snapshot = await captureExtensionPackageAsync(source.descriptor.directory);
  const artifact = Buffer.from(JSON.stringify({ schemaVersion: 1, extensionId: 'daily-report', fingerprint: snapshot.fingerprint, directories: snapshot.directories, files: snapshot.files.map(file => ({ path: file.path, bytesBase64: file.bytes.toString('base64'), ...(file.executable ? { executable: true } : {}) })) }));
  const { createHash } = await import('node:crypto');
  const remoteCatalogJson = JSON.stringify({ schemaVersion: 1, releases: [{ packageKey: 'muster/daily-report', publisherId: 'muster', extensionId: 'daily-report', name: source.manifest.name, description: source.manifest.description, version: source.manifest.version, fingerprint: source.fingerprint, packageUrl: 'https://gitlab.example.test/packages/daily-report.json', sha256: createHash('sha256').update(artifact).digest('hex'), publisherName: 'Muster', repositoryUrl: 'https://gitlab.example.test/muster/metaagent-workbench', license: 'MIT', releaseNotes: '修复日报同步。', readme: '# 工作日报\n\n通过 AI 和人共同管理日报待办。', updatedAt: '2026-11-16T00:00:00Z', screenshots: ['https://gitlab.example.test/assets/daily-report.png'] }] });
  let cacheNow = 0, cacheRequests = 0, offline = false, releaseCacheRequest;
  const cacheGate = new Promise(resolve => { releaseCacheRequest = resolve; });
  const cacheCenter = new ExtensionCenterService(remoteRoot, remoteLayout.globalRoot, remoteCatalog, {
    catalogUrl: 'https://gitlab.example.test/catalog-cache.json', catalogTtlMs: 100, now: () => cacheNow,
    token: 'fixture-token',
    fetchImpl: async (_url, options) => {
      assert.equal(new Headers(options.headers).get('Authorization'), null);
      assert.equal(new Headers(options.headers).get('PRIVATE-TOKEN'), null);
      cacheRequests++;
      if (cacheRequests === 1) await cacheGate;
      if (offline) throw new Error('offline');
      return new Response(remoteCatalogJson, { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const firstCacheRead = cacheCenter.list(), secondCacheRead = cacheCenter.list();
  assert.equal(cacheRequests, 1, 'concurrent catalog reads share one request');
  releaseCacheRequest();
  const [firstCached, secondCached] = await Promise.all([firstCacheRead, secondCacheRead]);
  assert.equal(firstCached[0].packageKey, secondCached[0].packageKey);
  cacheNow = 50;
  await cacheCenter.list();
  assert.equal(cacheRequests, 1, 'fresh catalog is served from TTL cache');
  offline = true; cacheNow = 200;
  const staleCached = await cacheCenter.listCatalog({ force: true });
  assert.equal(staleCached.source, 'remote');
  assert.equal(staleCached.releases[0].packageKey, 'muster/daily-report', 'failed refresh preserves the last successful catalog and source');
  const fileCatalog = path.join(temp, 'catalog.json');
  fs.writeFileSync(fileCatalog, JSON.stringify({ schemaVersion: 1, releases: [] }));
  const fileCenter = new ExtensionCenterService(remoteRoot, remoteLayout.globalRoot, remoteCatalog, { catalogUrl: pathToFileURL(fileCatalog).href });
  assert.deepEqual(await fileCenter.listCatalog(), { source: 'file', releases: [] });
  const remote = new ExtensionCenterService(remoteRoot, remoteLayout.globalRoot, remoteCatalog, { catalogUrl: 'https://gitlab.example.test/catalog.json', fetchImpl: async url => new Response(url.endsWith('catalog.json') ? remoteCatalogJson : artifact, { status: 200, headers: { 'content-type': 'application/json' } }) });
  const remoteRelease = await remote.list();
  assert.equal(remoteRelease[0].packageUrl, 'https://gitlab.example.test/packages/daily-report.json');
  assert.equal(remoteRelease[0].publisherName, 'Muster');
  assert.equal(remoteRelease[0].releaseNotes, '修复日报同步。');
  assert.deepEqual(remoteRelease[0].screenshots, ['https://gitlab.example.test/assets/daily-report.png']);
  const remoteInstalled = await remote.install('muster/daily-report');
  assert.equal(remoteInstalled.installed, true);
  assert.equal(remoteInstalled.updated, false);
  assert.equal(remoteCatalog.get('global', 'daily-report').downloaded, true);
  assert.equal(remoteCatalog.get('global', 'daily-report').officialRelease, undefined, 'download provenance does not grant runtime trust');
  assert.equal(fs.existsSync(remoteLayout.global('daily-report').directory), true);
  await remoteCatalog.syncGlobal();
  const updateFiles = snapshot.files.map(file => file.path === 'extension.json' ? { ...file, bytes: Buffer.from(file.bytes.toString('utf8').replace(/("version"\s*:\s*)"[^"]+"/, '$1"99.0.0"')) } : { ...file });
  const updateSnapshot = { ...snapshot, files: updateFiles, fingerprint: '' };
  updateSnapshot.fingerprint = fingerprintExtensionSnapshot(updateSnapshot);
  const updateArtifact = Buffer.from(JSON.stringify({ schemaVersion: 1, extensionId: 'daily-report', fingerprint: updateSnapshot.fingerprint, directories: updateSnapshot.directories, files: updateSnapshot.files.map(file => ({ path: file.path, bytesBase64: file.bytes.toString('base64'), ...(file.executable ? { executable: true } : {}) })) }));
  const updateItem = {
    ...JSON.parse(remoteCatalogJson).releases[0],
    version: '99.0.0', fingerprint: updateSnapshot.fingerprint,
    minHostVersion: '0.1.34',
    category: 'productivity',
    previousFingerprints: [snapshot.fingerprint],
    packageUrl: `https://api.github.com/repos/zhanghexie/muster-extension-daily-report/contents/releases/99.0.0.json?ref=${'a'.repeat(40)}`,
    sha256: createHash('sha256').update(updateArtifact).digest('hex'),
    screenshots: undefined,
  };
  const githubCenter = (item, hostVersion = '0.1.34') => new ExtensionCenterService(remoteRoot, remoteLayout.globalRoot, remoteCatalog, {
    catalogUrl: DEFAULT_EXTENSION_CENTER_URL,
    token: 'fixture-token',
    hostVersion,
    fetchImpl: async (url, options) => {
      const headers = new Headers(options.headers);
      assert.equal(headers.get('Accept'), 'application/vnd.github.raw+json');
      assert.equal(headers.get('Authorization'), 'Bearer fixture-token');
      return url === DEFAULT_EXTENSION_CENTER_URL ? Response.json({ schemaVersion: 1, releases: [item] }) : new Response(updateArtifact);
    },
  });
  const unavailable = new ExtensionCenterService(remoteRoot, remoteLayout.globalRoot, remoteCatalog, {
    catalogUrl: DEFAULT_EXTENSION_CENTER_URL,
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  await assert.rejects(unavailable.list(), /MUSTER_EXTENSION_CENTER_GITHUB_TOKEN/);
  await assert.rejects(githubCenter(updateItem, '0.1.33').install(updateItem.packageKey), /requires Muster 0.1.34/);
  await assert.rejects(githubCenter({ ...updateItem, previousFingerprints: [] }).install(updateItem.packageKey), /local extension with the same ID/);
  const wrongOwner = githubCenter({ ...updateItem, packageUrl: updateItem.packageUrl.replace('/zhanghexie/', '/other-owner/') });
  const fallback = await wrongOwner.listCatalog();
  assert.equal(fallback.source, 'bundled', 'failed first GitHub read reports the bundled source');
  assert.equal(fallback.releases[0].packageUrl, undefined, 'GitHub cross-owner release is rejected before any download');
  const updater = githubCenter(updateItem);
  assert.equal((await updater.list())[0].category, 'productivity');
  assert.equal((await githubCenter({ ...updateItem, category: 'unknown-category' }).list())[0].category, undefined);
  await assert.rejects(githubCenter({ ...updateItem, sha256: 'b'.repeat(64) }).install(updateItem.packageKey), /SHA-256 does not match/);
  const updated = await updater.install('muster/daily-report');
  assert.equal(updated.updated, true);
  await remoteCatalog.syncGlobal();
  assert.equal((await updater.list())[0].installedVersion, '99.0.0');
  assert.equal((await updater.install(updateItem.packageKey)).skipped, true);
  const subject = { scope: 'global', extensionId: updateItem.extensionId, directory: remoteLayout.global(updateItem.extensionId).directory, fingerprint: updateItem.fingerprint };
  assert.equal(updater.isVerifiedRelease(subject), true);
  assert.equal(updater.isVerifiedRelease({ ...subject, scope: 'project' }), false);
  assert.equal(updater.isVerifiedRelease({ ...subject, directory: path.join(temp, 'other') }), false);
  assert.equal(githubCenter(updateItem, '0.1.33').isVerifiedRelease(subject), false);
  const restoredCatalog = new ExtensionPackageCatalog({ layout: remoteLayout });
  assert.equal(restoredCatalog.get('global', subject.extensionId).downloaded, true);
  const offlineCenter = new ExtensionCenterService(remoteRoot, remoteLayout.globalRoot, restoredCatalog, {
    catalogUrl: DEFAULT_EXTENSION_CENTER_URL, hostVersion: '0.1.34', fetchImpl: () => { throw new Error('must not use network'); },
  });
  const trust = new ExtensionDevelopmentTrustStore(remoteRoot, offlineCenter);
  assert.equal(await trust.ensureCanRun(subject), true, 'a verified official install survives restart offline');
  assert.equal(trust.isTrusted(subject), false, 'official release does not grant development-directory trust');
  await fs.promises.writeFile(path.join(subject.directory, 'local-edit.txt'), 'modified');
  const edited = await restoredCatalog.discover({ scope: 'global', extensionId: subject.extensionId });
  await restoredCatalog.syncGlobal();
  assert.equal(await trust.ensureCanRun({ ...subject, fingerprint: edited.fingerprint }), false);
  assert.equal(restoredCatalog.get('global', subject.extensionId).officialRelease, undefined);
  assert.equal(restoredCatalog.get('global', subject.extensionId).downloaded, undefined);

  const legacyId = 'legacy-news';
  const legacyDirectory = remoteLayout.global(legacyId).directory;
  await fs.promises.cp(source.descriptor.directory, legacyDirectory, { recursive: true });
  await fs.promises.writeFile(path.join(legacyDirectory, 'extension.json'), JSON.stringify({ ...source.manifest, id: legacyId }));
  const legacy = await restoredCatalog.discover({ scope: 'global', extensionId: legacyId });
  await restoredCatalog.register(legacy);
  const legacySubject = { scope: 'global', extensionId: legacyId, directory: legacyDirectory, fingerprint: legacy.fingerprint };
  const legacyRelease = {
    ...updateItem, extensionId: legacyId, packageKey: `muster/${legacyId}`, fingerprint: legacy.fingerprint,
    version: legacy.manifest.version, packageUrl: updateItem.packageUrl.replace('muster-extension-daily-report', `muster-extension-${legacyId}`),
  };
  const recognitionCenter = (catalogUrl, item) => new ExtensionCenterService(remoteRoot, remoteLayout.globalRoot, restoredCatalog, {
    catalogUrl, hostVersion: '0.1.34', fetchImpl: async () => Response.json({ schemaVersion: 1, releases: [item] }),
  });
  const custom = recognitionCenter('https://api.github.com/repos/zhanghexie/other-catalog/contents/catalog.json?ref=main', legacyRelease);
  assert.equal(await custom.verifyInstalledRelease(legacySubject), false, 'a custom index cannot authorize execution');
  const mutable = recognitionCenter(DEFAULT_EXTENSION_CENTER_URL, { ...legacyRelease, packageUrl: legacyRelease.packageUrl.replace('a'.repeat(40), 'main') });
  assert.equal(await mutable.verifyInstalledRelease(legacySubject), false, 'a branch reference cannot authorize execution');
  const official = recognitionCenter(DEFAULT_EXTENSION_CENTER_URL, legacyRelease);
  assert.equal(await official.verifyInstalledRelease(legacySubject), true, 'an exact installed official release can acquire provenance retroactively');
  assert.equal(official.isVerifiedRelease(legacySubject), true);
  const legacyWithMcp = { ...legacy.manifest, agent: { ...legacy.manifest.agent, mcp: ['fixture-mcp.mjs'] }, permissions: [...legacy.manifest.permissions, 'agent.mcp'] };
  await fs.promises.writeFile(path.join(legacyDirectory, 'extension.json'), JSON.stringify(legacyWithMcp));
  await fs.promises.writeFile(path.join(legacyDirectory, 'fixture-mcp.mjs'), 'export default {};');
  const mcpPackage = await restoredCatalog.discover({ scope: 'global', extensionId: legacyId });
  await restoredCatalog.register(mcpPackage);
  const mcpCenter = recognitionCenter(DEFAULT_EXTENSION_CENTER_URL, { ...legacyRelease, fingerprint: mcpPackage.fingerprint });
  assert.equal(await mcpCenter.verifyInstalledRelease({ ...legacySubject, fingerprint: mcpPackage.fingerprint }), false, 'release verification does not replace MCP consent');
  const { zipSync } = await import('fflate');
  const zipEntries = Object.fromEntries([
    ...snapshot.directories.map(directory => [`${directory}/`, new Uint8Array()]),
    ...snapshot.files.map(file => [file.path, new Uint8Array(file.bytes)])
  ]);
  const zipArtifact = Buffer.from(zipSync(zipEntries));
  const zipRoot = path.join(temp, 'zip-profile');
  const zipLayout = new ExtensionSourceLayout({ userData: zipRoot, globalRoot: path.join(zipRoot, 'extensions', 'global') });
  const zipCatalog = new ExtensionPackageCatalog({ layout: zipLayout });
  const zipCenter = new ExtensionCenterService(zipRoot, zipLayout.globalRoot, zipCatalog, { catalogUrl: 'https://gitlab.example.test/zip-catalog.json', fetchImpl: async url => new Response(url.endsWith('zip-catalog.json') ? JSON.stringify({ schemaVersion: 1, releases: [{ packageKey: 'muster/daily-report', publisherId: 'muster', extensionId: 'daily-report', name: source.manifest.name, version: source.manifest.version, fingerprint: source.fingerprint, packageUrl: 'https://gitlab.example.test/packages/daily-report.zip', sha256: createHash('sha256').update(zipArtifact).digest('hex') }] }) : zipArtifact, { status: 200 }) });
  const zipInstalled = await zipCenter.install('muster/daily-report');
  assert.equal(zipInstalled.installed, true);
  assert.equal(fs.existsSync(zipLayout.global('daily-report').directory), true);
  console.log('extensions-center: ok');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
