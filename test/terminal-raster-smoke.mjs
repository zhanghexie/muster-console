/**
 * 离屏 Electron：xterm 写入后按缓冲栅格化 PNG，断言不是黑图。
 * 用法：npx electron test/terminal-raster-smoke.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require('electron');

if (!app) {
  console.error('请用: npx electron test/terminal-raster-smoke.mjs');
  process.exit(1);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = path.join(root, 'test', 'fixtures', 'raster-smoke.html');
const outPng = path.join(os.tmpdir(), 'metaagent-raster-smoke.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 400,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  await win.loadFile(html);
  const started = Date.now();
  let result = null;
  while (Date.now() - started < 8000) {
    result = await win.webContents.executeJavaScript('window.__rasterSmoke || null');
    if (result) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  win.destroy();
  if (!result) {
    console.error('FAIL: 页面未产出栅格化结果');
    app.exit(1);
    return;
  }
  const { line0, line1, glyphs, lit, dataUrl } = result;
  const raw = Buffer.from(String(dataUrl).slice(String(dataUrl).indexOf(',') + 1), 'base64');
  fs.writeFileSync(outPng, raw);
  const okText = String(line0).includes('HelloCapture') && String(line1).includes('RED-LINE');
  const okImg = glyphs >= 8 && lit >= 20 && raw.length > 200;
  console.log(
    JSON.stringify(
      { line0, line1, glyphs, lit, pngBytes: raw.length, saved: outPng },
      null,
      2
    )
  );
  if (!okText) {
    console.error('FAIL: xterm 缓冲没有写入的文字');
    app.exit(1);
    return;
  }
  if (!okImg) {
    console.error('FAIL: 栅格化 PNG 仍像黑图', { glyphs, lit, pngBytes: raw.length });
    app.exit(1);
    return;
  }
  console.log('[ok] terminal-raster-smoke 缓冲有字且 PNG 非黑');
  app.exit(0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
