import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

if (process.env.MUSTER_TEST_CUA_VISIBLE !== '1') {
  console.log('Cua visible Electron: skipped (set MUSTER_TEST_CUA_VISIBLE=1 for the Windows desktop fixture)');
} else {
  if (process.platform !== 'win32') throw new Error('The real Cua Electron fixture currently requires Windows');
  const electron = createRequire(import.meta.url)('electron');
  fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
  const temp = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'cua-visible-electron-'));
  try {
    const guardian = path.join(temp, 'agentSession', 'drivers', 'codex', 'worker', 'windows-job.ps1');
    fs.mkdirSync(path.dirname(guardian), { recursive: true });
    fs.copyFileSync('src/main/agentSession/drivers/codex/worker/windows-job.ps1', guardian);
    const fixture = path.join(temp, 'fixture.cjs');
    await build({ entryPoints: ['test/e2e/fixtures/desktop-cua-visible-main.ts'], outfile: fixture, bundle: true,
      platform: 'node', format: 'cjs', external: ['electron', 'koffi', 'sharp', '@modelcontextprotocol/sdk/*'], logLevel: 'silent' });
    const env = { ...process.env, MUSTER_TEST_USER_DATA: temp, TEMP: temp, TMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(electron, [fixture], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /CUA_VISIBLE_ELECTRON_OK/);
    console.log(child.stdout.trim());
  } finally { removeWorkspaceFixture(temp, 'cua-visible-electron-'); }
}
