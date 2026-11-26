// Opt-in Windows inventory probe: only aggregate types/counts are printed.
// Run: $env:MUSTER_TEST_CUA_APPS='1'; node test/desktop-cua-app-discovery-electron.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { acquireTestLease } from './helpers/lease.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

if (process.env.MUSTER_TEST_CUA_APPS !== '1') {
  console.log('Windows application discovery fixture skipped; set MUSTER_TEST_CUA_APPS=1 to run.');
} else {
  if (process.platform !== 'win32') throw new Error('This real desktop fixture requires Windows.');
  const release = acquireTestLease(process.cwd());
  const workspace = fs.realpathSync.native(process.cwd()), tmp = path.join(workspace, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const info = fs.lstatSync(tmp);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync.native(tmp).toLowerCase() !== tmp.toLowerCase()) {
    throw new Error('The workspace .tmp directory must be a real directory inside the checkout.');
  }
  for (const file of ['out/preload/desktopIndicator.js', 'out/renderer/desktop-indicator.html']) {
    if (!fs.existsSync(path.join(workspace, file))) throw new Error(`Missing built indicator asset: ${file}`);
  }
  const temp = fs.mkdtempSync(path.join(tmp, 'cua-apps-electron-'));
  try {
    const guardian = path.join(temp, 'agentSession', 'drivers', 'codex', 'worker', 'windows-job.ps1');
    fs.mkdirSync(path.dirname(guardian), { recursive: true });
    fs.copyFileSync('src/main/agentSession/drivers/codex/worker/windows-job.ps1', guardian);
    const fixture = path.join(temp, 'fixture.cjs');
    await build({ entryPoints: ['test/e2e/fixtures/desktop-cua-app-discovery-main.ts'], outfile: fixture,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi', 'sharp'], logLevel: 'silent' });
    const executable = createRequire(import.meta.url)('electron');
    const env = { ...process.env, MUSTER_TEST_USER_DATA: temp, TEMP: temp, TMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(executable, [fixture], { cwd: workspace, env, encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024 });
    const failure = (child.stderr ?? '').match(/CUA_APPS_FIXTURE_FAIL [a-z]+ [a-z_]+/)?.[0] ??
      (child.error?.code === 'ETIMEDOUT' ? 'CUA_APPS_FIXTURE_FAIL timeout' : 'CUA_APPS_FIXTURE_FAIL unexpected');
    assert.equal(child.status, 0, failure);
    const summary = (child.stdout ?? '').split(/\r?\n/).find(line => line.startsWith('CUA_APPS_FIXTURE_OK '));
    assert.ok(summary, 'The fixture did not emit a sanitized aggregate result');
    console.log(summary);
  } finally { removeWorkspaceFixture(temp, 'cua-apps-electron-'); release(); }
}
