/** CSS 回归：按生产标题 DOM 验证悬浮块、按钮几何及四个标题的左对齐。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp/sidebar-header-visual');
fs.mkdirSync(output, { recursive: true });
const themeScript = await build({ stdin: { contents: `
  import { applyTheme } from './src/renderer/src/theme';
  import { builtinTheme } from './src/shared/theme';
  window.setTheme = name => applyTheme(builtinTheme(name));
`, resolveDir: root }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
const caret = '<svg class="panel-header-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 9 6 6 6-6" /></svg>';
try {
  const page = await browser.newPage({ viewport: { width: 460, height: 420 } });
  await page.setContent(`<aside class="left-panel" style="width:280px;height:400px">
    <section class="utility-navigation"><div class="utility-navigation-title panel-header-label"><span>实用工具</span><button class="panel-header-toggle" aria-expanded="true">${caret}</button></div></section>
    ${['工作会话', '终端'].map(label => `<div class="panel-header sub"><div class="panel-header-label"><span>${label}</span><button class="panel-header-toggle" aria-expanded="true">${caret}</button></div><div class="session-header-actions"><button class="git-btn ghost tiny">＋</button></div></div>`).join('')}
    <div class="left-ws-slot"><div class="agent-ws-stack"><div class="agent-ws-stack-header"><span class="agent-ws-stack-label">工作区</span><button class="agent-ws-collapse-btn">${caret.replace('panel-header-chevron', 'agent-ws-collapse-caret')}</button><button class="agent-ws-add-btn">+</button></div></div></div>
  </aside>`);
  for (const file of ['base', 'float', 'left', 'extension-navigation']) {
    await page.addStyleTag({ path: path.join(root, `src/renderer/src/styles/${file}.css`) });
  }
  await page.addScriptTag({ content: themeScript.outputFiles[0].text });
  await page.addStyleTag({ content: 'body { background:var(--surface-frame); }' });
  const freeze = await page.addStyleTag({ content: '* { transition:none!important; }' });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => window.setTheme(theme), theme);
    for (const width of [200, 280]) {
      await page.locator('.left-panel').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
      const lefts = await page.locator('.panel-header-label > span, .agent-ws-stack-label').evaluateAll(els => els.map(el => el.getBoundingClientRect().left));
      assert.equal(lefts.length, 4);
      for (const left of lefts) assert.equal(left, lefts[0], `${theme}/${width}: 四个标题左缘一致`);
      const reference = await page.locator('.agent-ws-collapse-btn').evaluate(el => {
        const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
        return { width: r.width, height: r.height, radius: s.borderRadius };
      });
      for (const selector of ['.panel-header-toggle', '.session-header-actions .git-btn', '.agent-ws-add-btn']) {
        for (const element of await page.locator(selector).all()) {
          assert.deepEqual(await element.evaluate(el => {
            const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
            return { width: r.width, height: r.height, radius: s.borderRadius };
          }), reference, `${theme}/${width}/${selector}: 按钮尺寸和圆角一致`);
        }
      }
      await page.locator('.agent-ws-stack-header').hover();
      await page.locator('.agent-ws-collapse-btn').hover();
      const expected = await page.locator('.agent-ws-collapse-btn').evaluate(el => getComputedStyle(el).backgroundColor);
      assert.notEqual(expected, 'rgba(0, 0, 0, 0)', '工作区悬浮底可见');
      const targets = ['.panel-header-toggle', '.session-header-actions .git-btn', '.agent-ws-add-btn'];
      for (const selector of targets) {
        for (const [index, element] of (await page.locator(selector).all()).entries()) {
          // 先移入标题区域，使按需显现的按钮可命中。
          await element.locator('xpath=ancestor::*[contains(@class,"panel-header") or contains(@class,"agent-ws-stack-header") or contains(@class,"utility-navigation-title")][1]').hover();
          await element.hover();
          assert.equal(await element.evaluate(el => getComputedStyle(el).backgroundColor), expected, `${theme}/${width}/${selector}: 悬浮背景同源`);
          if (selector === '.panel-header-toggle' && width === 280 && index === 0) {
            await page.screenshot({ path: path.join(output, `${theme}-${width}-${index}.png`) });
          }
        }
      }
      // 背景必须属于按钮：在旋转的任意中间角度也不跟随 SVG。
      await page.locator('.panel-header-toggle').evaluateAll(els => els.forEach(el => el.setAttribute('aria-expanded', 'false')));
      for (const toggle of await page.locator('.panel-header-toggle').all()) {
        await toggle.hover();
        const styles = await toggle.evaluate(el => ({
          transform: getComputedStyle(el).transform,
          background: getComputedStyle(el).backgroundColor,
          arrowBackground: getComputedStyle(el.firstElementChild).backgroundColor,
          arrowTransform: getComputedStyle(el.firstElementChild).transform
        }));
        assert.equal(styles.transform, 'none');
        assert.equal(styles.background, expected);
        assert.equal(styles.arrowBackground, 'rgba(0, 0, 0, 0)');
        assert.notEqual(styles.arrowTransform, 'none');
      }
      await page.locator('.panel-header-toggle').evaluateAll(els => els.forEach(el => el.setAttribute('aria-expanded', 'true')));
    }
  }
  await freeze.evaluate(el => el.remove());
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => window.setTheme(theme), theme);
    const toggle = page.locator('.panel-header-toggle').first();
    await toggle.hover();
    await toggle.evaluate(async el => {
      getComputedStyle(el.firstElementChild).transform;
      el.setAttribute('aria-expanded', 'false');
      await new Promise(requestAnimationFrame);
      for (const animation of el.firstElementChild.getAnimations()) {
        animation.pause();
        animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
      }
    });
    assert.equal(await toggle.evaluate(el => getComputedStyle(el).transform), 'none', '旋转中间帧：背景按钮不旋转');
    assert.equal(await toggle.locator('svg').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    const angleCos = await toggle.locator('svg').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
    assert.ok(angleCos > 0.1 && angleCos < 0.99, '实际箭头处于旋转中间角度');
    await page.screenshot({ path: path.join(output, `${theme}-rotation.png`), animations: 'allow' });
    await toggle.evaluate(el => { el.firstElementChild.getAnimations().forEach(animation => animation.finish()); el.setAttribute('aria-expanded', 'true'); });
    await page.waitForTimeout(150);
  }
  console.log('sidebar-header-visual: OK (2 themes × 2 widths; title alignment, button geometry, real hover)');
} finally {
  await browser.close();
}
