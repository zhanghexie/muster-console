// Opt-in, real Windows desktop test. Opens and operates only its own Electron window.
// Run: $env:MUSTER_TEST_SCREEN_VISIBLE='1'; node test/desktop-screen-win32-visible-electron.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { acquireTestLease } from './helpers/lease.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

if (process.env.MUSTER_TEST_SCREEN_VISIBLE !== '1') {
  console.log('Windows visible screen fixture skipped; set MUSTER_TEST_SCREEN_VISIBLE=1 to run it.');
} else {
  if (process.platform !== 'win32') throw new Error('This real desktop fixture requires Windows.');
  acquireTestLease(process.cwd());
  const workspace = fs.realpathSync.native(process.cwd());
  const tmp = path.join(workspace, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const tmpInfo = fs.lstatSync(tmp);
  if (!tmpInfo.isDirectory() || tmpInfo.isSymbolicLink() || fs.realpathSync.native(tmp).toLowerCase() !== tmp.toLowerCase()) {
    throw new Error('The workspace .tmp directory must be a real directory inside the checkout.');
  }
  for (const file of ['out/preload/desktopIndicator.js', 'out/renderer/desktop-indicator.html']) {
    if (!fs.existsSync(path.join(workspace, file))) throw new Error(`Missing built indicator asset: ${file}`);
  }
  const temp = fs.mkdtempSync(path.join(tmp, 'screen-win32-visible-'));
  try {
    const fixture = path.join(temp, 'fixture.cjs');
    await build({ entryPoints: ['test/e2e/fixtures/desktop-screen-win32-visible-main.ts'], outfile: fixture,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi', 'sharp'], logLevel: 'silent' });
    const executable = createRequire(import.meta.url)('electron');
    const env = { ...process.env, MUSTER_TEST_USER_DATA: temp, TEMP: temp, TMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    console.log(`SCREEN_FIXTURE_DIR ${temp}`);
    const child = spawnSync(executable, [fixture], { cwd: workspace, env, encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /SCREEN_WIN32_VISIBLE_OK/);
    console.log(child.stdout.trim());
  } finally { removeWorkspaceFixture(temp, 'screen-win32-visible-'); }
}
