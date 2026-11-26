import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

// Real display pixels are used only in this isolated fixture; no pixels are printed.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-screen-runtime-electron-'));
try {
  const compiled = path.join(temp, 'compiled'), compile = createSharedCompiler(process.cwd(), compiled);
  const require = createRequire(import.meta.url), sharpDir = path.join(compiled, 'node_modules/sharp');
  fs.mkdirSync(sharpDir, { recursive: true });
  fs.writeFileSync(path.join(sharpDir, 'package.json'), JSON.stringify({ name: 'sharp', main: 'index.cjs' }));
  fs.writeFileSync(path.join(sharpDir, 'index.cjs'), `module.exports = require(${JSON.stringify(require.resolve('sharp'))});\n`);
  const url = p => pathToFileURL(compile(p)).href;
  const registry = url('main/desktop/displayRegistry.ts');
  const runtime = url('main/desktop/screenRuntime.ts');
  const audit = url('main/desktop/auditStore.ts');
  const artifacts = url('main/desktop/captureArtifacts.ts');
  const access = url('main/desktop/sessionCaptureAccess.ts');
  const decoder = url('main/desktop/pngDecoder.ts');
  const userData = path.join(temp, 'data'), script = path.join(temp, 'main.cjs');
  fs.writeFileSync(script, `
    const { app, screen, powerMonitor, desktopCapturer, nativeImage } = require('electron');
    const fs = require('node:fs');
    const path = require('node:path');
    app.setPath('userData', ${JSON.stringify(userData)});
    app.whenReady().then(async () => {
      const { ElectronDisplayRegistry } = await import(${JSON.stringify(registry)});
      const { DesktopScreenRuntime } = await import(${JSON.stringify(runtime)});
      const { DesktopAuditStore } = await import(${JSON.stringify(audit)});
      const { DesktopCaptureArtifacts } = await import(${JSON.stringify(artifacts)});
      const { prepareSessionCaptureDirectory } = await import(${JSON.stringify(access)});
      const { decodeDesktopPng } = await import(${JSON.stringify(decoder)});
      const displays = new ElectronDisplayRegistry(screen, powerMonitor);
      const surface = displays.refresh().surfaces[0];
      if (!surface) throw new Error('No safely identifiable display is available');
      let prompts = 0, reads = 0;
      const ui = { confirm: async () => { prompts++; return { confirmed: true, kind: 'allowOnce' }; } };
      const actor = { sessionId: 'fixture-worker', taskId: 'fixture-task', isCurrent: () => true };
      const host = new DesktopScreenRuntime({ sessions: { get: () => ({ name: 'Fixture' }) } }, ${JSON.stringify(userData)}, displays, ui,
        options => { reads++; return desktopCapturer.getSources(options); }, png => nativeImage.createFromBuffer(png));
      const result = await host.look(actor, surface.surfaceId, 60000);
      if (!fs.existsSync(result.path) || result.width < 1 || result.height < 1 || prompts !== 1 || reads !== 1) throw new Error('Capture or approval failed');
      const audit = new DesktopAuditStore(path.join(${JSON.stringify(userData)}, 'desktop/audit.sqlite'));
      const records = audit.list(actor.sessionId);
      if (!records.some(row => row.stage === 'capture-start' && row.result === 'dispatched') ||
          !records.some(row => row.stage === 'capture-result' && row.result === 'allowed')) throw new Error('Capture audit missing');
      const store = new DesktopCaptureArtifacts(prepareSessionCaptureDirectory(${JSON.stringify(userData)}, actor.sessionId), decodeDesktopPng);
      await store.remove(actor.taskId, result.artifactId);
      if (fs.existsSync(result.path)) throw new Error('Fixture capture was not removed');
      audit.close(); host.close(); displays.dispose();
      console.log('SCREEN_RUNTIME_RESULT ' + JSON.stringify({ width: result.width, height: result.height, prompts, reads, removed: true }));
      app.quit();
    }).catch(error => { console.error(error && error.stack || String(error)); app.exit(1); });
  `);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const output = execFileSync(require('electron'), [script], { cwd: temp, env, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
  const line = output.split(/\r?\n/).find(value => value.startsWith('SCREEN_RUNTIME_RESULT '));
  assert.ok(line, 'Electron did not return a screen runtime result');
  const result = JSON.parse(line.slice('SCREEN_RUNTIME_RESULT '.length));
  assert.ok(result.width > 0 && result.height > 0);
  assert.equal(result.prompts, 1); assert.equal(result.reads, 1); assert.equal(result.removed, true);
  console.log(`Electron screen runtime: ${result.width}x${result.height}, fixture consent and audit, artifact removed`);
} finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
