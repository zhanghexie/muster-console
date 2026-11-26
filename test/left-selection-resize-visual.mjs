/** 用 Chromium 实际绘制验证虚拟屏拖宽只浮百分比卡片（无快照遮罩，活内容可见）与左栏选中态。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
const browser = await chromium.launch({
  headless: true,
  ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {})
});

try {
  const page = await browser.newPage({ viewport: { width: 800, height: 360 } });
  await page.setContent(`
    <div class="utility-feature-list" style="width:240px">
      <button class="utility-feature-item session-item">定时任务</button>
      <button class="utility-feature-item session-item active">使用统计</button>
    </div>
    <div class="session-list" style="width:240px">
      <div class="session-item">未选会话</div>
      <div class="session-item active">当前会话</div>
    </div>
    <div class="h-strip" style="position:absolute;left:350px;top:0;width:400px;height:300px">
      <div class="resize-live" style="position:absolute;inset:0;background:red"></div>
      <div class="ws-resize-ind-pos" style="left:0;width:400px">
        <div class="ws-resize-card" style="width:240px;height:140px">
          <div class="ws-resize-card-bar"></div>
          <div class="ws-resize-card-mid"><div class="ws-resize-card-label">终端</div><div class="ws-resize-card-num">78%</div></div>
          <div class="ws-resize-card-bar"></div>
        </div>
      </div>
    </div>
  `);
  await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles/base.css') });
  await page.addStyleTag({ path: path.join(root, 'src/renderer/src/styles/left.css') });
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const selected = await page.evaluate(() => {
    const css = (selector) => getComputedStyle(document.querySelector(selector));
    return {
      utility: css('.utility-feature-item.active').backgroundColor,
      utilityIdle: css('.utility-feature-item:not(.active)').backgroundColor,
      session: css('.session-list .session-item.active').backgroundColor,
      sessionIdle: css('.session-list .session-item:not(.active)').backgroundColor,
      sessionHeight: document.querySelector('.session-list .session-item.active').getBoundingClientRect().height
    };
  });
  assert.equal(selected.utility, selected.session, '实用功能和会话行应使用同一选中底色');
  assert.notEqual(selected.utility, selected.utilityIdle, '实用功能选中态必须有可见底色');
  assert.notEqual(selected.session, selected.sessionIdle, '会话选中态必须有可见底色');
  const alpha = (value) => Number(value.match(/,\s*([\d.]+)\)$/)?.[1] ?? 1);
  assert.ok(alpha(selected.utility) - alpha(selected.utilityIdle) >= 0.08, '实用功能选中对比不足');
  assert.ok(selected.sessionHeight >= 36, '会话行应比旧 32px 稍高');

  const png = await page.screenshot();
  const pixels = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const brightness = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3).reduce((a, b) => a + b) / 3;
    return { card: brightness(550, 95), live: brightness(550, 25) };
  }, png.toString('base64'));
  assert.ok(pixels.live < 120, '拖宽时活内容必须直接可见——遮罩已移除（2026-10-10 用户定稿）');
  assert.ok(pixels.card < 120 || pixels.card > 0, '百分比卡片浮在活内容之上');
  assert.ok(pixels.card < 120, '百分比卡片实底必须清晰可读');

  // 无遮罩契约：翻转活内容颜色，覆盖层不得挡住重排——像素必须跟着变
  const sampleLive = async () => {
    const shot = await page.screenshot();
    return page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return [[550, 25], [351, 150], [748, 150], [550, 298]].map(([x, y]) =>
        Array.from(ctx.getImageData(x, y, 1, 1).data));
    }, shot.toString('base64'));
  };
  const beforeReflow = await sampleLive();
  await page.evaluate(() => { document.querySelector('.resize-live').style.background = 'lime'; });
  const afterReflow = await sampleLive();
  assert.notDeepEqual(afterReflow, beforeReflow, '覆盖层不得遮挡活内容：重排必须实时可见（无快照遮罩）');

  // 浅色磁贴选中底检查：token 走真实管线解析（配色系统重构后磁贴消费
  // --interaction-hover/--interaction-selected，由 resolveAppearance 从内置浅色
  // 主题派生；旧 --hover-fill/--hover-fill-strong 已废弃，手设它们两磁贴同色）
  const compile = createSharedCompiler(root, path.join(root, '.tmp/ui-captures/left-selection-compiled'));
  const { BUILTIN_THEMES } = await import(pathToFileURL(compile('shared/theme.ts')).href);
  const { resolveAppearance } = await import(pathToFileURL(compile('shared/resolvedAppearance.ts')).href);
  const lightTheme = BUILTIN_THEMES.find(theme => theme.appearance === 'light');
  const appearance = resolveAppearance(lightTheme);
  const light = await page.evaluate(({ hover, selected, selectedHover }) => {
    const root = document.documentElement.style;
    root.setProperty('--interaction-hover', hover);
    root.setProperty('--interaction-selected', selected);
    root.setProperty('--interaction-selected-hover', selectedHover);
    const paint = (selector) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = getComputedStyle(document.querySelector(selector)).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3).reduce((a, b) => a + b) / 3;
    };
    return { active: paint('.utility-feature-item.active'), idle: paint('.utility-feature-item:not(.active)') };
  }, {
    hover: appearance.interactions.hover,
    selected: appearance.interactions.selected,
    selectedHover: appearance.interactions.selectedHover
  });
  assert.ok(light.idle - light.active >= 12, '浅色主题的选中底也应比静息磁贴更深');
  console.log('left-selection-resize-visual: OK');
} finally {
  await browser.close();
}
