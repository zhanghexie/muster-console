/** Run the existing storage scrolling scenario against the framed pane without screenshots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';
import runHeightScenario from './fixtures/local-storage-height-scenario.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseLease = acquireTestLease(root);
const bundle = await build({ entryPoints: [path.join(root, 'test/fixtures/local-storage-settings.tsx')], bundle: true, write: false,
  platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@workbench': root },
  define: { 'import.meta.url': '"http://127.0.0.1/fixture.js"' },
  loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.jpg': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'silent' });
const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executable = process.env.CHROME_EXECUTABLE || (process.platform === 'win32' && fs.existsSync(windowsChrome) ? windowsChrome : undefined);
const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 640 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://fixture.local/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto(`http://fixture.local/?theme=${width === 1100 ? 'dark' : 'light'}`);
    for (const file of ['base', 'dialogs', 'settings', 'float', 'responsive', 'brand-loading'])
      await page.addStyleTag({ path: path.join(root, `src/renderer/src/styles/${file}.css`) });
    for (const file of ['settings-content', 'settings-resource', 'local-storage'])
      await page.addStyleTag({ path: path.join(root, `src/renderer/src/components/settings/${file}.css`) });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('.local-storage').waitFor();
    await page.evaluate(() => document.fonts.ready);
    try { await runHeightScenario({ page, assert, capture: async () => {} }); }
    catch (cause) {
      const geometry = await page.locator('.local-storage-actions').evaluate(node => ({
        bounds: node.getBoundingClientRect().toJSON(), css: { display: getComputedStyle(node).display, gap: getComputedStyle(node).gap },
        children: Array.from(node.children, child => ({ text: child.textContent, bounds: child.getBoundingClientRect().toJSON() }))
      })).catch(() => null);
      throw new Error(`${width}px storage layout: ${cause.message}; actions=${JSON.stringify(geometry)}`, { cause });
    }
    assert.deepEqual(errors, [], `${width}px: page errors`);
    await page.close();
  }
  console.log('local-storage-section-frame: ok');
} finally { await browser.close(); releaseLease(); }
