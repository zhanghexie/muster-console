import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('外观设置选择内置符号，真实配置落盘及应用重启后保持选中', async () => {
  const project = path.resolve(__dirname, '../..');
  const cwd = fs.mkdtempSync(path.join(project, '.tmp', 'user-symbol-e2e-'));
  const userData = path.join(cwd, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    userAvatar: { kind: 'emoji', value: 'scout', displayName: '我自己的名字' },
    workspaces: [], mcp: { enabled: false, servers: [] } }));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = path.basename(cwd);
  let app: ElectronApplication | undefined;
  try {
    for (let round = 0; round < 2; round++) {
      app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
      const win = await app.firstWindow();
      await win.locator('.app-shell').waitFor({ timeout: 60_000 });
      await win.getByRole('button', { name: '设置', exact: true }).click();
      await win.locator('.settings-nav-item').filter({ hasText: '外观' }).click();
      const section = win.locator('.user-avatar-settings');
      await section.scrollIntoViewIfNeeded();
      const symbols = section.getByRole('listbox', { name: '内置符号' });
      await expect(symbols.getByRole('option')).toHaveCount(24);
      if (round === 0) {
        await expect(symbols.getByRole('option', { name: '星探（探索者）' })).toHaveAttribute('aria-selected', 'true');
        await expect(section.locator('.create-ws-avatar-preview img')).toHaveAttribute('src', /scout-[\w-]+\.webp$/);
        await symbols.getByRole('option', { name: '像素（设计师）' }).click();
        await expect.poll(() => win.evaluate(async () => (await window.api.config.get()).userAvatar))
          .toEqual({ kind: 'builtin', value: 'pixel', displayName: '我自己的名字' });
        await expect(section.getByRole('option')).toHaveCount(24);
        await expect(section.getByPlaceholder('自定义 emoji')).toHaveCount(0);
        await expect(section.getByRole('button', { name: '用 emoji' })).toHaveCount(0);
        await symbols.getByRole('option', { name: '信使（协调员）' }).click();
      }
      const selected = symbols.getByRole('option', { name: '信使（协调员）' });
      await expect(selected).toHaveAttribute('aria-selected', 'true');
      const image = section.locator('.create-ws-avatar-preview img');
      await expect(image).toHaveAttribute('src', /courier-[\w-]+\.webp$/);
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256);
      expect(await section.locator('.user-avatar-name-input').inputValue()).toBe('我自己的名字');
      await expect.poll(() => win.evaluate(async () => (await window.api.config.get()).userAvatar))
        .toEqual({ kind: 'builtin', value: 'courier', displayName: '我自己的名字' });
      if (round === 1) await section.screenshot({ path: path.join(cwd, 'restarted-user-symbol.png') });
      await win.evaluate(() => { void window.api.app.quit(); }).catch(() => {});
      await app.close(); app = undefined;
    }
    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).userAvatar;
    expect(stored).toEqual({ kind: 'builtin', value: 'courier', displayName: '我自己的名字' });
    expect(fs.existsSync(path.join(userData, 'avatars/user.png'))).toBe(false);
  } finally { await app?.close().catch(() => {}); }
});
