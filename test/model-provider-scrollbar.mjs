/** Provider header geometry and hidden-scrollbar wheel/keyboard access. No screenshots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ entryPoints: [path.join(root, 'test/fixtures/model-provider-scroll.tsx')], bundle: true, write: false,
  platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' }, logLevel: 'silent' });
const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executable = process.env.CHROME_EXECUTABLE || (process.platform === 'win32' && fs.existsSync(windowsChrome) ? windowsChrome : undefined);
const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent('<div id="root"></div>');
  for (const file of ['src/renderer/src/styles/base.css', 'src/renderer/src/styles/settings.css',
    'src/renderer/src/components/settings/settings-content.css', 'src/renderer/src/components/settings/settings-resource.css']) {
    await page.addStyleTag({ path: path.join(root, file) });
  }
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const detail = page.locator('.llm-provider-list > .settings-split-main');
  await detail.waitFor();
  async function assertEnabledGeometry(layout) {
    const enabled = detail.locator('.llm-provider-enabled');
    await enabled.scrollIntoViewIfNeeded();
    const geometry = await enabled.evaluate(label => {
      const input = label.querySelector('input[type="checkbox"]');
      const text = label.querySelector(':scope > span');
      const rect = node => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, centerY: box.top + box.height / 2, width: box.width, height: box.height };
      };
      const badge = label.parentElement.querySelector('.llm-badge-default-active');
      const box = input.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { text: rect(text), control: rect(input), badge: rect(badge), inputReachable: hit === input };
    });
    const gap = Math.max(geometry.control.left - geometry.text.right, geometry.text.left - geometry.control.right);
    assert.ok(gap >= 6 - 0.25, `${layout}: enable text and switch need at least 6px clear space`);
    assert.ok(Math.abs(geometry.text.centerY - geometry.control.centerY) <= 1, `${layout}: switch must center vertically with enable label`);
    assert.ok(Math.abs(geometry.badge.centerY - geometry.control.centerY) <= 1, `${layout}: switch must center vertically with default badge`);
    assert.ok(geometry.control.width > 0 && geometry.control.height > 0 && geometry.inputReachable, `${layout}: checkbox must retain a reachable hit target`);
    const checkbox = enabled.getByRole('checkbox', { name: '启用 示例供应商' });
    const checked = await checkbox.isChecked();
    await enabled.locator(':scope > span').click();
    assert.equal(await checkbox.isChecked(), !checked, `${layout}: clicking the label must toggle the real checkbox`);
    await checkbox.focus();
    await page.keyboard.press('Space');
    assert.equal(await checkbox.isChecked(), checked, `${layout}: keyboard must toggle the real checkbox`);
  }
  await assertEnabledGeometry('wide');
  await detail.hover();
  const state = await detail.evaluate(node => ({
    scrollbarWidth: getComputedStyle(node).scrollbarWidth,
    webkitDisplay: getComputedStyle(node, '::-webkit-scrollbar').display,
    overflowY: getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight, clientHeight: node.clientHeight
  }));
  assert.equal(state.scrollbarWidth, 'none', 'provider scrollbar must stay hidden even on hover');
  assert.equal(state.webkitDisplay, 'none', 'WebKit scrollbar must stay hidden');
  assert.equal(state.overflowY, 'auto');
  assert.ok(state.scrollHeight > state.clientHeight, 'fixture must exercise an overflowing provider detail');
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.querySelector('.llm-provider-list > .settings-split-main').scrollTop > 0);
  await detail.evaluate(node => { node.scrollTop = 0; });
  await detail.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => document.querySelector('.llm-provider-list > .settings-split-main').scrollTop > 0);
  assert.notEqual(await page.locator('.settings-split-list').evaluate(node => getComputedStyle(node).scrollbarWidth), 'none', 'provider list scrollbar must not be affected');
  await page.setViewportSize({ width: 800, height: 800 });
  await assertEnabledGeometry('narrow');
  const outer = page.locator('.settings-page > main');
  assert.equal(await detail.evaluate(node => getComputedStyle(node).overflowY), 'visible', 'narrow layout should continue to use the outer scroller');
  await detail.hover({ position: { x: 100, y: 100 } });
  const beforeWheel = await outer.evaluate(node => node.scrollTop);
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(before => document.querySelector('.settings-page > main').scrollTop > before, beforeWheel);
  console.log('model-provider-scrollbar: ok');
} finally { await browser.close(); }
