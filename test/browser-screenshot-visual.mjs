/** Real Electron webview screenshot regression, owned isolated window; no live user app. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron, chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'webview-shot-'));
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const main = path.join(tmp, 'main.cjs');
let siteServer;
let guestUrl;
if (process.argv[2]) {
  const siteDir = path.resolve(process.argv[2]);
  siteServer = http.createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = path.resolve(siteDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (path.relative(siteDir, file).startsWith('..')) { res.writeHead(403).end(); return; }
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
  guestUrl = `http://127.0.0.1:${siteServer.address().port}/`;
}
// Electron's built-in module must be resolved by the Electron process itself.
const synthetic = '<body style="height:2200px;background:rgb(0,180,80)"><canvas></canvas><script>const g=document.querySelector("canvas").getContext("webgl2");function f(){g.clearColor(1,0,0,1);g.clear(g.COLOR_BUFFER_BIT);requestAnimationFrame(f)}f()</script>';
guestUrl ??= `data:text/html,${encodeURIComponent(synthetic)}`;
const hostHtml = `<webview style="width:800px;height:600px" src="${guestUrl}"></webview>`;
fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(tmp, 'userData'))});app.whenReady().then(async()=>{global.w=new BrowserWindow({show:false,webPreferences:{webviewTag:true}});await w.loadURL('data:text/html,'+encodeURIComponent(${JSON.stringify(hostHtml)}));});`);
await build({ entryPoints: [path.join(root, 'src/main/browser/cdpTypeProxy.ts')], outfile: path.join(tmp, 'proxy.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
let app, browser, proxy;
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [main, `--remote-debugging-port=${port}`], env, timeout: 15000 });
  await app.firstWindow();
  proxy = await require(path.join(tmp, 'proxy.cjs')).startCdpTypeProxy(port);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${proxy.port}`);
  let page;
  for (let i = 0; i < 50; i++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === guestUrl);
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(page, 'webview target discovered through production proxy');
  await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 10000 });
  await app.evaluate(({webContents}) => { for (const wc of webContents.getAllWebContents()) wc.setBackgroundThrottling(false); });
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('canvas').getContext('webgl2'))), true);
  for (const visible of [false, true]) {
    if (visible) await app.evaluate(() => global.w.show());
    for (const fullPage of [false, true]) {
      const png = await page.screenshot({ fullPage, timeout: 5000 });
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.ok(png.readUInt32BE(16) >= 780, 'full-page capture may exclude the native scrollbar');
      assert.ok(png.readUInt32BE(20) >= (fullPage && !siteServer ? 2200 : 600));
      console.log('ok webview WebGL screenshot', { visible, fullPage, bytes: png.length });
    }
  }
} finally {
  await browser?.close(); await proxy?.close(); await app?.close();
  if (siteServer) await new Promise(resolve => siteServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
