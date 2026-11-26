/** The provider detail hides its scrollbar but remains scrollable by wheel and keyboard. No screenshots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ entryPoints: [path.join(root, 'test/fixtures/model-provider-scroll.tsx')], bundle: true, write: false,
  platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' }, logLevel: 'silent' });
const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executable = process.env.CHROME_EXECUTABLE || (process.platform === 'win32' && fs.existsSync(windowsChrome) ? windowsChrome : undefined);
const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent('<div id="root"></div>');
  for (const file of ['src/renderer/src/styles/base.css', 'src/renderer/src/styles/settings.css',
    'src/renderer/src/components/settings/settings-content.css', 'src/renderer/src/components/settings/settings-resource.css']) {
    await page.addStyleTag({ path: path.join(root, file) });
  }
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const detail = page.locator('.llm-provider-list > .settings-split-main');
  await detail.waitFor();
  await detail.hover();
  const state = await detail.evaluate(node => ({
    scrollbarWidth: getComputedStyle(node).scrollbarWidth,
    webkitDisplay: getComputedStyle(node, '::-webkit-scrollbar').display,
    overflowY: getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight, clientHeight: node.clientHeight
  }));
  assert.equal(state.scrollbarWidth, 'none', 'provider scrollbar must stay hidden even on hover');
  assert.equal(state.webkitDisplay, 'none', 'WebKit scrollbar must stay hidden');
  assert.equal(state.overflowY, 'auto');
  assert.ok(state.scrollHeight > state.clientHeight, 'fixture must exercise an overflowing provider detail');
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.querySelector('.llm-provider-list > .settings-split-main').scrollTop > 0);
  await detail.evaluate(node => { node.scrollTop = 0; });
  await detail.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => document.querySelector('.llm-provider-list > .settings-split-main').scrollTop > 0);
  assert.notEqual(await page.locator('.settings-split-list').evaluate(node => getComputedStyle(node).scrollbarWidth), 'none', 'provider list scrollbar must not be affected');
  await page.setViewportSize({ width: 800, height: 800 });
  const outer = page.locator('.settings-page > main');
  assert.equal(await detail.evaluate(node => getComputedStyle(node).overflowY), 'visible', 'narrow layout should continue to use the outer scroller');
  await detail.hover({ position: { x: 100, y: 100 } });
  const beforeWheel = await outer.evaluate(node => node.scrollTop);
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(before => document.querySelector('.settings-page > main').scrollTop > before, beforeWheel);
  console.log('model-provider-scrollbar: ok');
} finally { await browser.close(); }
