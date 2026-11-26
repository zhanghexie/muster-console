import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const script = path.join(repo, 'scripts', 'verify-release-signing-env.mjs');
const releaseEnv = {
  ...process.env,
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  RUNNER_OS: 'Windows'
};
const missing = spawnSync(process.execPath, [script, '--prepare'], { cwd: repo, env: releaseEnv, encoding: 'utf8' });
assert.notEqual(missing.status, 0);
assert.match(`${missing.stdout}\n${missing.stderr}`, /WIN_CSC_LINK/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-signing-env-'));
try {
  const githubEnv = path.join(temp, 'github-env');
  execFileSync(process.execPath, [script, '--prepare'], {
    cwd: repo,
    env: { ...releaseEnv, WIN_CSC_LINK: 'certificate.p12', WIN_CSC_KEY_PASSWORD: 'password', GITHUB_ENV: githubEnv },
    stdio: 'pipe'
  });
  assert.equal(fs.readFileSync(githubEnv, 'utf8'), 'CSC_LINK=certificate.p12\nCSC_KEY_PASSWORD=password\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('release-signing-env: ok');
