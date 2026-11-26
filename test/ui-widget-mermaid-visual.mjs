/** Real Chromium evidence for Mermaid in an interactive UI artifact. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-mermaid-visual-'));
const output = path.resolve('output/playwright/ui-widget-mermaid');
let browser, server;
try {
  const compile = createSharedCompiler(process.cwd(), temporary);
  const { buildUiArtifactHtml } = await import(pathToFileURL(compile('main/uiArtifacts.ts')).href);
  const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#8b7bff"/></svg>').toString('base64');
  const diagram = `<img id="inline-image" alt="内嵌图片" src="data:image/svg+xml;base64,${image}"><pre class="mermaid">flowchart LR\n  A[开始] --> B{可见}\n  B -->|是| C[完成]</pre>`;
  const pages = {
    '/standalone-dark': buildUiArtifactHtml({ title: 'Mermaid', html: diagram }, 'dark').html,
    '/standalone-light': buildUiArtifactHtml({ title: 'Mermaid', html: diagram }, 'light').html
  };
  const parent = `<!doctype html><style>body{margin:0}iframe{border:0;width:100%;height:360px}</style>
    <script>window.messages=[];addEventListener('message',event=>{if(!event.data||event.data.__ma!==true)return;messages.push(event.data);if(event.data.type==='ready')event.source.postMessage({__ma:true,v:2,type:'init',visible:true,state:{modelContent:null,privateContent:null,revision:0}},'*')});</script>
    <iframe sandbox="allow-scripts"></iframe>`;
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url === '/parent' ? parent : pages[request.url] || 'unknown');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
    args: ['--disable-gpu']
  });
  const context = await browser.newContext();
  await context.route('https://**', route => route.abort());
  fs.mkdirSync(output, { recursive: true });
  for (const [theme, width] of [['dark', 320], ['light', 780]]) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 420 });
    await page.goto(origin + `/standalone-${theme}`);
    await page.locator('pre.mermaid svg').waitFor();
    const host = page.locator('pre.mermaid');
    await expectState(host, theme);
    assert.equal(await page.locator('#inline-image').evaluate(image => image.naturalWidth > 0), true, `${theme}/${width}: data URI image renders`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme}/${width}: no page overflow`);
    assert.equal(await page.locator('pre.mermaid svg').count(), 1);
    assert.equal(await page.locator('pre.mermaid svg').getAttribute('viewBox') !== null, true);
    await page.screenshot({ path: path.join(output, `standalone-${theme}-${width}.png`) });
    assert.deepEqual(errors, [], `${theme}/${width}: no runtime errors`);
    await page.close();
  }
  const inline = await context.newPage();
  await inline.setViewportSize({ width: 780, height: 420 });
  await inline.goto(origin + '/parent');
  await inline.locator('iframe').evaluate((frame, url) => { frame.src = url; }, origin + '/standalone-dark');
  const frame = inline.frames().find(candidate => candidate !== inline.mainFrame());
  assert.ok(frame);
  await frame.locator('pre.mermaid svg').waitFor();
  await inline.waitForFunction(() => messages.some(item => item.type === 'resize' && item.height > 0));
  assert.equal(await frame.locator('pre.mermaid').getAttribute('data-ma-mermaid-state'), 'rendered');
  await inline.screenshot({ path: path.join(output, 'inline-dark-780.png') });
  await inline.close();
  await context.close();
  console.log(`ui-widget-mermaid-visual: Chromium rendered dark/light and inline Mermaid; screenshots ${output}`);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}

async function expectState(host, theme) {
  assert.equal(await host.getAttribute('data-ma-mermaid-state'), 'rendered', `${theme}: Mermaid should render`);
  const background = await host.evaluate(element => getComputedStyle(element).getPropertyValue('--pele-bg').trim());
  assert.equal(background, theme === 'dark' ? '#262629' : '#ffffff');
}
