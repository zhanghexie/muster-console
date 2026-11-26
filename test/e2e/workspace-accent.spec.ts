import { test as base, expect, _electron } from '@playwright/test';
import type { AppContext } from './fixtures/electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 只测试外观配置，不重置共享开发沙盒，也不继承个人配置。
const repoRoot = path.resolve(__dirname, '../..');
const test = base.extend<{}, { appCtx: AppContext }>({
  appCtx: [async ({}, use) => {
    fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
    const cwd = fs.mkdtempSync(path.join(repoRoot, '.tmp/e2e-accent-'));
    const userData = path.join(cwd, '.dev-sandbox/userData');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
      locale: 'zh-CN', themeId: 'dark', uiFont: 'oppo', activeWorkspaceId: 'demo-playground',
      workspaces: [], mcp: { enabled: false, servers: [] }
    }));
    fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    env.MUSTER_SANDBOX = '1';
    env.MUSTER_INSTANCE_ID = path.basename(cwd);
    for (const key of ['MUSTER_NO_SANDBOX', 'MUSTER_DEV_MOBILE_WS', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
    const app = await _electron.launch({ executablePath: createRequire(__filename)('electron'), args: [repoRoot], cwd, env, timeout: 60_000 });
    try {
      const win = await app.firstWindow();
      const consoleErrors: string[] = [];
      win.on('pageerror', e => consoleErrors.push(e.message));
      await win.waitForSelector('.app-shell', { timeout: 60_000 });
      await use({ app, win, consoleErrors });
    } finally {
      await app.evaluate(({ app }) => app.exit()).catch(() => {});
      await app.close().catch(() => {});
    }
  }, { scope: 'worker' }]
});

test('主题色设置：全局/工作区作用域、恢复继承与重载后渲染', async ({ appCtx }, testInfo) => {
  const page = appCtx.win;
  const ids = await page.evaluate(async () => {
    const cfg = await window.api.config.get();
    const active = cfg.activeWorkspaceId;
    const other = cfg.workspaces.find(w => w.id !== active)!.id;
    await window.api.config.update({ locale: 'zh-CN', workspaceAccentDefault: { accent: '#8b7bff', enabled: true } });
    await window.api.workspaces.update(active, { accent: null, accentOff: false });
    await window.api.workspaces.update(other, { accent: '#f06a8a', accentOff: false });
    return { active, other };
  });
  await page.locator('.chrome-settings').click();
  await page.locator('.settings-nav-item').filter({ hasText: '外观' }).click();
  const section = page.locator('[data-settings-item="appearance-accent"]');
  await expect(section).toBeVisible();
  await section.getByRole('button', { name: '#2fc4b2', exact: true }).click();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ws-accent').trim())).toBe('#2fc4b2');
  const otherAccent = await page.evaluate(async id => (await window.api.config.get()).workspaces.find(w => w.id === id)?.accent, ids.other);
  expect(otherAccent).toBe('#f06a8a');
  await section.getByRole('button', { name: '仅当前工作区', exact: true }).click();
  await section.getByRole('button', { name: '#f0a24a', exact: true }).click();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ws-accent').trim())).toBe('#f0a24a');
  // 控件等待主进程保存成功后才提交 checked；click + 自动重试断言覆盖完整 IPC 往返。
  await section.getByRole('checkbox', { name: '启用主题色' }).click();
  await expect(section.getByRole('checkbox', { name: '启用主题色' })).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--workspace-frame-color'))).toBe('var(--bg-frame)');
  await section.getByRole('checkbox', { name: '启用主题色' }).click();
  await expect(section.getByRole('checkbox', { name: '启用主题色' })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('accent-workspace.png') });
  await section.getByRole('button', { name: '恢复跟随全局', exact: true }).click();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ws-accent').trim())).toBe('#2fc4b2');
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ws-accent').trim())).toBe('#2fc4b2');
  const cfg = await page.evaluate(() => window.api.config.get());
  expect(cfg.workspaceAccentDefault).toEqual({ accent: '#2fc4b2', enabled: true });
  expect(cfg.workspaces.find(w => w.id === ids.active)?.accent).toBeUndefined();
  await page.locator('.chrome-settings').click();
  await page.locator('.settings-nav-item').filter({ hasText: '外观' }).click();
  await section.scrollIntoViewIfNeeded();
  await page.mouse.move(1200, 18);
  await page.screenshot({ path: testInfo.outputPath('accent-global.png') });
  await page.evaluate(() => window.api.themes.activate('light', { scope: 'workspace' }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: testInfo.outputPath('accent-light.png') });
  const customLayout = await section.locator('.workspace-accent-custom').evaluate(el => {
    const label = el.getBoundingClientRect();
    const input = el.querySelector('input')!.getBoundingClientRect();
    return { direction: getComputedStyle(el).flexDirection, height: label.height, inputCenter: input.y + input.height / 2, center: label.y + label.height / 2 };
  });
  expect(customLayout.direction).toBe('row');
  expect(Math.abs(customLayout.inputCenter - customLayout.center)).toBeLessThan(2);
  expect(appCtx.consoleErrors).toEqual([]);
});
