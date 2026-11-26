import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('会话查找跟随分屏焦点、宽度并避让顶栏', async ({}, info) => {
  test.setTimeout(60_000);
  const project = path.resolve(__dirname, '../..'), root = path.join(info.outputDir, 'workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox/userData');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: 'find', workspaces: [{ id: 'find', name: '搜索验收', path: root }],
    mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `split-find-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: info.outputDir, env });
  try {
    const page = await app.firstWindow(); await page.locator('.app-shell').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 960));
    await page.evaluate(async cwd => {
      const options = { cwd, workspaceId: 'find', runtime: 'pi', force: true };
      const a = await window.api.sessions.create({ ...options, name: '搜索会话甲' });
      await window.api.sessions.create({ ...options, name: '搜索会话乙' });
      await window.api.sessions.select(a.id);
    }, root);
    await page.getByTestId('center-pane-handle-0').focus(); await page.keyboard.press('Control+\\');
    await expect(page.getByTestId('center-split-root')).toHaveAttribute('data-pane-count', '2');
    await page.locator('.session-item').filter({ hasText: '搜索会话乙' }).click();
    const chats = page.locator('.agent-chat-view.is-shown'); await expect(chats).toHaveCount(2);
    const check = async (slot: number) => {
      const own = chats.nth(slot), search = own.getByRole('search', { name: '会话内查找' });
      await expect(search).toBeVisible();
      await expect(search.getByRole('searchbox')).toBeFocused();
      const pane = await page.getByTestId(`center-pane-${slot}`).boundingBox(), bar = await search.boundingBox();
      expect(bar!.x).toBeGreaterThanOrEqual(pane!.x + 8);
      expect(bar!.x + bar!.width).toBeLessThanOrEqual(pane!.x + pane!.width - 8);
      const grip = await page.getByTestId(`center-pane-handle-${slot}`).boundingBox();
      expect(bar!.y).toBeGreaterThanOrEqual(grip!.y + grip!.height + 4);
    };
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(id => window.api.themes.activate(id, { scope: 'workspace', workspaceId: 'find' }), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const slot of [1, 0, 1]) {
        // Plain welcome text does not acquire DOM focus; App must use the split focus.
        await chats.nth(slot).locator('.chat-welcome').click(); await page.keyboard.press('Control+f');
        await check(slot);
      }
      const divider = await page.getByTestId('center-split-divider').boundingBox();
      const area = await page.getByTestId('center-panel').boundingBox();
      await page.mouse.move(divider!.x + divider!.width / 2, divider!.y + 120); await page.mouse.down();
      await page.mouse.move(area!.x + area!.width * .65, divider!.y + 120); await page.mouse.up();
      await page.keyboard.press('Control+f'); await check(1);
      await page.getByTestId('center-panel').screenshot({ path: path.join(info.outputDir, `${theme}-find-split.png`) });
      await page.keyboard.press('Escape');
      const pane = await page.getByTestId('center-pane-0').boundingBox();
      await page.mouse.move(pane!.x + pane!.width / 2, pane!.y + 4);
      await page.getByTestId('center-pane-0').getByRole('button', { name: '查找会话消息' }).click();
      await check(0); await page.keyboard.press('Escape');
    }
  } finally {
    await app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); }).catch(() => {});
    await app.close();
  }
});
