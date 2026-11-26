/** Native scrolling regression using the production component and CSS; no screenshot review. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';
const root = process.cwd();
const release = acquireTestLease(root);
let browser;
try {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { BoardColumnScroll } from './src/renderer/src/panels/BoardColumnScroll';
    createRoot(document.getElementById('root')!).render(<BoardColumnScroll label="滚动列表">{Array.from({length: 20}, (_, i) => <div className="item" key={i}>会话 {i}</div>)}</BoardColumnScroll>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  const chrome = process.env.CHROME_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '');
  browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
  const page = await browser.newPage({ viewport: { width: 600, height: 500 } });
  await page.setContent('<div id="root"></div>');
  for (const name of ['base', 'board']) await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles', name + '.css') });
  await page.addStyleTag({ content: '.board-column-scroll { width: 240px; height: 180px; } .item { height: 40px; flex: none; }' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const list = page.getByRole('region', { name: '滚动列表' });
  await list.waitFor();
  assert.equal(await page.locator('[role="scrollbar"], .board-column-scroll-thumb').count(), 0);
  assert.equal(await list.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar').display), 'none');
  assert.equal(await list.evaluate(el => getComputedStyle(el).scrollbarWidth), 'none');
  assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight));
  await list.focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('.board-column-body').scrollTop > 0);
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelector('.board-column-body').scrollTop <= 1);
  await list.hover(); await page.mouse.wheel(0, 200);
  await page.waitForFunction(() => document.querySelector('.board-column-body').scrollTop > 0);
  assert.equal(await page.locator('[role="scrollbar"], .board-column-scroll-thumb').count(), 0);
  console.log('No scrollbars; native keyboard and wheel scrolling work.');
} finally { await browser?.close(); release(); }
