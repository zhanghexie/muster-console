/** Geometry regression for production BoardCard and board.css; no visual acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';
const root = process.cwd();
const release = acquireTestLease(root);
const longReply = '当前目录是 `/Users/fixture/Muster/VeryLongWorkspaceFolderWithoutAnySpacesOrSeparators/session`，你有具体想做的吗？';
let browser;
try {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/renderer/src/i18n';
    import { BoardCard } from './src/renderer/src/panels/BoardCard';
    window.api = { on: () => () => {} } as any;
    const common = { runtimeLabel:'Codex', relTimeTs:Date.now(), isActive:false, onSelect:()=>{}, onContextMenu:()=>{}, onArchive:()=>{} };
    createRoot(document.getElementById('root')!).render(<div className="board-status-body">
      <BoardCard {...common} sessionId="archive" name="归档会话标题" status="exited" liveLabel="已完成" branch="ao/test" orphanWorktree archived />
      <BoardCard {...common} sessionId="review" name="待验收会话标题" status="waiting" reviewable />
      <BoardCard {...common} sessionId="idle" name="空闲会话标题" status="idle" replyPreview="真实助手输出正文" />
      <BoardCard {...common} sessionId="long-reply" name="长路径预览" status="idle" replyPreview={${JSON.stringify(longReply)}} />
    </div>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/fixture.js"' } });
  const chrome = process.env.CHROME_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '');
  browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent('<div id="root"></div>');
  for (const name of ['base', 'left', 'board']) await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles', name + '.css') });
  await page.addStyleTag({ content: 'body { margin: 20px; } .board-card { margin: 8px 0; }' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const cards = page.locator('.board-status-body .board-card');
  await cards.first().waitFor();
  await page.getByText('真实助手输出正文').waitFor();
  const preview = page.getByText(longReply, { exact: true });
  await page.evaluate(() => document.fonts.ready);
  for (const width of [220, 330]) {
    await page.locator('.board-status-body').evaluate((el, w) => { el.style.width = w + 'px'; }, width);
    const replyFits = await preview.evaluate(el => {
      const bounds = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = Array.from(range.getClientRects());
      const visible = lines.filter(line => line.top < bounds.bottom);
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      return lines.every(line => line.left >= bounds.left - 1 && line.right <= bounds.right + 1) &&
        visible.length > 0 && visible.every(line => line.bottom <= bounds.bottom + 1) &&
        bounds.height <= 2 * lineHeight + 1;
    });
    assert.ok(replyFits, `width ${width}: reply text crossed the card's content bounds`);
    for (let i = 0; i < await cards.count(); i++) {
      const card = cards.nth(i);
      await page.mouse.move(750, 550);
      const before = await card.boundingBox();
      await card.hover();
      const during = await card.boundingBox();
      assert.equal(during.height, before.height, `card ${i}, width ${width}: hover changed height`);
      assert.equal(await card.locator('.session-archive-btn').evaluate(el => getComputedStyle(el).visibility), 'visible');
      await card.locator('.session-reltime').waitFor({ state: 'hidden', timeout: 2000 });
      assert.equal(await card.locator('.board-card-toolbar, .board-card-more-btn, .board-card-actions').count(), 0);
      await page.mouse.move(750, 550);
      await card.locator('.board-card-name').focus();
      const focused = await card.boundingBox();
      assert.equal(focused.height, before.height, `card ${i}, width ${width}: focus changed height`);
      await page.locator('body').evaluate(el => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    }
  }
  console.log('BoardCard reply text fits, and hover and focus keep card height at 220px and 330px widths.');
} finally { await browser?.close(); release(); }
