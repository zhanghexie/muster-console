import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = path.join(root, 'output/playwright/agent-apps-metro');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(pathToFileURL(path.join(root, 'docs/prototypes/agent-apps-metro/index.html')).href);
  await page.locator('.lumia-frame').first().evaluate(image => image.decode());
  const alpha = await page.locator('.lumia-frame').first().evaluate(image => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  assert.equal(alpha, 0, 'device asset really has transparent outer pixels');
  await page.locator('.phone-gallery').screenshot({ path: path.join(output, 'lumia-apps.png') });
  await page.getByRole('button', { name: '单屏体验' }).click();
  const phone = page.locator('.phone');
  const back = phone.getByRole('button', { name: '手机返回' });
  const home = phone.getByRole('button', { name: 'Home 开始屏' });
  const search = phone.getByRole('button', { name: '手机搜索' });
  assert.equal(await phone.getByRole('navigation', { name: '手机按键' }).getByRole('button').count(), 3);
  const geometry = await phone.evaluate(element => {
    const screen = element.querySelector('.phone-display').getBoundingClientRect();
    const shell = element.getBoundingClientRect();
    return [...element.querySelectorAll('.hardware-nav button')].map(key => {
      const r = key.getBoundingClientRect();
      return { name: key.getAttribute('aria-label'), belowScreen: r.top >= screen.bottom,
        insideShell: r.left >= shell.left && r.right <= shell.right && r.bottom <= shell.bottom,
        hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === key };
    });
  });
  assert(geometry.every(key => key.belowScreen && key.insideShell && key.hit), 'all three key targets align below the screen and receive clicks');
  await home.click();
  await phone.locator('[data-app="home"][data-flight="idle"]').waitFor();
  await phone.screenshot({ path: path.join(output, 'lumia-start.png') });
  await search.click();
  const input = phone.getByRole('textbox', { name: '搜索内容' });
  await input.fill('rss');
  assert.equal(await phone.locator('[data-open-app="tasks"]').isVisible(), false);
  assert.equal(await phone.locator('[data-open-app="rss"]').isVisible(), true);
  await home.click();
  await phone.getByRole('button', { name: /短信/ }).click();
  await phone.locator('[data-app="messages"][data-flight="idle"]').waitFor();
  await phone.getByRole('button', { name: /林予安/ }).click();
  await search.click();
  await input.fill('陈默');
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  assert.equal(await phone.getByRole('button', { name: /林予安/ }).count(), 0);
  await back.click();
  assert.equal(await input.count(), 0);
  await phone.getByRole('button', { name: /林予安/ }).click();
  await back.click();
  await phone.getByRole('region', { name: '应用详情' }).waitFor({ state: 'detached' });
  assert.equal(await phone.getByRole('heading', { name: '短信' }).count(), 1);
  await home.click();
  await back.click();
  await phone.locator('[data-app="messages"][data-flight="idle"]').waitFor();
  await page.setViewportSize({ width: 390, height: 1050 });
  await page.getByRole('button', { name: /浅色模式/ }).click();
  await phone.screenshot({ path: path.join(output, 'lumia-narrow-light.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots: 3, geometry,
    checks: ['real alpha', 'three aligned key targets', 'Home', 'nested Back', 'return to previous app', 'search from detail', 'launcher filtering', '390px light', 'no runtime errors'] }, null, 2));
} finally { await browser.close(); }
