/** 用户画像页头：在真实 CSS 下与偏好卡对齐，窄面板不挤压按钮。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
const browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
const screenshotDir = process.env.MEMORY_PROFILE_SCREENSHOT_DIR;
if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

try {
  for (const width of [1280, 520, 340]) {
    const page = await browser.newPage({ viewport: { width, height: 460 }, deviceScaleFactor: 1 });
    await page.setContent(`<main class="memory-page"><section class="memory-inner">
      <header class="profile-summary">
        <div class="profile-summary-copy">
          <div class="profile-head"><h2 class="profile-title">你的偏好</h2><span class="profile-globe">◍ 跨工作区生效</span></div>
          <p class="profile-summary-description">写下你希望 Agent 长期遵守的做事方式，保存后立即生效。</p>
        </div>
        <button class="ui-btn primary compact">＋ 新增偏好</button>
      </header>
      <div class="memory-list"><article class="memory-row profile-row"><div class="memory-row-main">
        <span class="memory-row-title">aaa</span><span class="memory-row-when">09-30 记下</span>
        <span class="memory-row-meta"><span class="memory-tag is-lesson">生效中</span></span>
      </div></article></div>
    </section></main>`);
    for (const file of ['base.css', 'memory.css']) {
      await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles', file) });
    }
    await page.addStyleTag({ content: 'body{margin:0;background:var(--bg-panel)}*,*::before,*::after{animation:none!important;transition:none!important}' });
    const metrics = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const title = box('.profile-title');
      const summary = box('.profile-summary');
      const description = box('.profile-summary-description');
      const add = box('.profile-summary > .ui-btn');
      const row = box('.profile-row');
      const rowTitle = box('.profile-row .memory-row-title');
      return {
        titleX: title.x, rowTitleX: rowTitle.x,
        summaryBottom: summary.bottom, rowTop: row.top,
        descriptionRight: description.right, descriptionBottom: description.bottom,
        buttonLeft: add.left, buttonTop: add.top,
        buttonRight: add.right, buttonBottom: add.bottom,
        summaryRight: summary.right,
        headingSize: parseFloat(getComputedStyle(document.querySelector('.profile-title')).fontSize),
        overflow: document.documentElement.scrollWidth > innerWidth
      };
    });
    assert.ok(Math.abs(metrics.titleX - metrics.rowTitleX) <= 2, `${width}px 标题未与条目正文对齐: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.rowTop - metrics.summaryBottom >= 12, `${width}px 页头与条目挤在一起`);
    assert.ok(metrics.buttonRight <= metrics.summaryRight + 1, `${width}px 新增按钮越过页头`);
    assert.ok(metrics.headingSize >= 16, `${width}px 标题层级太弱`);
    assert.equal(metrics.overflow, false, `${width}px 出现横向溢出`);
    if (width > 560) {
      assert.ok(metrics.descriptionRight < metrics.buttonLeft, `${width}px 说明与按钮重叠`);
    } else {
      assert.ok(metrics.buttonTop >= metrics.descriptionBottom, `${width}px 窄面板按钮应落在说明下方`);
    }
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, `profile-${width}.png`) });
    await page.close();
  }
  console.log('memory-profile-layout-visual: OK (1280/520/340px, aligned header and row, no overlap)');
} finally {
  await browser.close();
}
