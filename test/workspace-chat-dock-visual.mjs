/** 对话状态必须收窄整颗胶囊，头像始终在内部；关闭/反向打断后恢复整行。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
const browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 300 } });
  await page.setContent(`<div class="left-ws-slot" style="position:absolute;left:20px;top:20px">
    <div class="agent-ws-stack"><div class="agent-ws-stack-row is-active-row">
      <div class="agent-ws-stack-item is-active"><div class="agent-ws-stack-main"><div class="agent-notify-wrap">
        <div class="agent-notify-bubble">
          <button class="agent-avatar agent-float-avatar" title="Alpha">A</button>
          <button class="agent-notify-body"><span class="agent-notify-text">Alpha</span></button>
          <button class="agent-notify-chat">对话</button>
        </div>
      </div></div></div>
    </div></div></div>`);
  for (const file of ['base.css', 'float.css', 'left.css']) {
    await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles', file) });
  }
  const geometry = () => page.evaluate(() => {
    const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left:r.left, right:r.right, width:r.width }; };
    return { capsule:box('.agent-notify-bubble'), avatar:box('.agent-float-avatar'), row:box('.agent-ws-stack-item') };
  });
  const toggle = (open) => page.locator('.agent-ws-stack-item').evaluate((el, open) => {
    el.classList.toggle('is-chatting', open);
    el.querySelector('.agent-notify-text').textContent = open ? '正在对话' : 'Alpha';
    el.querySelector('.agent-notify-chat').textContent = open ? '收起' : '对话';
  }, open);
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    for (const width of [200, 265, 320]) {
      await page.locator('.left-ws-slot').evaluate((el, w) => { el.style.width = `${w}px`; }, width);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const before = await geometry();
      assert.ok(before.avatar.left > before.capsule.left && before.avatar.right < before.capsule.right, '普通态头像收入完整胶囊');
      await toggle(true);
      await page.waitForTimeout(60);
      const moving = await geometry();
      assert.ok(moving.avatar.left > moving.capsule.left && moving.avatar.right < moving.capsule.right, '收缩途中头像也不能离开胶囊');
      await page.waitForTimeout(350);
      const open = await geometry();
      assert.ok(open.capsule.width <= before.capsule.width - 32, `${width}/${reducedMotion}: 对话胶囊必须明显收窄`);
      assert.ok(open.avatar.left > open.capsule.left && open.avatar.right < open.capsule.right, '对话态头像必须仍在胶囊内部');
      assert.equal(open.avatar.width, before.avatar.width, '对话态头像不应单独放大');
      assert.ok(open.avatar.left >= open.row.left, '缩窄侧栏时头像不能越出行边界');
      assert.ok(open.capsule.width >= 144, '窄侧栏也应容纳头像、正在对话和收起按钮');
      assert.ok(Math.abs(open.capsule.right - before.capsule.right) < 0.1, `收窄时右缘固定：${JSON.stringify({ width, reducedMotion, before, open })}`);
      await page.evaluate(() => {
        const stack = document.querySelector('.agent-ws-stack');
        const backRow = stack.firstElementChild.cloneNode(true);
        backRow.classList.remove('is-active-row');
        backRow.style.setProperty('--ws-depth', '1');
        backRow.querySelector('.agent-ws-stack-item').classList.remove('is-chatting', 'is-active');
        const rest = document.createElement('div');
        rest.className = 'agent-ws-stack-rest';
        rest.innerHTML = '<div class="agent-ws-stack-rest-body"></div>';
        rest.firstElementChild.append(backRow);
        stack.append(rest);
        stack.classList.add('is-collapsed');
      });
      await page.waitForTimeout(350);
      const back = await page.locator('.agent-ws-stack-rest .agent-notify-bubble').boundingBox();
      assert.ok(Math.abs(back.width - before.capsule.width * 0.93) < 1, '后排行保持正常宽度，只应用层叠缩放');
      assert.ok(back.width > open.capsule.width, '对话态只收窄当前行，后排不跟随');
      await page.evaluate(() => {
        document.querySelector('.agent-ws-stack-rest').remove();
        document.querySelector('.agent-ws-stack').classList.remove('is-collapsed');
      });
      // 正在收回时再次打开，随后关闭；不能卡在中间宽度。
      await toggle(false);
      await page.waitForTimeout(50);
      await toggle(true);
      await page.waitForTimeout(350);
      assert.ok(Math.abs((await geometry()).capsule.width - open.capsule.width) < 0.1, '快速重开到达同一收缩位置');
      await toggle(false);
      await page.waitForTimeout(350);
      const closed = await geometry();
      assert.ok(Math.abs(closed.capsule.width - before.capsule.width) < 0.1, '关闭后恢复完整胶囊宽度');
      assert.ok(Math.abs(closed.avatar.left - before.avatar.left) < 0.1, '关闭后头像回到原位');
    }
  }
  console.log('workspace-chat-dock-visual: OK (3 widths, reduced motion, interrupted close)');
} finally {
  await browser.close();
}
