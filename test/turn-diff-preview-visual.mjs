/** Production hover preview: four-sided rim must paint above opaque, scrollable Diff content. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { acquireTestLease } from './helpers/lease.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = acquireTestLease(root);
const output = path.join(root, '.tmp/turn-diff-preview-visual');
fs.mkdirSync(output, { recursive: true });
let browser, server;
const pixel = (png, x, y) => [...png.data.subarray((Math.floor(y) * png.width + Math.floor(x)) * 4, (Math.floor(y) * png.width + Math.floor(x)) * 4 + 3)];
try {
  await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import './src/renderer/src/i18n';
    import './src/renderer/src/styles/base.css'; import './src/renderer/src/styles/git.css'; import './src/renderer/src/styles/turn-changes.css';
    import {applyTheme} from './src/renderer/src/theme'; import {builtinTheme} from './src/shared/theme';
    import {TurnDiffPreview} from './src/renderer/src/chatSurface/TurnDiffPreview';
    window.api={turnChanges:{diff:async()=>({ok:true,diff:'diff --git a/README.md b/README.md\\nnew file mode 100644\\n--- /dev/null\\n+++ b/README.md\\n@@ -0,0 +1,80 @@\\n'+Array.from({length:80},(_,i)=>'+const row'+i+' = "长内容用于验证边缘与滚动";').join('\\n')+'\\n'})}};
    window.setTheme=theme=>applyTheme(builtinTheme(theme)); window.setTheme('light');
    const trigger=document.getElementById('trigger');
    window.reviewClicks=0; window.addEventListener('muster:turn-review',()=>window.reviewClicks++);
    createRoot(document.getElementById('root')).render(<TurnDiffPreview anchor={{file:'README.md',element:trigger}} target={{kind:'gui',id:'s',messageId:'m'}} onClose={()=>{}} onEnter={()=>{}} onLeave={()=>{}}/>);
  ` }, outfile: path.join(output, 'fixture.js'), bundle: true, format: 'esm', jsx: 'automatic', loader: { '.woff2': 'file', '.woff': 'file' } });
  server = createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><style>body{padding:20px;background:var(--surface-canvas)}*,*::before,*::after{animation:none!important;transition:none!important}</style><section class="turn-changes-card" style="width:min(640px,100%);margin:0"><button id="trigger" style="margin:12px">README.md</button></section><div id="root"></div><script type="module" src="/fixture.js"></script>'); return; }
    const file = path.join(output, path.basename(name));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
  for (const theme of ['light', 'dark']) for (const width of [900, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.diff-code').first().waitFor();
    await page.evaluate(theme => window.setTheme(theme), theme);
    await page.evaluate(() => document.fonts.ready);
    const headerStyle = await page.evaluate(theme => {
      const header = document.querySelector('.turn-diff-preview-head');
      const button = header.querySelector('button');
      const palette = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      probe.style.backgroundColor = palette.getPropertyValue(theme === 'light' ? '--surface-raised' : '--surface-overlay');
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      // Dark headers inherit the unchanged overlay surface; light headers paint a raised grey.
      const headerBackground = getComputedStyle(header).backgroundColor;
      return { background: theme === 'dark' && headerBackground === 'rgba(0, 0, 0, 0)' ? getComputedStyle(header.parentElement).backgroundColor : headerBackground,
        expected, buttonHeight: button.getBoundingClientRect().height,
        expectedButtonHeight: parseFloat(palette.getPropertyValue('--chat-card-header-button-height')),
        buttonBorder: getComputedStyle(button).borderTopStyle };
    }, theme);
    assert.equal(headerStyle.background, headerStyle.expected, `${theme}/${width}: preview header uses its intended surface`);
    assert.equal(headerStyle.buttonHeight, headerStyle.expectedButtonHeight, 'preview uses the shared card action height');
    assert.equal(headerStyle.buttonBorder, 'solid', 'preview review action has the shared fine outline');
    const code = page.locator('.diff-code').first();
    await code.evaluate(el => { el.textContent += ' long line without wrapping '.repeat(60); });
    const line = await code.evaluate(el => ({ height: el.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight), whiteSpace: getComputedStyle(el).whiteSpace }));
    assert.equal(line.whiteSpace, 'pre', 'Diff preserves source lines');
    assert.ok(line.height <= line.lineHeight + 1, 'long source line stays one visual row');
    const scroll = page.locator('.turn-diff-preview-body');
    assert.ok(await scroll.evaluate(el => el.scrollWidth > el.clientWidth), 'long line creates horizontal overflow');
    const scrollbar = await scroll.evaluate(el => {
      const css = getComputedStyle(el);
      return { color: css.scrollbarColor, gutter: el.offsetHeight - el.clientHeight };
    });
    assert.notEqual(scrollbar.color, 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)', 'preview scrollbar is not hidden by global transparent colors');
    // Overlay scrollbars reserve no gutter on macOS. Wheel scrolling is tested on every platform.
    if (scrollbar.gutter > 0) {
      const scrollBox = await scroll.boundingBox();
      const painted = PNG.sync.read(await page.screenshot());
      const hideThumb = await page.addStyleTag({ content: '.turn-diff-preview-body{scrollbar-color:transparent var(--surface-canvas)!important}.turn-diff-preview-body::-webkit-scrollbar-thumb{background:transparent!important}' });
      const hidden = PNG.sync.read(await page.screenshot()); await hideThumb.evaluate(el => el.remove());
      let paintedPixels = 0;
      for (let y = Math.ceil(scrollBox.y + scrollBox.height - scrollbar.gutter); y < Math.floor(scrollBox.y + scrollBox.height - 1); y++)
        for (let x = Math.ceil(scrollBox.x + 5); x < Math.floor(scrollBox.x + scrollBox.width - 20); x++)
          if (pixel(painted, x, y).join() !== pixel(hidden, x, y).join()) paintedPixels++;
      assert.ok(paintedPixels > 8, 'horizontal thumb actually paints visible pixels');
      await page.mouse.move(scrollBox.x + 26, scrollBox.y + scrollBox.height - scrollbar.gutter / 2);
      await page.mouse.down();
      await page.mouse.move(scrollBox.x + 126, scrollBox.y + scrollBox.height - scrollbar.gutter / 2, { steps: 8 });
      await page.mouse.up();
      assert.ok(await scroll.evaluate(el => el.scrollLeft > 0), 'visible horizontal thumb supports pointer dragging');
      await scroll.evaluate(el => { el.scrollLeft = 0; });
    }
    await scroll.hover(); await page.mouse.wheel(320, 0);
    await page.waitForFunction(() => document.querySelector('.turn-diff-preview-body').scrollLeft > 0);
    await scroll.evaluate(el => { el.scrollLeft = 0; });
    for (const scrolled of [false, true]) {
      if (scrolled) { await page.locator('.turn-diff-preview-body').hover(); await page.mouse.wheel(0, 250); await page.waitForFunction(() => document.querySelector('.turn-diff-preview-body').scrollTop > 0); }
      const box = await page.locator('.turn-diff-preview').boundingBox(), body = await page.locator('.turn-diff-preview-body').boundingBox();
      const card = await page.locator('.turn-changes-card').boundingBox();
      assert.equal(box.width, card.width, 'preview matches the card width');
      assert.equal(box.x, card.x, 'preview aligns with the card left edge');
      const label = `${theme}-${width}-${scrolled ? 'scrolled' : 'top'}`;
      const decorated = PNG.sync.read(await page.screenshot({ path: path.join(output, `${label}.png`) }));
      const plainStyle = await page.addStyleTag({ content: '.turn-diff-preview{box-shadow:none!important}.turn-diff-preview::after{display:none!important}' });
      const plain = PNG.sync.read(await page.screenshot()); await plainStyle.evaluate(el => el.remove());
      const points = { top: [box.x + box.width / 2, box.y], left: [box.x, body.y + 40], right: [box.x + box.width - 1, body.y + 40], bottom: [box.x + box.width / 2, box.y + box.height - 1] };
      for (const [edge, [x, y]] of Object.entries(points)) assert.notDeepEqual(pixel(decorated, x, y), pixel(plain, x, y), `${label}: ${edge} rim is painted above Diff`);
    }
    await page.getByRole('button', { name: '在右侧审阅' }).click();
    assert.equal(await page.evaluate(() => window.reviewClicks), 1, 'rim cannot intercept the review button');
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('ok turn Diff preview rim: light/dark × wide/narrow × top/scrolled; review pointer action');
} finally { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); release(); }
