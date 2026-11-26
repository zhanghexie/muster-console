/** Production artifact HTML/CSP in a real sandbox iframe and a standalone browser page.
 * Uses SwiftShader WebGL2 for deterministic pixels; does not certify physical GPU drivers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-three-visual-'));
const output = path.resolve('output/playwright/ui-widget-three');
let browser, server;
try {
  const compile = createSharedCompiler(process.cwd(), temporary);
  const { buildUiArtifactHtml } = await import(pathToFileURL(compile('main/uiArtifacts.ts')).href);
  const fragment = fs.readFileSync('docs/prototypes/intelligent-ui/three-demo.fragment.html', 'utf8');
  const pages = {};
  for (const theme of ['dark', 'light']) for (const mode of ['inline', 'browser']) {
    pages[`/${mode}-${theme}`] = buildUiArtifactHtml({ title: '离线三维场景', html: fragment, mode }, theme).html;
  }
  const parent = `<!doctype html><style>body{margin:0}iframe{border:0;width:100%;height:430px}</style>
    <script>
    window.messages = [];
    addEventListener('message', event => {
      if (!event.data || event.data.__ma !== true) return;
      messages.push(event.data);
      if (event.data.type === 'ready') event.source.postMessage({__ma:true,v:2,type:'init',visible:true,
        state:{modelContent:null,privateContent:null,revision:0}}, '*');
    });
    </script><iframe sandbox="allow-scripts"></iframe>`;
  const requests = [];
  server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url === '/parent' ? parent : pages[request.url] || 'unknown');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext();
  // Font providers are the only permitted external resources; block them in this offline probe.
  await context.route('https://**', route => route.abort());
  fs.mkdirSync(output, { recursive: true });
  for (const [mode, theme, width] of [['inline', 'dark', 320], ['inline', 'light', 780], ['browser', 'dark', 780], ['browser', 'light', 320]]) {
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 500 });
    let surface;
    if (mode === 'inline') {
      await page.goto(origin + '/parent');
      await page.locator('iframe').evaluate((frame, url) => { frame.src = url; }, origin + `/${mode}-${theme}`);
      surface = page.frames().find(frame => frame !== page.mainFrame());
      await surface.waitForURL(origin + `/${mode}-${theme}`);
    } else {
      await page.goto(origin + `/${mode}-${theme}`); surface = page.mainFrame();
    }
    await surface.waitForFunction(() => document.getElementById('three-status').textContent.includes('离线运行'));
    assert.equal(await surface.evaluate(() => maUi.three === THREE && maUi.three.REVISION === '186' && !!maUi.d3), true);
    // Observe the actual demo controls on their next animation tick, without substituting them.
    await surface.evaluate(() => {
      const update = maUi.three.OrbitControls.prototype.update;
      maUi.three.OrbitControls.prototype.update = function (...args) {
        window.__probeControls = this;
        return update.apply(this, args);
      };
    });
    await surface.waitForFunction(() => !!window.__probeControls);
    const view = surface.locator('#three-view');
    const canvas = view.locator('canvas');
    await surface.waitForFunction(() => {
      const canvas = document.querySelector('#three-view canvas');
      return canvas.width === Math.round(canvas.parentElement.clientWidth * Math.min(devicePixelRatio, 2));
    });
    const before = await canvas.screenshot();
    const png = PNG.sync.read(before);
    let colored = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i + 1] > png.data[i] + 25 && png.data[i + 1] > png.data[i + 2] + 10) colored++;
    }
    assert.ok(colored > 500, `${mode}/${theme}/${width}: real WebGL renders a green cube`);
    assert.equal(await surface.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'narrow scene fits the container');
    const box = await view.boundingBox();
    if (mode === 'inline') {
      assert.equal(await surface.evaluate(() => window.__probeControls.enableZoom), false, 'unfocused demo leaves wheel zoom disabled');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const wheels = await page.evaluate(() => messages.filter(item => item.type === 'wheel').length);
      await page.mouse.wheel(0, 80);
      await page.waitForFunction(previous => messages.filter(item => item.type === 'wheel').length > previous, wheels);
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 55, box.y + box.height / 2 + 30, { steps: 10 });
    await page.mouse.up();
    const after = await canvas.screenshot();
    assert.ok(!before.equals(after), 'real pointer drag changes the rendered camera view');
    assert.equal(await surface.evaluate(() => document.activeElement.id), 'three-view');
    assert.equal(await surface.evaluate(() => window.__probeControls.enableZoom), true);
    await page.screenshot({ path: path.join(output, `${mode}-${theme}-${width}.png`) });
    if (mode === 'inline') {
      const wheels = await page.evaluate(() => messages.filter(item => item.type === 'wheel').length);
      const distance = await surface.evaluate(() => window.__probeControls.object.position.length());
      await page.mouse.wheel(0, 80);
      await surface.waitForFunction(previous => window.__probeControls.object.position.length() > previous + 0.1, distance);
      assert.equal(await page.evaluate(() => messages.filter(item => item.type === 'wheel').length), wheels, 'focused local wheel does not scroll the chat');
      // Move focus within the iframe, so local zoom cannot keep consuming chat wheel events.
      await surface.evaluate(() => {
        const status = document.getElementById('three-status'); status.tabIndex = 0; status.focus();
      });
      assert.equal(await surface.evaluate(() => window.__probeControls.enableZoom), false, 'blur disables local zoom');
    }
    const violations = await surface.evaluate(async () => {
      const violations = [];
      const receive = event => violations.push(event.violatedDirective);
      addEventListener('securitypolicyviolation', receive);
      const script = document.createElement('script'); script.src = '/blocked.js'; document.body.appendChild(script);
      await fetch('/blocked-api').catch(() => {});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      removeEventListener('securitypolicyviolation', receive);
      return violations;
    });
    assert.ok(violations.includes('script-src-elem') && violations.includes('connect-src'), 'CSP still blocks external scripts and fetch');
    assert.deepEqual(errors, [], 'no author/runtime JavaScript errors');
    console.log(`passed ${mode}/${theme}/${width}: WebGL pixels, drag, resize, CSP${mode === 'inline' ? ', wheel routing' : ''}`);
    await page.close();
  }
  assert.ok(!requests.some(url => url.startsWith('/blocked')), 'blocked scripts/API never reach the server');
  console.log(`ui-widget-three-visual: software WebGL2 passed; screenshots ${output}`);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
