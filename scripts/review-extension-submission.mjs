import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { githubReleaseUrl, PAGES_ASSET_LIMIT, readPinnedGithubAsset } from './build-extension-center-mirror.mjs';
import { parseReleaseTags, readReleaseTags } from './extension-version-tags.mjs';
import { withExtensionPackageSnapshot } from './pack-extension-release.mjs';

const packageFile = 'candidate.json';
const reportFile = 'review.json';
const javascriptLoaders = new Map([['.js', 'js'], ['.mjs', 'js'], ['.cjs', 'js'], ['.jsx', 'jsx'],
  ['.ts', 'ts'], ['.mts', 'ts'], ['.cts', 'ts'], ['.tsx', 'tsx']]);

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readReviewFile(file, maxBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Invalid review file: ${path.basename(file)}`);
  return fs.readFile(file);
}

export async function inspectSubmissionPackage(bytes, version, { checkSyntax = true } = {}) {
  if (bytes.length > PAGES_ASSET_LIMIT) throw new Error('Package exceeds the Pages 25 MiB asset limit');
  const artifact = JSON.parse(bytes.toString('utf8'));
  if (artifact?.schemaVersion !== 1 || typeof artifact.extensionId !== 'string' || typeof artifact.fingerprint !== 'string' ||
      !Array.isArray(artifact.directories) || !Array.isArray(artifact.files) || artifact.files.length > 20_000) {
    throw new Error('Invalid extension release package');
  }
  const files = artifact.files.map(file => {
    if (typeof file?.path !== 'string' || typeof file.bytesBase64 !== 'string' ||
        (file.executable !== undefined && typeof file.executable !== 'boolean')) throw new Error('Invalid package file');
    const contents = Buffer.from(file.bytesBase64, 'base64');
    if (contents.toString('base64') !== file.bytesBase64) throw new Error(`Invalid file encoding: ${JSON.stringify(file.path)}`);
    return { path: file.path, bytes: contents, executable: file.executable === true };
  });
  const snapshot = { directories: artifact.directories, files, excluded: [], fingerprint: artifact.fingerprint };
  const manifest = await withExtensionPackageSnapshot(({ validateExtensionPackage }) => validateExtensionPackage(snapshot, artifact.extensionId));
  if (manifest.scope !== 'global' || manifest.version !== version) throw new Error('Manifest must have global scope and match the release tag');
  const directories = new Set(artifact.directories);
  for (const relative of [...directories, ...files.map(file => file.path)]) {
    const parent = path.posix.dirname(relative);
    if (parent !== '.' && !directories.has(parent)) throw new Error(`Missing package directory: ${JSON.stringify(parent)}`);
  }

  let syntaxChecked = 0;
  if (checkSyntax) {
    const { transform } = await import('esbuild');
    for (const file of files) {
      const loader = javascriptLoaders.get(path.posix.extname(file.path).toLowerCase());
      if (!loader) continue;
      try { await transform(file.bytes.toString('utf8'), { loader, logLevel: 'silent', target: 'esnext' }); }
      catch (error) {
        const line = error.errors?.[0]?.location?.line;
        throw new Error(`Could not parse ${JSON.stringify(file.path)}${line ? ` at line ${line}` : ''}`);
      }
      syntaxChecked++;
    }
  }
  return { manifest, snapshot, fingerprint: artifact.fingerprint, syntaxChecked, fileCount: files.length };
}

export async function reviewExtensionSubmission({ repository, version, commit, output, fetchImpl = fetch, readTags = readReleaseTags }) {
  const match = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})\/?$/i.exec(repository);
  if (!match || ['.', '..'].includes(match[2]) || match[1].toLowerCase() === 'muster') throw new Error('Expected a public community GitHub repository URL');
  if (!/^[0-9a-f]{40}$/.test(commit) || !/^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/.test(version)) {
    throw new Error('Expected a pinned commit SHA and a stable version');
  }
  const publisherId = match[1].toLowerCase();
  const repositoryUrl = `https://github.com/${publisherId}/${match[2]}`;
  const tags = parseReleaseTags(await readTags(`${repositoryUrl}.git`));
  if (tags.get(version) !== commit) throw new Error('Release tag does not point to the submitted commit');
  const url = new URL(`https://api.github.com/repos/${publisherId}/${match[2]}/contents/releases/${version}.json`);
  url.searchParams.set('ref', commit);
  const bytes = await readPinnedGithubAsset(url, fetchImpl);
  const { manifest, fingerprint, fileCount, syntaxChecked } = await inspectSubmissionPackage(bytes, version);
  const release = { packageKey: `${publisherId}/${manifest.id}`, publisherId, extensionId: manifest.id,
    name: manifest.name, ...(manifest.description ? { description: manifest.description } : {}), version, fingerprint,
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    repositoryUrl, packageUrl: url.href, sha256: digest(bytes) };
  githubReleaseUrl(release, true);
  const report = { schemaVersion: 1, sourceCommit: commit, release, bytes: bytes.length, fileCount, syntaxChecked,
    permissions: manifest.permissions, surface: manifest.surface, domainEntry: manifest.domain?.entry,
    commandEntry: manifest.commandEntry, mcp: manifest.agent?.mcp ?? [] };
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, packageFile), bytes, { flag: 'wx' });
  await fs.writeFile(path.join(output, reportFile), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

export async function prepareExtensionReviewCatalog(folder) {
  const candidate = path.resolve(folder, packageFile);
  const report = JSON.parse(await readReviewFile(path.resolve(folder, reportFile), 4 * 1024 * 1024));
  if (report?.schemaVersion !== 1 || githubReleaseUrl(report.release, true).searchParams.get('ref') !== report.sourceCommit) {
    throw new Error('Invalid candidate review report');
  }
  if (digest(await readReviewFile(candidate, PAGES_ASSET_LIMIT)) !== report.release.sha256) {
    throw new Error('Candidate does not match the reviewed package digest');
  }
  const catalog = path.resolve(folder, 'preview-catalog.json');
  const release = { ...report.release, packageUrl: pathToFileURL(candidate).href };
  const content = `${JSON.stringify({ schemaVersion: 1, releases: [release] }, null, 2)}\n`;
  try { await fs.writeFile(catalog, content, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readReviewFile(catalog, 4 * 1024 * 1024)).equals(Buffer.from(content))) throw error;
  }
  return pathToFileURL(catalog).href;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, version: { type: 'string' }, commit: { type: 'string' },
    output: { type: 'string' }, preview: { type: 'string' } } });
  if (values.preview) console.log(await prepareExtensionReviewCatalog(values.preview));
  else {
    if (!values.repository || !values.version || !values.commit || !values.output) throw new Error('Provide --repository, --version, --commit and --output');
    const report = await reviewExtensionSubmission(values);
    console.log(`Checked ${report.fileCount} files and parsed ${report.syntaxChecked} JavaScript/TypeScript files.`);
  }
}
