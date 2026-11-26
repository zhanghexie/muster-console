import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(__dirname, '../..');
const requireModule = createRequire(__filename);

test('Channels account settings use the bundled providers and source-scoped authorization', async () => {
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const temp = fs.mkdtempSync(path.join(root, '.tmp/messaging-electron-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const main = path.join(temp, 'main.cjs'), renderer = path.join(temp, 'renderer.js');
    execFileSync(process.execPath, ['scripts/build-messaging.mjs', path.join(temp, 'messaging')], { cwd: root, timeout: 30000 });
    await build({ entryPoints: [path.join(root, 'test/fixtures/messaging-electron-main.ts')], outfile: main,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await build({ entryPoints: [path.join(root, 'test/fixtures/logical-channels-electron-renderer.tsx')], outfile: renderer,
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const html = path.join(temp, 'index.html');
    fs.writeFileSync(html, `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/renderer/src/styles/base.css')).href}"><link rel="stylesheet" href="${pathToFileURL(path.join(temp, 'renderer.css')).href}"></head><body><div id="root"></div><script src="${pathToFileURL(renderer).href}"></script></body></html>`);
    fs.mkdirSync(path.join(temp, 'profile'));
    const env: NodeJS.ProcessEnv = { ...process.env, MUSTER_MESSAGING_E2E_PROFILE: path.join(temp, 'profile'), MUSTER_MESSAGING_E2E_HTML: html,
      MUSTER_MESSAGING_E2E_PRELOAD: path.join(root, 'test/fixtures/logical-channels-electron-preload.cjs') };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath: requireModule('electron') as string, args: [main], env: env as Record<string, string> });
    const page = await application.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.getByRole('button', { name: '连接账号' }).click();
    const provider = page.getByRole('combobox', { name: '选择消息服务' })
      .or(page.getByRole('button', { name: '选择消息服务' }));
    await expect(provider).toBeVisible();
    const native = await provider.evaluate(element => element.tagName === 'SELECT');
    async function selectProvider(key: string, name: string): Promise<void> {
      if (native) {
        await provider.selectOption(key);
      } else {
        await provider.click();
        await page.getByRole('option', { name, exact: true }).click();
      }
    }
    if (native) await expect(provider.locator('option')).toHaveCount(14);
    const result = await page.evaluate(async () => {
      const status = await window.api.messaging.status();
      const channels = await Promise.all(status.channels.filter(item => item.supported).map(async item =>
        (await window.api.messaging.call(item.key, 'connection.status', {})).ok));
      const oldPairing = await window.api.messaging.call('weixin', 'remote.begin', { botId: 'fixture-bot' });
      const oldSettings = await window.api.messaging.call('dsh-im-settings', 'settings.inbound-ttl.get', {});
      const oldModel = await window.api.messaging.call('weixin', 'bot.model.set', { botId: 'fixture-bot' });
      return { channels, count: status.channels.length, oldPairing, oldSettings, oldModel };
    });
    expect(result.count).toBe(14);
    expect(result.channels.every(Boolean)).toBe(true);
    expect(result.oldPairing).toMatchObject({ ok: false, error: { code: 'remote-managed-by-workbench' } });
    expect(result.oldSettings).toMatchObject({ ok: false, error: { code: 'unknown-channel' } });
    expect(result.oldModel).toMatchObject({ ok: false, error: { code: 'remote-managed-by-workbench' } });

    await selectProvider('telegram', 'Telegram');
    await page.getByRole('button', { name: '填写 Bot Token' }).click();
    await expect(page.getByLabel('Bot Token', { exact: true })).toHaveAttribute('type', 'password');
    await selectProvider('imessage', 'iMessage');
    if (process.platform === 'darwin') {
      await page.getByRole('button', { name: '配置本机权限' }).click();
      await expect(page.getByText(/AI 回复以 🤖 Muster 开头/)).toBeVisible();
      await expect(page.getByText(/DeepSeek Harness|🤖 DSH/)).toHaveCount(0);
      const capture = path.join(root, '.tmp/ui-captures/channels-account-refactor');
      fs.mkdirSync(capture, { recursive: true });
      for (const [theme, width] of [['dark', 900], ['light', 390]] as const) {
        await page.evaluate(mode => (window as unknown as { setChannelTestTheme(mode: 'light' | 'dark'): void }).setChannelTestTheme(mode), theme);
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: path.join(capture, `imessage-${theme}-${width}.png`), animations: 'disabled' });
      }
    } else {
      await expect(page.getByText('iMessage 仅在 macOS 上通过「信息」应用连接。')).toBeVisible();
    }
    await selectProvider('office', 'AI Office 任务连接器');
    await expect(page.getByText(/AI Office 是独立的任务连接器/)).toBeVisible();
    await expect(page.getByRole('button', { name: '生成绑定码' })).toHaveCount(0);
    await page.getByRole('button', { name: '返回 Channels' }).click();
    await expect(page.getByRole('button', { name: '连接账号' })).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(fs.readdirSync(path.join(temp, 'profile/messaging'))).not.toContain('credentials.json');
  } finally {
    await application?.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
});
