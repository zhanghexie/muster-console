import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildExtensionCenterMirror, PAGES_ASSET_LIMIT } from '../scripts/build-extension-center-mirror.mjs';
import { discoverPublicExtensionReleases, proposeCommunityExtension } from '../scripts/discover-public-extension-releases.mjs';
import { parseReleaseTags } from '../scripts/extension-version-tags.mjs';
import { scanExtensionReleases } from '../scripts/scan-extension-releases.mjs';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-center-publication-'));
const known = 'a'.repeat(40);
const pending = 'b'.repeat(40);
const annotated = 'c'.repeat(40);
const source = `https://api.github.com/repos/zhanghexie/muster-extension-foo/contents/releases/1.0.0.json?ref=${known}`;
const verified = Buffer.from(JSON.stringify({ schemaVersion: 1, extensionId: 'foo', files: [] }));
const sha = createHash('sha256').update(verified).digest('hex');
const entry = { packageKey: 'muster/foo', publisherId: 'muster', extensionId: 'foo', name: 'Foo', version: '1.0.0',
  packageUrl: source, sha256: sha, fingerprint: `package-extension:${'d'.repeat(64)}`, previousFingerprints: [`package-extension:${'e'.repeat(64)}`] };
const catalog = { schemaVersion: 1, releases: [entry] };
const settings = { catalog, destination: path.join(scratch, 'site'), baseUrl: 'https://mirror.example.test', fetchImpl: async (url, init) => {
  assert.equal(url.href, source);
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Accept, 'application/vnd.github.raw+json');
  return new Response(verified);
} };

try {
  const [mirrored] = await buildExtensionCenterMirror(settings);
  assert.deepEqual({ ...mirrored, packageUrl: source }, entry);
  const file = new URL(mirrored.packageUrl).pathname;
  assert.equal(file, `/packages/muster/foo/1.0.0/${sha}.json`);
  assert.deepEqual(await fs.readFile(path.join(settings.destination, file)), verified);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(settings.destination, 'catalog.json'), 'utf8')), { schemaVersion: 1, releases: [mirrored] });

  const community = { ...entry, extensionId: 'outside', packageKey: 'author/outside', publisherId: 'author',
    repositoryUrl: 'https://github.com/author/my-plugin', packageUrl: `https://api.github.com/repos/author/my-plugin/contents/releases/1.0.0.json?ref=${known}` };
  const communitySettings = { ...settings, communityCatalog: { schemaVersion: 1, releases: [community] }, token: 'fixture-token',
    destination: path.join(scratch, 'community'), fetchImpl: async (url, init) => {
      const official = url.href === source;
      assert.equal(url.href, official ? source : community.packageUrl);
      assert.equal(init.headers.Authorization, official ? 'Bearer fixture-token' : undefined);
      return new Response(verified);
    } };
  const [, mirroredCommunity] = await buildExtensionCenterMirror(communitySettings);
  assert.equal(mirroredCommunity.packageUrl, `https://mirror.example.test/packages/author/outside/1.0.0/${sha}.json`);
  await assert.rejects(buildExtensionCenterMirror({ ...communitySettings, destination: path.join(scratch, 'wrong-owner'),
    communityCatalog: { schemaVersion: 1, releases: [{ ...community, packageUrl: community.packageUrl.replace('/author/', '/someone/') }] } }), /must be pinned/);
  await assert.rejects(buildExtensionCenterMirror({ ...communitySettings, destination: path.join(scratch, 'id-conflict'),
    communityCatalog: { schemaVersion: 1, releases: [{ ...community, extensionId: 'foo', packageKey: 'author/foo' }] } }), /Duplicate extension ID/);
  for (const [name, patch, reason] of [
    ['missing', { fetchImpl: async () => new Response(null, { status: 404 }) }, /HTTP 404/],
    ['tampered', { fetchImpl: async () => new Response('tampered') }, /SHA-256 mismatch/],
    ['oversize', { fetchImpl: async () => new Response(new Uint8Array(PAGES_ASSET_LIMIT + 1)) }, /25 MiB/],
    ['moving-ref', { catalog: { ...catalog, releases: [{ ...entry, packageUrl: source.replace(known, 'main') }] } }, /must be pinned/],
    ['duplicate', { catalog: { ...catalog, releases: [entry, entry] } }, /Duplicate extension/],
  ]) {
    const output = path.join(scratch, name);
    await assert.rejects(buildExtensionCenterMirror({ ...settings, ...patch, destination: output }), reason);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  }

  const currentTag = `${known}\trefs/tags/v1.0.0`;
  const newTags = `${currentTag}\n${annotated}\trefs/tags/v1.2.0\n${pending}\trefs/tags/v1.2.0^{}\n${pending}\trefs/tags/v2.0.0-rc.1`;
  assert.deepEqual([...parseReleaseTags(newTags)], [['1.0.0', known], ['1.2.0', pending]]);
  const result = await scanExtensionReleases({ catalog, destination: path.join(scratch, 'new-tag'), readTags: async () => newTags,
    pack: async (release, version, commit, target) => {
      assert.equal(release, entry);
      assert.equal(version, '1.2.0');
      assert.equal(commit, pending);
      await fs.writeFile(target, verified);
      return { version, sha256: sha };
    } });
  assert.equal(result.errors.length, 0);
  assert.equal(result.candidates[0].sourceCommit, pending);
  assert.deepEqual(result.candidates[0].previousFingerprints, [entry.fingerprint, ...entry.previousFingerprints]);
  const moved = await scanExtensionReleases({ catalog, destination: path.join(scratch, 'moved'), readTags: async () => currentTag.replace(known, pending) });
  assert.equal(moved.candidates.length, 0);
  assert.match(moved.errors[0].error, /different commit/);

  function versionedPackage(version, permissions, id = 'foo') {
    const manifest = { id, name: 'Foo', scope: 'global', version, permissions };
    return Buffer.from(JSON.stringify({ schemaVersion: 1, extensionId: id, fingerprint: entry.fingerprint,
      directories: [], files: [{ path: 'extension.json', bytesBase64: Buffer.from(JSON.stringify(manifest)).toString('base64') }] }));
  }
  const oldPackage = versionedPackage('1.0.0', []);
  const newPackage = versionedPackage('1.2.0', ['hostTools']);
  const approved = { ...catalog, releases: [{ ...entry, sha256: createHash('sha256').update(oldPackage).digest('hex') }] };
  const publicOptions = { catalog: approved, community: { schemaVersion: 1, releases: [] }, readTags: async () => newTags,
    fetchImpl: async url => new Response(url.searchParams.get('ref') === pending ? newPackage : oldPackage) };
  const review = await discoverPublicExtensionReleases(publicOptions);
  assert.equal(review.errors.length, 0);
  assert.deepEqual(review.candidates[0].after.permissions, ['hostTools']);
  assert.equal(review.catalog.releases[0].version, '1.2.0');
  assert.equal(new URL(review.catalog.releases[0].packageUrl).searchParams.get('ref'), pending);
  assert.equal(review.catalog.releases[0].sha256, createHash('sha256').update(newPackage).digest('hex'));
  const missing = await discoverPublicExtensionReleases({ ...publicOptions, fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.deepEqual(missing.catalog, approved);
  assert.equal(missing.candidates.length, 0);

  const communityOptions = { ...publicOptions, repositoryUrl: 'https://github.com/Author/My-Plugin/',
    fetchImpl: async (url, init) => {
      assert.equal(url.href, `https://api.github.com/repos/author/My-Plugin/contents/releases/1.2.0.json?ref=${pending}`);
      assert.equal(init.headers.Authorization, undefined);
      return new Response(versionedPackage('1.2.0', [], 'outside'));
    } };
  const proposal = await proposeCommunityExtension(communityOptions);
  assert.equal(proposal.community.releases[0].packageKey, 'author/outside');
  assert.deepEqual(proposal.catalog, approved);
  await assert.rejects(proposeCommunityExtension({ ...communityOptions, fetchImpl: async () => new Response(newPackage) }), /already registered/);
  await assert.rejects(proposeCommunityExtension({ ...communityOptions, repositoryUrl: 'https://github.com/author/My-Plugin/tree/main' }), /repository URL/);
  console.log('Extension publication mirror, immutable refs, candidate discovery and failure gates passed.');
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
