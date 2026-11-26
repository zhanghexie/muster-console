/** 工作空间胶囊与实用功能的三态实际像素应一致，折叠重叠时不能透字。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
const browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 660, height: 260 } });
  await page.setContent(`
    <div class="utility-feature-list" style="position:absolute;left:20px;top:20px;width:220px">
      <button class="utility-feature-item session-item">实用功能</button>
    </div>
    <div class="left-ws-slot" style="position:absolute;left:300px;top:20px;width:300px;padding:0">
      <div class="agent-ws-stack"><div class="agent-ws-stack-row is-active-row">
        <div class="agent-ws-stack-item"><div class="agent-ws-stack-main"><div class="agent-notify-wrap">
          <div class="underlay" style="position:absolute;inset:0;background:red"></div>
          <div class="agent-notify-bubble"><button class="agent-notify-body"><span class="agent-notify-text">工作空间</span></button>
            <button class="agent-notify-scheduler"><span class="status-badge session-capsule"><span class="session-capsule-label">等待确认</span></span></button>
          </div>
        </div></div></div>
      </div></div>
    </div>`);
  for (const file of ['base.css', 'float.css', 'left.css']) {
    await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles', file) });
  }
  await page.addStyleTag({ content: 'body{background:var(--workspace-frame-color,var(--bg-frame))}*,*::before,*::after{transition:none!important;animation:none!important}' });
  const utility = page.locator('.utility-feature-item');
  const bubble = page.locator('.agent-notify-bubble');
  const sample = async (locator) => {
    const box = await locator.boundingBox();
    const png = await page.screenshot();
    return page.evaluate(async ({ data, x, y }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data);
    }, { data: png.toString('base64'), x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 5) });
  };
  const sameColor = (a, b, message) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= 1), `${message}: ${a} / ${b}`);

  for (const [theme, frame] of [['purple', '#302c49'], ['orange', '#4d3025'], ['plain', null], ['light', '#e8e4f2']]) {
    await page.evaluate(({ theme, frame }) => {
      const style = document.documentElement.style;
      if (frame) style.setProperty('--workspace-frame-color', frame);
      else style.removeProperty('--workspace-frame-color');
      style.setProperty('--ink', theme === 'light' ? '#202124' : '#ededee');
      style.setProperty('--hover-fill', theme === 'light' ? 'rgba(20,18,10,.045)' : 'rgba(255,255,255,.05)');
      style.setProperty('--hover-fill-strong', theme === 'light' ? 'rgba(20,18,10,.08)' : 'rgba(255,255,255,.09)');
    }, { theme, frame });
    const neutral = await page.evaluate(() => ({
      name: getComputedStyle(document.querySelector('.agent-notify-text')).color,
      status: getComputedStyle(document.querySelector('.agent-notify-scheduler .status-badge')).color
    }));
    await page.evaluate(() => {
      document.querySelector('.agent-notify-bubble').classList.add('is-waiting');
      document.querySelector('.agent-notify-scheduler .status-badge').dataset.statusAttention = 'true';
    });
    assert.deepEqual(await page.evaluate(() => ({
      name: getComputedStyle(document.querySelector('.agent-notify-text')).color,
      status: getComputedStyle(document.querySelector('.agent-notify-scheduler .status-badge')).color
    })), neutral, `${theme}: waiting keeps workspace name and status text neutral`);
    assert.equal(await page.locator('.agent-notify-scheduler .status-badge').evaluate(el => getComputedStyle(el, '::before').width), '5px');
    await page.evaluate(() => {
      document.querySelector('.agent-notify-bubble').classList.remove('is-waiting');
      delete document.querySelector('.agent-notify-scheduler .status-badge').dataset.statusAttention;
    });
    for (const state of ['idle', 'hover', 'active']) {
      await page.evaluate((state) => {
        document.querySelector('.utility-feature-item').classList.toggle('active', state === 'active');
        document.querySelector('.agent-ws-stack-item').classList.toggle('is-active', state === 'active');
      }, state);
      await page.mouse.move(650, 250);
      if (state === 'hover') await utility.hover();
      const utilityColor = await sample(utility);
      if (state === 'hover') await bubble.hover();
      const workspaceColor = await sample(bubble);
      sameColor(workspaceColor, utilityColor, `${theme}/${state} 工作空间与实用功能配色必须相同`);
      await page.evaluate(() => { document.querySelector('.underlay').style.background = 'lime'; });
      sameColor(await sample(bubble), workspaceColor, `${theme}/${state} 重叠胶囊必须不透底`);
      await page.evaluate(() => { document.querySelector('.underlay').style.background = 'red'; });
    }
  }
  assert.equal((await bubble.boundingBox()).height, 38, '停靠工作区与会话行同高');
  const collapsedRowHeight = await page.locator('.agent-ws-stack').evaluate((el) => getComputedStyle(el).getPropertyValue('--ws-row-h').trim());
  assert.equal(collapsedRowHeight, '38px', '折叠位移必须使用停靠行的实际高度');
  console.log('workspace-utility-material-visual: OK (4 themes, 3 states, opaque stack)');
} finally {
  await browser.close();
}
