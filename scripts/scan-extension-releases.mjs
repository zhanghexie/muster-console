import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { githubReleaseUrl, PAGES_ASSET_LIMIT } from './build-extension-center-mirror.mjs';
import { compareVersions, parseReleaseTags, readReleaseTags } from './extension-version-tags.mjs';

const exec = promisify(execFile);
const packer = fileURLToPath(new URL('./pack-extension-release.mjs', import.meta.url));

function git(args, cwd) {
  return exec('git', ['-c', 'http.followRedirects=false', '-c', 'core.hooksPath=.git/muster-disabled-hooks', ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function repositoryOf(entry) {
  const ref = githubReleaseUrl(entry);
  const [, , owner, name] = ref.pathname.split('/');
  return { url: `https://github.com/${owner}/${name}.git`, publishedCommit: ref.searchParams.get('ref') };
}

export async function packReleaseCandidate(entry, version, sha, target) {
  const { url } = repositoryOf(entry);
  const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'muster-extension-source-'));
  try {
    await git(['init', '--quiet'], checkout);
    await git(['fetch', '--quiet', '--depth=1', '--no-tags', url, sha], checkout);
    await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], checkout);
    const { stdout } = await git(['rev-parse', 'HEAD'], checkout);
    if (stdout.trim() !== sha) throw new Error('Source checkout does not match the version commit');

    const source = path.join(checkout, entry.extensionId);
    const staged = path.join(checkout, 'candidate.json');
    const { stdout: packed } = await exec(process.execPath, [packer, source, staged], {
      cwd: path.dirname(packer), timeout: 90_000, maxBuffer: 1024 * 1024,
    });
    const metadata = JSON.parse(packed);
    if (metadata.version !== version) throw new Error(`Tag v${version} does not match extension.json version ${metadata.version}`);
    if ((await fs.stat(staged)).size > PAGES_ASSET_LIMIT) throw new Error('Candidate exceeds the Pages 25 MiB asset limit');
    await fs.copyFile(staged, target);
    return metadata;
  } finally {
    await fs.rm(checkout, { recursive: true, force: true });
  }
}

export async function scanExtensionReleases({ catalog, destination, readTags, pack = packReleaseCandidate }) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.releases) || !catalog.releases.length) throw new Error('Invalid or empty extension catalog');
  const entries = catalog.releases.map(entry => ({ entry, ...repositoryOf(entry) }));
  if (new Set(entries.map(({ entry }) => entry.packageKey)).size !== entries.length) throw new Error('Duplicate extension in the published catalog');
  await fs.mkdir(destination);
  const results = { schemaVersion: 1, unchanged: [], candidates: [], errors: [] };
  for (const { entry, url, publishedCommit } of entries) {
    try {
      const tags = parseReleaseTags(await readTags(url));
      if (tags.get(entry.version) !== publishedCommit) throw new Error(`Published tag v${entry.version} is missing or points to a different commit`);
      const versions = [...tags.keys()].filter(version => compareVersions(version, entry.version) > 0).sort(compareVersions);
      if (!versions.length) {
        results.unchanged.push({ packageKey: entry.packageKey, version: entry.version, sourceCommit: publishedCommit });
        continue;
      }
      const version = versions.at(-1);
      const sourceCommit = tags.get(version);
      const file = `${entry.extensionId}-${version}.json`;
      const candidate = await pack(entry, version, sourceCommit, path.join(destination, file));
      results.candidates.push({ ...candidate, packageKey: entry.packageKey, sourceCommit, file,
        previousFingerprints: [...new Set([entry.fingerprint, ...(entry.previousFingerprints ?? [])])],
        minHostVersion: entry.minHostVersion });
    } catch (error) {
      results.errors.push({ packageKey: entry.packageKey, error: error.message });
    }
  }
  await fs.writeFile(path.join(destination, 'candidates.json'), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx' });
  return results;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { values } = parseArgs({ options: { catalog: { type: 'string' }, output: { type: 'string' } } });
  if (!values.catalog || !values.output) throw new Error('Provide --catalog and --output');
  const result = await scanExtensionReleases({
    catalog: JSON.parse(await fs.readFile(values.catalog, 'utf8')),
    destination: path.resolve(values.output),
    readTags: readReleaseTags,
  });
  console.log(`${result.unchanged.length} published releases verified, ${result.candidates.length} new candidates, ${result.errors.length} failed sources`);
  for (const failure of result.errors) console.error(`${failure.packageKey}: ${failure.error}`);
  if (result.errors.length) process.exitCode = 1;
}
