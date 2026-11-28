import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

test('stop button interrupts an active desktop run and reports its uncertain result', async () => {
  fs.mkdirSync('.tmp', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-activity-e2e-'));
  const entry = path.join(temp, 'main.cjs');
  await build({ entryPoints: ['test/e2e/fixtures/desktop-activity-main.ts'], outfile: entry, bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const app = await electron.launch({ args: [entry], env: { ...process.env, MUSTER_TEST_USER_DATA: temp } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('AI 正在操作电脑')).toBeVisible();
    await expect(page.getByText('请点停止')).toBeVisible();
    await page.getByRole('button', { name: '停止' }).click();
    await expect(page.getByRole('status')).toHaveText('结果未知');
    await expect(page.getByRole('button', { name: '停止' })).toBeDisabled();
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a hidden indicator stops parallel reads and is rebuilt for a new user instruction', async () => {
  fs.mkdirSync('.tmp', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-activity-recovery-e2e-'));
  const entry = path.join(temp, 'main.cjs');
  await build({ entryPoints: ['test/e2e/fixtures/desktop-activity-main.ts'], outfile: entry, bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const app = await electron.launch({ args: [entry], env: { ...process.env, MUSTER_TEST_USER_DATA: temp,
    MUSTER_TEST_DESKTOP_RECOVERY: '1' } });
  try {
    const oldPage = await app.firstWindow();
    await expect(oldPage.getByRole('button', { name: '停止' })).toBeVisible();
    await expect.poll(() => app.evaluate(() => (globalThis as any).desktopRecovery.started)).toEqual(['look']);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.isVisible())!.hide());
    const outcomes = await app.evaluate(() => (globalThis as any).desktopRecovery.outcome);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) expect(outcome).toMatch(/Desktop indicator window hidden.*Muster Console/);
    expect(await app.evaluate(() => (globalThis as any).desktopRecovery.started)).toEqual(['look']);
    expect(await app.evaluate(() => (globalThis as any).desktopRecovery.retry(false))).toMatch(/new instruction|新指令/);

    expect(await app.evaluate(() => (globalThis as any).desktopRecovery.retry(true))).toBe('resumed');
    const replacement = () => app.windows().find(candidate => candidate !== oldPage && !candidate.isClosed());
    await expect.poll(() => !!replacement()).toBe(true);
    const recovered = replacement()!;
    await expect(recovered.getByText('调度 · 桌面测试')).toBeVisible();
    await expect(recovered.getByRole('button', { name: '停止' })).toBeVisible();
    fs.mkdirSync('.tmp/ui-captures', { recursive: true });
    await recovered.screenshot({ path: '.tmp/ui-captures/desktop-indicator-recovered.png' });
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Windows Escape monitor starts alongside the visible activity and is reclaimed on stop', async () => {
  test.skip(process.platform !== 'win32', 'The real native hook test requires Windows');
  fs.mkdirSync('.tmp', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-activity-hook-e2e-'));
  const entry = path.join(temp, 'main.cjs');
  await build({ entryPoints: ['test/e2e/fixtures/desktop-activity-main.ts'], outfile: entry, bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const app = await electron.launch({ args: [entry], env: { ...process.env, MUSTER_TEST_USER_DATA: temp,
    MUSTER_TEST_REAL_ESCAPE_MONITOR: '1' } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('AI 正在操作电脑')).toBeVisible();
    await expect(page.getByText('Esc 停止')).toBeVisible();
    await page.getByRole('button', { name: '停止' }).click();
    await expect(page.getByRole('status')).toHaveText('结果未知');
    await expect.poll(() => app.evaluate(() => (globalThis as any).__escapeMonitorStopped === true)).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
