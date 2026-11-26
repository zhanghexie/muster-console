import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

// This integration test obtains thumbnails of all displays, never prints pixels,
// and retracts the fixture artifact before exit. Run only in an authorized test session.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-display-electron-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const artifactsUrl = pathToFileURL(compile('main/desktop/captureArtifacts.ts')).href;
  const registryUrl = pathToFileURL(compile('main/desktop/displayRegistry.ts')).href;
  const authorityUrl = pathToFileURL(compile('main/desktop/screenReadAuthority.ts')).href;
  const journalUrl = pathToFileURL(compile('main/desktop/dispatchJournal.ts')).href;
  const serviceUrl = pathToFileURL(compile('main/desktop/displayService.ts')).href;
  const captureUrl = pathToFileURL(compile('main/desktop/displayCapture.ts')).href;
  const script = path.join(temp, 'main.cjs');
  fs.writeFileSync(script, `
    const { app, screen, powerMonitor, desktopCapturer, nativeImage } = require('electron');
    const fs = require('node:fs');
    const path = require('node:path');
    app.setPath('userData', ${JSON.stringify(path.join(temp, 'userData'))});
    app.whenReady().then(async () => {
      const bitmap = Buffer.alloc(4 * 4 * 4);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        bitmap[i] = x * 50; bitmap[i + 1] = y * 50; bitmap[i + 2] = (x + y) * 25; bitmap[i + 3] = 255;
      }
      const hidpi = nativeImage.createFromBitmap(bitmap, { width: 4, height: 4, scaleFactor: 2 });
      const normalized = nativeImage.createFromBuffer(hidpi.toPNG());
      const probeRegion = { x: 1, y: 1, width: 1, height: 1 };
      const { captureDisplay } = await import(${JSON.stringify(captureUrl)});
      let probePng;
      const synthetic = await captureDisplay({ getSources: async () => [{ display_id: '1', thumbnail: hidpi }],
        normalizePng: png => nativeImage.createFromBuffer(png), confirmAllDisplays: async () => true, audit: async () => {},
        artifacts: { create: async (_task, png) => { probePng = png; return { artifactId: 'probe', path: 'probe', mimeType: 'image/png', width: 1, height: 1, capturedAt: 1, expiresAt: 2 }; }, remove: async () => {} }
      }, { taskId: 'probe', surfaceId: 'surface', surfaceGeneration: 'generation', geometryRevision: 'geometry', displayId: 1,
        bounds: { x: 0, y: 0, width: 4, height: 4 }, scaleFactor: 1 }, () => true, 1000, undefined, probeRegion);
      const actual = nativeImage.createFromBuffer(probePng), expected = normalized.crop(probeRegion);
      if (synthetic.sourceSize.width !== normalized.getSize().width || synthetic.sourceSize.height !== normalized.getSize().height ||
          JSON.stringify(actual.getSize()) !== JSON.stringify(expected.getSize()) || !actual.toBitmap().equals(expected.toBitmap()))
        throw new Error('High-DPI capture did not use the returned PNG pixel coordinates');
      const { DesktopCaptureArtifacts } = await import(${JSON.stringify(artifactsUrl)});
      const { ElectronDisplayRegistry } = await import(${JSON.stringify(registryUrl)});
      const { ScreenReadAuthority } = await import(${JSON.stringify(authorityUrl)});
      const { DesktopDispatchJournal } = await import(${JSON.stringify(journalUrl)});
      const { DesktopDisplayService } = await import(${JSON.stringify(serviceUrl)});
      const registry = new ElectronDisplayRegistry(screen, powerMonitor);
      const surface = registry.refresh().surfaces[0];
      if (!surface) throw new Error('No safely identifiable display is available');
      const target = registry.captureTarget('fixture-task', surface.surfaceId);
      const store = new DesktopCaptureArtifacts(${JSON.stringify(path.join(temp, 'captures'))}, async data => {
        const image = nativeImage.createFromBuffer(data);
        if (image.isEmpty()) throw new Error('Electron cannot decode the capture');
        return image.getSize();
      });
      const authority = new ScreenReadAuthority(new DesktopDispatchJournal(${JSON.stringify(path.join(temp, 'journal'))}),
        async () => true, async () => {});
      const service = new DesktopDisplayService(registry, authority, opts => desktopCapturer.getSources(opts),
        () => store, async () => {}, png => nativeImage.createFromBuffer(png));
      const result = await service.look({ sessionId: 'fixture-session', taskId: target.taskId, isCurrent: () => true }, target.surfaceId, 60000);
      if (!fs.existsSync(result.path)) throw new Error('Capture artifact missing');
      const region = { x: 0, y: 0, width: Math.min(100, result.width), height: Math.min(80, result.height) };
      const crop = await service.look({ sessionId: 'fixture-session', taskId: target.taskId, isCurrent: () => true }, target.surfaceId, 60000, undefined, region,
        { intervalMs: 100, timeoutMs: 500 });
      const cropSize = nativeImage.createFromPath(crop.path).getSize();
      if (cropSize.width !== region.width || cropSize.height !== region.height ||
          crop.region.width !== region.width || crop.region.height !== region.height) throw new Error('Capture region did not match the returned image');
      await store.remove(target.taskId, result.artifactId);
      await store.remove(target.taskId, crop.artifactId);
      registry.dispose();
      if (fs.existsSync(result.path) || fs.existsSync(crop.path)) throw new Error('Capture artifact cleanup failed');
      console.log('DISPLAY_CAPTURE_RESULT ' + JSON.stringify({ width: result.width, height: result.height, cropWidth: cropSize.width, cropHeight: cropSize.height, stability: crop.stability, removed: true }));
      app.quit();
    }).catch(error => { console.error(error && error.stack || String(error)); app.exit(1); });
  `);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const output = execFileSync(electron, [script], { cwd: temp, env, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
  const line = output.split(/\r?\n/).find(value => value.startsWith('DISPLAY_CAPTURE_RESULT '));
  assert.ok(line, 'Electron did not return a capture result');
  const result = JSON.parse(line.slice('DISPLAY_CAPTURE_RESULT '.length));
  assert.ok(result.width > 0 && result.height > 0);
  assert.equal(result.cropWidth, Math.min(100, result.width));
  assert.equal(result.cropHeight, Math.min(80, result.height));
  assert.ok(['observed_stable', 'timeout'].includes(result.stability.status));
  assert.ok(result.stability.samples >= 1);
  assert.equal(result.removed, true);
  console.log(`Electron screen capture: ${result.width}x${result.height}, fixture artifact removed`);
} finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
