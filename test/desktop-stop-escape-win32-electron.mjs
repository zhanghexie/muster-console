// Opt-in: opens two owned windows, installs the real Windows Escape hook,
// and sends synthetic input only to those windows.
// $env:MUSTER_TEST_STOP_ESCAPE='1'; node test/desktop-stop-escape-win32-electron.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { acquireTestLease } from './helpers/lease.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

if (process.env.MUSTER_TEST_STOP_ESCAPE !== '1') {
  console.log('Windows stop/Escape fixture skipped; set MUSTER_TEST_STOP_ESCAPE=1 to run it.');
} else {
  if (process.platform !== 'win32') throw new Error('This real desktop fixture requires Windows.');
  acquireTestLease(process.cwd());
  const workspace = fs.realpathSync.native(process.cwd());
  const tmp = path.join(workspace, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const stat = fs.lstatSync(tmp);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(tmp).toLowerCase() !== tmp.toLowerCase()) {
    throw new Error('The workspace .tmp directory must be a real directory inside the checkout.');
  }
  for (const file of ['out/preload/desktopIndicator.js', 'out/renderer/desktop-indicator.html', 'out/main/desktop/windows-escape-monitor.ps1']) {
    if (!fs.existsSync(path.join(workspace, file))) throw new Error(`Missing built desktop asset: ${file}`);
  }
  if (!fs.readFileSync(path.join(workspace, 'out/main/desktop/windows-escape-monitor.ps1')).equals(
    fs.readFileSync(path.join(workspace, 'src/main/desktop/windows-escape-monitor.ps1')))) {
    throw new Error('The built Escape monitor does not match the current source.');
  }
  const temp = fs.mkdtempSync(path.join(tmp, 'stop-escape-win32-'));
  try {
    const fixture = path.join(temp, 'fixture.cjs');
    await build({ entryPoints: ['test/e2e/fixtures/desktop-stop-escape-win32-main.ts'], outfile: fixture,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi'], logLevel: 'silent' });
    const executable = createRequire(import.meta.url)('electron');
    const env = { ...process.env, MUSTER_TEST_USER_DATA: temp, TEMP: temp, TMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    console.log(`STOP_FIXTURE_DIR ${temp}`);
    const child = spawnSync(executable, [fixture], { cwd: workspace, env, encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /STOP_ESCAPE_WIN32_OK/);
    console.log(child.stdout.trim());
  } finally { removeWorkspaceFixture(temp, 'stop-escape-win32-'); }
}
