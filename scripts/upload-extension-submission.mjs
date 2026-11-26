import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseReleaseTags } from './extension-version-tags.mjs';
import { withExtensionPackageSnapshot } from './pack-extension-release.mjs';

const exec = promisify(execFile);

export function extensionRepository(value) {
  const match = typeof value === 'string' && /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})\/?$/i.exec(value.trim());
  if (!match || ['.', '..'].includes(match[2]) || match[1].toLowerCase() === 'muster') throw new Error('Enter your public GitHub repository URL');
  return new URL(`https://github.com/${match[1].toLowerCase()}/${match[2]}`);
}

export function assertPublicExtensionFiles(snapshot) {
  const privateName = /^(?:\.git|\.muster|\.metaagent|node_modules|local|data|cache|runtime\.json|user\.md|\.npmrc|\.env(?!\.example$|\.sample$)(?:\..*)?)$/i;
  for (const file of snapshot.files) {
    if (file.path.split('/').some(segment => privateName.test(segment)) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(file.bytes.toString('utf8'))) {
      throw new Error(`Remove private material from the extension before uploading: ${JSON.stringify(file.path)}`);
    }
  }
}

/** Git writes only the captured extension and artifact to the author's authorized repository. */
export async function uploadExtensionSubmission({ repositoryUrl, branch, token, transport, previous, manifest, snapshot, bytes }) {
  const url = extensionRepository(repositoryUrl);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/.test(branch)) throw new Error('Cannot use the repository default branch');
  assertPublicExtensionFiles(snapshot);
  const remote = transport ?? `${url.href}.git`;
  const tag = `v${manifest.version}`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_COUNT: '0' };
  // Pass authorization in process-local Git config and limit it to GitHub HTTPS.
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muster-extension-upload-'));
  const git = async (...args) => {
    try {
      const { stdout } = await exec('git', ['-c', 'core.hooksPath=.git/muster-no-hooks', '-c', 'http.followRedirects=false', ...args], {
        cwd: directory, env, timeout: 90_000, maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      const reason = `${error.stderr ?? ''}`;
      if (/(denied|authentication|forbidden|403|401|not found)/i.test(reason)) throw new Error('GitHub denied the write. Authorize this repository and retry.');
      throw new Error(`GitHub operation failed (${args[0]}). Check that the repository and its default branch allow submissions.`);
    }
  };
  try {
    const refs = await git('ls-remote', '--heads', '--tags', remote);
    const existing = parseReleaseTags(refs).get(manifest.version);
    if (existing) return { commit: existing, existing: true };
    if (!previous && refs) throw new Error('For the first submission, use an empty public repository');
    await git('init', '--quiet', `--initial-branch=${branch}`);
    if (previous) {
      if (parseReleaseTags(refs).get(previous.version) !== previous.commit) throw new Error('The previous version tag changed or disappeared');
      await git('fetch', '--quiet', '--depth=1', '--no-tags', remote, `refs/heads/${branch}`);
      await git('reset', '--quiet', '--hard', 'FETCH_HEAD');
      await fs.rm(path.join(directory, manifest.id), { recursive: true, force: true });
    }
    await withExtensionPackageSnapshot(({ writeExtensionPackageDirectoryAsync }) =>
      writeExtensionPackageDirectoryAsync(path.join(directory, manifest.id), snapshot));
    const releases = path.join(directory, 'releases');
    await fs.mkdir(releases, { recursive: true });
    if (!(await fs.lstat(releases)).isDirectory()) throw new Error('The repository releases path must be a real directory');
    const artifact = `releases/${manifest.version}.json`;
    await fs.writeFile(path.join(directory, artifact), bytes, { flag: 'wx' });
    await git('add', '--force', '--', manifest.id, artifact);
    await git('-c', 'user.name=Muster Publishing', '-c', 'user.email=muster-publishing@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `${manifest.id} ${tag}`);
    const commit = await git('rev-parse', 'HEAD');
    await git('-c', 'tag.gpgSign=false', 'tag', tag);
    await git('push', '--atomic', remote, `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`);
    return { commit, existing: false };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
