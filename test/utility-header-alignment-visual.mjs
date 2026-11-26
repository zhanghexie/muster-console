/** Production CSS geometry for utility headers and content, including narrow local panes.
 * Run: node test/utility-header-alignment-visual.mjs
 * Negative control: --baseline reinstates the old centered header and must fail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const header = (title, action = '') => `<header class="prompt-task-toolbar"><div><h1>${title}</h1><span>说明文字</span></div>${action ? `<div class="prompt-task-toolbar-actions"><button class="ui-btn">${action}</button></div>` : ''}</header>`;
  await page.setContent(`<style>body{margin:0}.host{position:relative;height:180px}</style>
    <div class="host" id="tasks"><main class="prompt-task-panel">${header('定时任务', '新建任务')}<div class="prompt-task-list-caption">任务列表</div><div class="prompt-task-list">任务</div></main></div>
    <div class="host" id="usage"><main class="prompt-task-panel usage-panel">${header('使用统计', '刷新')}<div class="usage-body">统计</div></main></div>
    <div class="host" id="memory"><main class="prompt-task-panel memory-panel">${header('记忆中心')}</main></div>
    <div class="host" id="extensions"><main class="prompt-task-panel ext-manager-panel">${header('扩展管理')}</main></div>`);
  for (const name of ['base', 'ext', 'tasks', 'usage', 'memory']) {
    await page.addStyleTag({ path: path.join(root, `src/renderer/src/styles/${name}.css`) });
  }
  if (process.argv.includes('--baseline')) await page.addStyleTag({ content: `
    .prompt-task-panel .prompt-task-toolbar { width:min(960px,100%);margin-inline:auto }
    .prompt-task-panel .prompt-task-list-caption,.prompt-task-panel .prompt-task-list { margin-inline:auto }
  ` });
  for (const width of [320, 390, 480, 1200, 1600]) {
    await page.evaluate(value => document.querySelectorAll('.host').forEach(host => { host.style.width = `${value}px`; }), width);
    const layout = await page.evaluate(() => [...document.querySelectorAll('.host')].map(host => {
      const pane = host.querySelector('.prompt-task-panel'), header = pane.querySelector('header'), title = header.querySelector('h1');
      const bounds = pane.getBoundingClientRect(), headerRect = header.getBoundingClientRect(), titleRect = title.getBoundingClientRect();
      const content = pane.querySelector('.prompt-task-list-caption,.usage-body');
      const contentLeft = content ? content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft) - bounds.left : null;
      const contentRight = content ? bounds.right - content.getBoundingClientRect().right + parseFloat(getComputedStyle(content).paddingRight) : null;
      const button = header.querySelector('button'), buttonRect = button?.getBoundingClientRect();
      return { id: host.id, titleLeft: titleRect.left - bounds.left, contentLeft, contentRight, headerWidth: headerRect.width,
        paneWidth: bounds.width, overflows: pane.scrollWidth > pane.clientWidth,
        buttonInside: !buttonRect || (buttonRect.left >= bounds.left && buttonRect.right <= bounds.right),
        buttonSeparate: !buttonRect || buttonRect.left >= titleRect.right || buttonRect.top >= titleRect.bottom };
    }));
    for (const item of layout) {
      const inset = width <= 420 ? 16 : 24;
      assert.equal(item.titleLeft, inset, `${width}/${item.id}: title must start at the pane's left inset`);
      assert.equal(item.headerWidth, item.paneWidth, `${width}/${item.id}: header must span its pane`);
      if (item.id === 'usage') {
        const expectedGap = inset + Math.max(0, width - 1180) / 2;
        assert.equal(item.contentLeft, expectedGap, `${width}/usage: statistics must have a centered left inset`);
        assert.equal(item.contentRight, expectedGap, `${width}/usage: statistics must have a centered right inset`);
      } else if (item.contentLeft !== null) {
        assert.equal(item.contentLeft, inset, `${width}/${item.id}: content must share the title's left axis`);
      }
      assert.ok(!item.overflows && item.buttonInside && item.buttonSeparate, `${width}/${item.id}: header must fit without overlap or horizontal overflow`);
    }
  }
  console.log('utility-header-alignment-visual: OK (four headers, 320–1600px local panes; production CSS)');
} finally {
  await browser.close();
}
