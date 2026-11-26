import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-stop-assets-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { buildDesktopStopAssets } = await import(pathToFileURL(compile('main/desktop/buildStopAssets.ts')));
  const { unixEscapeWorkerPath } = await import(pathToFileURL(compile('main/desktop/unixEscapeMonitor.ts')));
  const { waylandStopHelperPath } = await import(pathToFileURL(compile('main/desktop/waylandStopIndicator.ts')));
  const config = createRequire(import.meta.url)('yaml').parse(fs.readFileSync('electron-builder.yml', 'utf8'));
  await buildDesktopStopAssets(process.cwd(), temp);
  const directory = path.join(temp, 'out', 'main', 'desktop');
  const worker = path.join(directory, 'unix-escape-worker.cjs');
  const helper = path.join(directory, 'waylandStopHelper.py');
  assert.ok(fs.statSync(worker).size > 1000, 'the process worker must be a bundled file');
  assert.deepEqual(fs.readFileSync(helper), fs.readFileSync('src/main/desktop/waylandStopHelper.py'));
  for (const name of ['out/main/desktop/unix-escape-worker.cjs', 'out/main/desktop/waylandStopHelper.py']) {
    assert.ok(config.asarUnpack.includes(name), `${name} must be usable by an OS child process`);
  }
  assert.equal(unixEscapeWorkerPath(path.join(temp, 'out', 'main')), worker);
  assert.equal(waylandStopHelperPath(path.join(temp, 'out', 'main')), helper);
  const archiveMain = path.join(temp, 'resources', 'app.asar', 'out', 'main');
  assert.equal(unixEscapeWorkerPath(archiveMain), path.join(temp, 'resources', 'app.asar.unpacked', 'out', 'main', 'desktop', 'unix-escape-worker.cjs'));
  assert.equal(waylandStopHelperPath(archiveMain), path.join(temp, 'resources', 'app.asar.unpacked', 'out', 'main', 'desktop', 'waylandStopHelper.py'));
  assert.throws(() => unixEscapeWorkerPath('relative'), /absolute/);
  assert.throws(() => waylandStopHelperPath('relative'), /absolute/);
  console.log('Desktop stop assets: real worker bundle, helper copy and unpacked paths passed');
} finally { removeWorkspaceFixture(temp, 'desktop-stop-assets-'); }
