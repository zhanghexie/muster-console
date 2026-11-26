/** 连同外层测量：侧栏左右/底部留白须与工作面底边一致，防止 padding 叠加。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
const browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.setContent(`
    <main class="main-view h-terminal" style="position:absolute;left:24px;top:12px;width:840px;height:760px">
    <div class="ws-stage"><div id="sidebar" class="sessions-column"><aside class="left-panel">
      <div class="left-panel-scroll">
        <div class="panel-header">实用功能</div>
        <div class="utility-feature-list session-list ui-list">
          ${['定时任务', '使用统计', '记忆整理', '扩展管理', '工作日报'].map((name) => `<button class="utility-feature-item session-item"><span class="session-name">${name}</span></button>`).join('')}
        </div>
        <div class="panel-header sub">工作会话</div>
        <div class="session-list ui-list">
          <div class="session-item active"><span>◯</span><div class="session-main"><span class="session-name"><span class="session-name-text">工作面板：用于检查侧栏缩窄后的长名称省略与边缘对齐</span></span></div><span class="session-reltime">1d</span></div>
          <div class="session-item"><span>◯</span><div class="session-main"><span class="session-name">构建发布流水线</span><span class="session-capsule">等待确认发布</span></div><span class="session-reltime">1mo</span></div>
        </div>
        <div class="panel-header sub">终端</div>
        <div class="session-list ui-list"><div class="session-item"><span class="session-name">PowerShell</span></div></div>
      </div>
      <div class="left-ws-slot"><div class="agent-ws-stack"><div class="agent-ws-stack-row is-active-row">
        <div class="agent-ws-stack-item is-active"><div class="agent-ws-stack-main"><div class="agent-notify-wrap">
          <div class="agent-notify-bubble"><button class="agent-notify-body">演示-前端项目</button></div>
        </div></div></div>
      </div></div></div>
    </aside></div></div></main>`);
  for (const file of ['base.css', 'float.css', 'left.css']) {
    await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles', file) });
  }
  for (const mode of ['pinned', 'peek']) {
  await page.evaluate((mode) => {
    const sidebar = document.querySelector('#sidebar');
    sidebar.className = mode === 'pinned' ? 'sessions-column' : 'sessions-float is-open';
    document.querySelector(mode === 'pinned' ? '.ws-stage' : '.main-view').append(sidebar);
  }, mode);
  for (const width of [200, 240, 280, 360]) {
    await page.locator('#sidebar').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    const bounds = await page.evaluate(() => {
      const edges = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; };
      const tiles = [...document.querySelectorAll('.utility-feature-item')].map(edges);
      return {
        frameGap: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--frame-gap')),
        sideGap: Math.min(...tiles.map((r) => r.left)) - edges(document.querySelector('#sidebar')).left,
        utility: { left: Math.min(...tiles.map((r) => r.left)), right: Math.max(...tiles.map((r) => r.right)) },
        main: edges(document.querySelector('.main-view')),
        stage: edges(document.querySelector('.ws-stage')),
        sidebar: edges(document.querySelector('#sidebar')),
        workspace: edges(document.querySelector('.agent-notify-bubble')),
        rows: [...document.querySelectorAll('.session-list:not(.utility-feature-list) .session-item')].map(edges)
      };
    });
    const frameGap = bounds.main.bottom - bounds.stage.bottom;
    assert.equal(bounds.frameGap, 4, '工作面框边 token 为 4px');
    assert.equal(bounds.sideGap, 6, '侧栏左右留白为 6px');
    assert.equal(frameGap, bounds.frameGap, '主界面底部实际留白跟随框边 token');
    for (const [name, box] of [['utility', bounds.utility], ['workspace', bounds.workspace], ...bounds.rows.map((row, i) => [`row-${i}`, row])]) {
      assert.ok(Math.abs(box.left - bounds.sidebar.left - bounds.sideGap) < 0.1,
        `${mode}/${width}/${name}：左侧实际留白应为 ${bounds.sideGap}px，得到 ${box.left - bounds.sidebar.left}px`);
      assert.ok(Math.abs(bounds.sidebar.right - box.right - bounds.sideGap) < 0.1,
        `${mode}/${width}/${name}：右侧实际留白应为 ${bounds.sideGap}px，得到 ${bounds.sidebar.right - box.right}px`);
    }
    assert.ok(Math.abs(bounds.main.bottom - bounds.workspace.bottom - (frameGap + 1)) < 0.1,
      `${mode}/${width}：工作区底距含 1px 上移，应为 ${frameGap + 1}px，得到 ${bounds.main.bottom - bounds.workspace.bottom}px`);
    for (const [index, row] of bounds.rows.entries()) {
      for (const side of ['left', 'right']) {
        for (const reference of ['utility', 'workspace']) {
          assert.ok(Math.abs(row[side] - bounds[reference][side]) < 0.1,
            `${width}px 侧栏第 ${index + 1} 行 ${side} 应与 ${reference} 对齐：${row[side]} / ${bounds[reference][side]}`);
        }
      }
    }
    // 折叠后最下方露出的后排轮廓也算入留白，不能只量前排胶囊。
    await page.evaluate(() => {
      const stack = document.querySelector('.agent-ws-stack');
      const rest = document.createElement('div');
      rest.className = 'agent-ws-stack-rest';
      rest.innerHTML = '<div class="agent-ws-stack-rest-body"></div>';
      for (let depth = 1; depth <= 3; depth++) {
        const row = stack.firstElementChild.cloneNode(true);
        row.classList.remove('is-active-row');
        row.style.setProperty('--ws-depth', depth);
        rest.firstElementChild.append(row);
      }
      stack.append(rest);
      stack.classList.add('is-collapsed');
    });
    await page.waitForTimeout(450);
    const foldedGap = await page.evaluate(() => {
      const bottom = Math.max(...[...document.querySelectorAll('.agent-notify-bubble')].map((el) => el.getBoundingClientRect().bottom));
      return document.querySelector('.main-view').getBoundingClientRect().bottom - bottom;
    });
    assert.ok(Math.abs(foldedGap - (frameGap + 1)) < 0.1, `${mode}/${width}：折叠后排到底边应为 ${frameGap + 1}px，得到 ${foldedGap}px`);
    await page.evaluate(() => {
      document.querySelector('.agent-ws-stack-rest').remove();
      document.querySelector('.agent-ws-stack').classList.remove('is-collapsed');
    });
    await page.waitForTimeout(300);
  }
  }
  console.log('sidebar-alignment-visual: OK (4 widths, pinned/peek, equal left/right/bottom frame gaps)');
} finally {
  await browser.close();
}
