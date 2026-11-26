import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

for (const theme of ['dark', 'light'] as const) test(`indicator mounts and stops in ${theme} theme`, async () => {
  fs.mkdirSync('.tmp', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-indicator-e2e-'));
  const entry = path.join(temp, 'main.cjs');
  await build({ entryPoints: ['test/e2e/fixtures/desktop-indicator-main.ts'], outfile: entry, bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const app = await electron.launch({ args: [entry], env: { ...process.env, MUSTER_TEST_USER_DATA: temp, MUSTER_TEST_THEME: theme } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('AI 正在操作电脑')).toBeVisible();
    await expect(page.getByText('Esc 停止')).toBeVisible();
    const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
      const bounds = BrowserWindow.getAllWindows()[0].getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      return { right: area.x + area.width - bounds.x - bounds.width, top: bounds.y - area.y };
    });
    expect(geometry.right).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(12);
    expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.top).toBeLessThanOrEqual(12);
    fs.mkdirSync('.tmp/ui-captures', { recursive: true });
    if (theme === 'dark') await page.screenshot({ path: '.tmp/ui-captures/desktop-indicator.png' });
    await page.setViewportSize({ width: 320, height: 72 });
    await expect(page.getByRole('button', { name: '停止' })).toBeVisible();
    if (theme === 'light') await page.screenshot({ path: '.tmp/ui-captures/desktop-indicator-light-narrow.png' });
    await page.getByRole('button', { name: '停止' }).click();
    await expect(page.getByRole('status')).toHaveText('正在停止');
    await expect(page.getByRole('button', { name: '停止' })).toBeDisabled();
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('English stop control and fallback hint fit a narrow indicator', async () => {
  fs.mkdirSync('.tmp', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-indicator-e2e-'));
  const entry = path.join(temp, 'main.cjs');
  await build({ entryPoints: ['test/e2e/fixtures/desktop-indicator-main.ts'], outfile: entry, bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const app = await electron.launch({ args: [entry], env: { ...process.env, MUSTER_TEST_USER_DATA: temp,
    MUSTER_TEST_THEME: 'light', MUSTER_TEST_LANGUAGE: 'en', MUSTER_TEST_ESCAPE: 'unavailable' } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 320, height: 72 });
    const button = page.getByRole('button', { name: 'Stop' });
    const hint = page.getByText('Use Stop to end');
    await expect(button).toBeVisible(); await expect(hint).toBeVisible();
    const metrics = await page.evaluate(() => {
      const button = document.querySelector('button')!.getBoundingClientRect();
      const hint = document.querySelector('.desktop-indicator__hint')! as HTMLElement;
      const target = document.querySelector('.desktop-indicator__target')! as HTMLElement;
      return { buttonLeft: button.left, buttonRight: button.right, hintRight: hint.getBoundingClientRect().right,
        hintFits: hint.scrollWidth <= hint.clientWidth, targetFits: target.scrollWidth <= target.clientWidth };
    });
    expect(metrics.buttonRight).toBeLessThanOrEqual(320);
    expect(metrics.hintRight).toBeLessThanOrEqual(metrics.buttonLeft);
    expect(metrics.hintFits).toBe(true);
    expect(metrics.targetFits).toBe(true);
    fs.mkdirSync('.tmp/ui-captures', { recursive: true });
    await page.screenshot({ path: '.tmp/ui-captures/desktop-indicator-en-narrow.png' });
    await button.click();
    await expect(page.getByRole('status')).toHaveText('Stopping computer use');
  } finally { await app.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
