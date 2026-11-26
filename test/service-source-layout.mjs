import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
const browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  // Wide app viewport with a narrow center panel: container width must drive the grid.
  for (const width of [780, 390, 320]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await page.setContent(`<div class="service-view task-editor" style="width:${width}px">
      <div class="service-meta task-settings-grid"><div class="full"><div class="task-source-field">
        <span>Source</span><button class="c-select-trigger"><span class="c-select-value">D:/long/source/folder/中文路径同名根/client/plugins/extra/source</span></button>
        <span class="task-source-path">D:/long/source/folder/中文路径同名根/client/plugins/extra/source</span></div></div>
        ${Array.from({ length: 8 }, () => '<div><label>Runtime</label><input value="Fixture"></div>').join('')}</div>
      <div class="service-meta task-run-summary"><div>Next</div><div>Result</div></div></div>`);
    for (const file of ['base', 'chat', 'settings', 'tasks']) await page.addStyleTag({ path: path.join(project, `src/renderer/src/styles/${file}.css`) });
    const box = await page.locator('.service-view').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth,
      field: el.querySelector('.c-select-trigger').getBoundingClientRect().right, right: el.getBoundingClientRect().right,
      columns: getComputedStyle(el.querySelector('.task-settings-grid')).gridTemplateColumns.split(' ').length }));
    assert.ok(box.scroll <= box.client, `${width}px: content overflows ${JSON.stringify(box)}`);
    assert.ok(box.field <= box.right, `${width}px: source trigger extends outside its panel`);
    assert.equal(box.columns, width <= 600 ? 2 : 4);
    await page.close();
  }
  console.log('service-source-layout: OK (780/390/320px containers, production CSS)');
} finally { await browser.close(); }
