/** 展开工作区栈不得改变会话列表宽度/右侧留白（portal 槽位宽度隔离）。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadChromium() {
  const req = createRequire(fileURLToPath(import.meta.url));
  try {
    return req('playwright-core');
  } catch {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    return createRequire(path.join(path.resolve(common, '..'), 'package.json'))('playwright-core');
  }
}
const { chromium } = loadChromium();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome =
  process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
const browser = await chromium.launch({
  headless: true,
  ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {})
});

const row = (name, extra = '') => `
  <div class="agent-ws-stack-row${extra}">
    <div class="agent-ws-stack-item">
      <div class="agent-ws-stack-main"><div class="agent-notify-wrap">
        <div class="agent-notify-bubble">
          <button class="agent-avatar agent-float-avatar" title="${name}">${name[0]}</button>
          <button class="agent-notify-body"><span class="agent-notify-text">${name}</span></button>
          <button class="agent-notify-scheduler session-capsule"><span class="session-capsule-label">空闲</span></button>
          <button class="agent-notify-chat"><span class="agent-notify-chat-label">对话</span></button>
        </div>
      </div></div>
    </div>
  </div>`;

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
  await page.setContent(`
    <main class="main-view h-terminal" style="position:absolute;left:24px;top:12px;width:840px;height:680px;--sessions-col-w:240px;--agent-float-inset:12px">
      <div class="ws-stage">
        <div id="sidebar" class="sessions-column" style="width:240px;height:100%">
          <aside class="left-panel">
            <div class="left-panel-scroll">
              <div class="utility-feature-list session-list ui-list">
                ${['定时任务', '使用统计', '记忆整理', '扩展管理', '工作日报']
                  .map((n) => `<button class="utility-feature-item session-item"><span class="session-name">${n}</span></button>`)
                  .join('')}
              </div>
              <div class="panel-header sub">工作会话</div>
              <div class="session-list ui-list" id="session-list">
                ${Array.from(
                  { length: 8 },
                  (_, i) =>
                    `<div class="session-item${i === 0 ? ' active' : ''}"><div class="session-main"><span class="session-name">会话 ${i + 1} 观察右侧留白</span></div><span class="session-reltime">1d</span></div>`
                ).join('')}
              </div>
            </div>
            <div class="left-ws-slot">
              <div class="agent-ws-stack">
                <div class="agent-ws-stack-header">
                  <button class="agent-ws-add-btn">+</button>
                  <button class="agent-ws-collapse-btn"></button>
                </div>
                ${row('AlphaWorkspaceWithAVeryLongDisplayName', ' is-open is-active-row')}
                <div class="agent-ws-stack-rest is-open">
                  <div class="agent-ws-stack-rest-body">
                    ${row('BetaAnotherVeryLongWorkspaceTitle')}
                    ${row('Gamma')}
                    ${row('Delta')}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </main>`);
  for (const file of ['base.css', 'float.css', 'left.css']) {
    await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles', file) });
  }

  const measure = () =>
    page.evaluate(() => {
      const sidebar = document.querySelector('#sidebar');
      const scroll = document.querySelector('.left-panel-scroll');
      const item = document.querySelector('#session-list .session-item');
      const slot = document.querySelector('.left-ws-slot');
      const bubble = document.querySelector('.agent-notify-bubble');
      const sb = sidebar.getBoundingClientRect();
      const it = item.getBoundingClientRect();
      const bub = bubble.getBoundingClientRect();
      return {
        frameGap: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--frame-gap')),
        itemW: it.width,
        itemRightGap: sb.right - it.right,
        bubbleRightGap: sb.right - bub.right,
        slotOverflow: slot.scrollWidth - slot.clientWidth,
        overflowY: scroll.scrollHeight > scroll.clientHeight,
        contain: getComputedStyle(slot).contain
      };
    });

  const collapse = (on) =>
    page.evaluate((on) => {
      const stack = document.querySelector('.agent-ws-stack');
      const rest = document.querySelector('.agent-ws-stack-rest');
      stack.classList.toggle('is-collapsed', on);
      rest.classList.toggle('is-open', !on);
      rest.querySelectorAll('.agent-ws-stack-row').forEach((row, i) => {
        row.classList.toggle('is-open', !on);
        if (on) row.style.setProperty('--ws-depth', String(i + 1));
        else row.style.removeProperty('--ws-depth');
      });
    }, on);

  // 含「折叠不溢、展开溢出」的临界栏高，以及已溢出/都不溢的两侧，宽度都必须稳住。
  const cases = [];
  for (const height of [420, 520, 680]) {
    await page.locator('.main-view').evaluate((el, height) => {
      el.style.height = `${height}px`;
    }, height);
    await collapse(true);
    await page.waitForTimeout(30);
    const folded = await measure();
    await collapse(false);
    await page.waitForTimeout(30);
    const open = await measure();
    cases.push({ height, folded, open });
    assert.ok(
      Math.abs(open.itemW - folded.itemW) < 0.1,
      `${height}px：展开不得改会话行宽：${folded.itemW} → ${open.itemW}`
    );
    assert.ok(
      Math.abs(open.itemRightGap - folded.itemRightGap) < 0.1,
      `${height}px：展开不得改会话行右侧留白：${folded.itemRightGap} → ${open.itemRightGap}`
    );
    assert.equal(open.frameGap, 4, `${height}px：生产框边 token 应为 4px`);
    assert.ok(Math.abs(open.itemRightGap - 6) < 0.1, `${height}px：会话行右侧留白应为 6px，得到 ${open.itemRightGap}`);
    assert.ok(
      Math.abs(open.bubbleRightGap - 6) < 0.1,
      `${height}px：工作区胶囊右侧留白应为 6px，得到 ${open.bubbleRightGap}`
    );
    assert.ok(open.slotOverflow <= 0, `${height}px：长名展开不得撑出槽位：overflow ${open.slotOverflow}`);
  }
  assert.match(
    String(cases[0].open.contain),
    /inline-size|strict|content/,
    `槽位须含 inline-size 隔离，得到 ${cases[0].open.contain}`
  );

  console.log('ws-stack-session-layout-visual: OK (stable session width/gap across 3 heights, slot contained)');
} finally {
  await browser.close();
}
