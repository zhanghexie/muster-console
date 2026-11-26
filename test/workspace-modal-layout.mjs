/** CSS 回归：工作区弹窗的窄屏约束不得被通用 modal 的 420px 下限覆盖。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
const browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  for (const width of [780, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(`<div class="modal-mask"><div class="modal create-ws-modal"><h3>工作区</h3>
      <div class="create-ws-avatar-row"><div class="create-ws-avatar-preview">🤖</div><div class="create-ws-avatar-grid">${Array.from({ length: 16 }, () => '<button class="create-ws-avatar-pick">🌱</button>').join('')}</div></div>
      <label class="create-ws-field">名称<input value="MetaApp"></label></div></div>`);
    await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles/base.css') });
    await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles/dialogs.css') });
    const bounds = await page.locator('.create-ws-modal').evaluate((el) => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, client: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(bounds.left >= 0 && bounds.right <= width, `${width}px: dialog clipped: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.scroll <= bounds.client, `${width}px: content overflows`);
    await page.close();
  }
  console.log('workspace-modal-layout: OK (780/390px, production CSS)');
} finally { await browser.close(); }
