import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = path.join(root, 'output/playwright/agent-apps-metro');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1050 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const preview = pathToFileURL(path.join(root, 'docs/prototypes/agent-apps-metro/index.html')).href;
const settle = () => page.locator('.metro-scene[data-active="true"][data-flight="idle"]').waitFor();
const picker = page.getByRole('navigation', { name: '选择应用' });
const frame = page.locator('.phone');
async function launcher() {
  await page.goto(preview);
  await page.getByRole('button', { name: '单屏体验' }).click();
  await picker.getByRole('button', { name: '开始' }).click();
  await frame.locator('[data-app="home"][data-active="true"]').waitFor();
  await settle();
}
try {
  await launcher();
  // Sample a real, uninterrupted flight. CSS matrices must actually rotate, and
  // the header must be ahead of its list; DOM data attributes alone aren't proof.
  const samples = await page.evaluate(async () => {
    const result = [];
    document.querySelector('[data-open-app="messages"]').click();
    const start = performance.now();
    while (performance.now() - start < 950) {
      await new Promise(requestAnimationFrame);
      const read = selector => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const css = getComputedStyle(element);
        return { opacity: +css.opacity, transform: css.transform, delay: css.transitionDelay };
      };
      result.push({ ms: Math.round(performance.now() - start),
        tile: read('[data-app="home"] .tile'),
        title: read('[data-app="messages"] .app-heading'),
        row: read('[data-app="messages"] .conversation'),
      });
    }
    return result;
  });
  assert(samples.some(s => s.tile?.transform.startsWith('matrix3d(') && s.tile.opacity > 0 && s.tile.opacity < 1), 'outgoing tiles rotate visibly');
  assert(samples.some(s => s.title?.transform.startsWith('matrix3d(') && s.title.opacity > 0 && s.title.opacity < 1), 'incoming title flies in');
  assert(samples.some(s => s.title?.opacity > 0.5 && s.row?.opacity < 0.2), 'title leads the list');
  await settle();
  assert.equal(await frame.locator('.metro-scene').count(), 1);
  assert.equal(await frame.locator('.app-heading').evaluate(el => getComputedStyle(el).transform), 'none', 'resting text releases 3D transforms');

  // Pause actual browser transitions at exact progress for reviewable frames.
  // Every frame starts from a fresh navigation; no synthetic layout is rendered.
  for (const ms of [80, 240, 380, 650]) {
    await launcher();
    await page.evaluate(async ms => {
      document.querySelector('[data-open-app="messages"]').click();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      for (const animation of document.querySelector('.phone').getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = ms;
      }
    }, ms);
    await frame.screenshot({ path: path.join(output, `motion-${ms}.png`) });
  }

  await launcher();
  await frame.getByRole('button', { name: /短信/ }).click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('[data-open-app="rss"]').click());
  await settle();
  assert.equal(await frame.locator('.metro-scene').count(), 1, 'rapid reversal leaves one scene');
  assert.equal(await frame.locator('[data-app="rss"]').count(), 1);
  await frame.getByRole('button', { name: /让工具退后/ }).click();
  await frame.getByRole('region', { name: '应用详情' }).waitFor();
  await frame.getByRole('button', { name: '返回列表' }).click();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await frame.getByRole('button', { name: 'Home 开始屏', exact: true }).click();
  await frame.getByRole('button', { name: /待办/ }).click();
  assert.equal(await frame.locator('.metro-scene').count(), 1);
  assert.equal(await frame.evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'OS reduction disables staggers and turns');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: /浅色模式/ }).click();
  await frame.getByRole('button', { name: 'Home 开始屏', exact: true }).click();
  await settle();
  await frame.getByRole('button', { name: /阅读/ }).click();
  await settle();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await frame.screenshot({ path: path.join(output, 'motion-narrow-light.png') });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'motion-samples.json'), JSON.stringify(samples, null, 2));
  console.log(JSON.stringify({ ok: true, frames: 5, samples: samples.length,
    checks: ['actual 3D matrices', 'stagger order', 'resting text', 'rapid reversal', 'reader still works', 'OS reduced motion', '390px light layout', 'no runtime errors'], output }, null, 2));
} finally { await browser.close(); }
