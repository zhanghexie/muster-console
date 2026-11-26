/** Run after npm run build: validate the built helper with Electron's Node ABI. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-inventory-electron-'));
try {
  const compile = createSharedCompiler(root, path.join(temp, 'compiled'));
  const { runDesktopInventory } = await import(pathToFileURL(compile('main/desktop/inventoryProcess.ts')));
  const { desktopRuntime } = await import(pathToFileURL(compile('main/desktop/runtime.ts')));
  const runtime = desktopRuntime(process.platform, process.env);
  if (!['windows', 'macos', 'linux-x11'].includes(runtime)) {
    console.log(`desktop inventory Electron: ${runtime} not supported; native test skipped`);
  } else {
    const workerFile = path.join(root, 'out', 'main', 'desktop', 'inventory-worker.cjs');
    assert.ok(fs.existsSync(workerFile), 'run npm run build to generate the helper');
    const electron = createRequire(import.meta.url)('electron');
    const result = await runDesktopInventory({ workerFile, limit: 50, timeoutMs: 15_000,
      launch: (file, args, options) => fork(file, args, { ...options, execPath: electron }) });
    assert.equal(result.runtime, runtime);
    assert.ok(result.observations.every(item => !('nativeHandle' in item)));
    console.log(`desktop inventory Electron: ${runtime} child returned ${result.observations.length} metadata observations`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
