import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(pathToFileURL(path.join(project, 'output/color-system-native/preview-check.html')).href);
  const frame = page.frameLocator('iframe');
  const root = frame.locator('#color-system-native-preview');
  await root.waitFor();
  assert.equal(await root.getAttribute('data-selection'), 'dark-balanced');
  for (const [theme, themeLabel] of [['dark', '深色'], ['light', '浅色']]) {
    await frame.getByRole('button', { name: themeLabel, exact: true }).click();
    for (const [mode, modeLabel] of [['original', '原版'], ['balanced', '微调']]) {
      await frame.getByRole('button', { name: modeLabel, exact: true }).click();
      assert.equal(await root.getAttribute('data-selection'), `${theme}-${mode}`);
      await root.locator('img').evaluate(img => img.decode());
      assert.deepEqual(await root.locator('img').evaluate(img => [img.naturalWidth, img.naturalHeight]), [1440, 900]);
      assert.equal(await frame.getByRole('button', { name: modeLabel, exact: true }).getAttribute('aria-pressed'), 'true');
    }
  }
  await frame.getByRole('button', { name: '深色', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.equal(await root.getAttribute('data-selection'), 'dark-balanced');
  await page.screenshot({ path: path.join(project, 'output/color-system-native/preview-wide.png') });
  await page.setViewportSize({ width: 640, height: 800 });
  await frame.getByRole('button', { name: '放大', exact: true }).click();
  assert.equal(await root.locator('img').evaluate(img => getComputedStyle(img).width), '1440px');
  assert.ok(await root.locator('.native-preview-image').evaluate(el => el.scrollWidth > el.clientWidth));
  await frame.getByRole('button', { name: '适应', exact: true }).click();
  assert.ok(await root.locator('img').evaluate(img => img.getBoundingClientRect().width <= innerWidth));
  await page.screenshot({ path: path.join(project, 'output/color-system-native/preview-narrow.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['four actual images decoded', 'theme and version controls', 'keyboard activation', 'zoom overflow and fit', 'no page errors'] }));
} finally { await browser.close(); }
