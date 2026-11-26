// Real desktop test. Opens and operates only its own Electron windows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { acquireTestLease } from './helpers/lease.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

if (process.env.MUSTER_TEST_MAC_DESKTOP !== '1') {
  console.log('macOS desktop fixture skipped; set MUSTER_TEST_MAC_DESKTOP=1 to run.');
} else {
  assert.equal(process.platform, 'darwin');
  const release = acquireTestLease(process.cwd());
  const temp = fs.mkdtempSync(path.resolve('.tmp', 'mac-desktop-electron-'));
  try {
    const fixture = path.join(temp, 'fixture.cjs');
    await build({ entryPoints: ['test/e2e/fixtures/desktop-mac-control-main.ts'], outfile: fixture,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', external: ['electron'], logLevel: 'silent' });
    const env = { ...process.env, MUSTER_TEST_USER_DATA: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(createRequire(import.meta.url)('electron'), [fixture], { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /MAC_DESKTOP_FIXTURE_OK/);
    console.log(child.stdout.trim());
  } finally { removeWorkspaceFixture(temp, 'mac-desktop-electron-'); release(); }
}
