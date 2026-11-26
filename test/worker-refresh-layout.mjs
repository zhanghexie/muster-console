/** Verify the production refresh control's position and action without taking screenshots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseLease = acquireTestLease(root);
const bundle = await build({ entryPoints: [path.join(root, 'test/fixtures/worker-refresh-layout.tsx')], bundle: true, write: false,
  platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'import.meta.url': '"http://127.0.0.1/fixture.js"' },
  loader: { '.css': 'empty', '.svg': 'dataurl' }, logLevel: 'silent' });
const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executable = process.env.CHROME_EXECUTABLE || (process.platform === 'win32' && fs.existsSync(windowsChrome) ? windowsChrome : undefined);
const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setContent('<div id="root"></div>');
  for (const file of ['src/renderer/src/styles/base.css', 'src/renderer/src/styles/settings.css',
    'src/renderer/src/components/settings/worker-pane.css', 'src/renderer/src/components/settings/settings-content.css',
    'src/renderer/src/components/settings/settings-resource.css']) await page.addStyleTag({ path: path.join(root, file) });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = page.getByRole('button', { name: '刷新', exact: true });
  try { await button.waitFor({ timeout: 5000 }); }
  catch (cause) { throw new Error(`Refresh control did not render: ${pageErrors.join('; ')}; text: ${(await page.locator('body').innerText()).slice(0, 500)}`, { cause }); }
  for (const width of [1200, 700]) {
    await page.setViewportSize({ width, height: 800 });
    const boxes = await page.locator('[data-settings-item="worker-engines"] > .s-sec-h').evaluate(node => {
      const toolbar = node.getBoundingClientRect(), label = node.querySelector('.s-sec-heading').getBoundingClientRect();
      const button = node.querySelector('button').getBoundingClientRect();
      return { toolbar: { left: toolbar.left, right: toolbar.right, bottom: toolbar.bottom },
        label: { right: label.right, bottom: label.bottom }, button: { left: button.left, top: button.top, right: button.right, bottom: button.bottom } };
    });
    assert.ok(Math.abs(boxes.button.right - boxes.toolbar.right) < 1, `${width}px: refresh must align with the right edge`);
    assert.ok(boxes.button.left >= boxes.label.right || boxes.button.top >= boxes.label.bottom, `${width}px: refresh must not overlap the description`);
    assert.ok(boxes.button.left >= boxes.toolbar.left && boxes.button.bottom <= boxes.toolbar.bottom, `${width}px: refresh must remain in the toolbar`);
  }
  await button.click();
  await page.getByRole('dialog', { name: '模型目录刷新' }).getByText('测试工作区').waitFor();
  assert.equal(await page.evaluate(() => window.__refreshCalls.length), 1);
  console.log('worker-refresh-layout: ok');
} finally { await browser.close(); releaseLease(); }
