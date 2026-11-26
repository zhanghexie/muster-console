import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('单屏隐藏关闭，保留会话与真实PTY', async ({}, info) => {
  test.setTimeout(60_000);
  const project = path.resolve(__dirname, '../..');
  const root = path.join(info.outputDir, 'workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox/userData');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: 'close', workspaces: [{ id: 'close', name: '关闭验收', path: root }],
    mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `pane-close-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: info.outputDir, env });
  try {
    const page = await app.firstWindow(); await page.locator('.app-shell').waitFor();
    const session = await page.evaluate(async cwd => window.api.sessions.create({ name: '关闭视图回归', shellProfileId: 'powershell', cwd, workspaceId: 'close' }), root);
    await page.locator('.session-item').filter({ hasText: '关闭视图回归' }).click();
    const terminal = page.locator('.terminal-wrap.is-shown');
    await terminal.locator('.xterm-helper-textarea').waitFor();
    const node = await terminal.elementHandle();
    for (const themeId of ['dark', 'light'] as const) {
      await page.evaluate(theme => window.api.themes.activate(theme, { scope: 'workspace', workspaceId: 'close' }), themeId);
      await expect(page.locator('html')).toHaveAttribute('data-theme', themeId);
      await page.keyboard.press('Tab'); await page.getByTestId('center-pane-handle-0').focus();
      const toolbar = page.getByRole('toolbar', { name: '关闭视图回归' });
      await expect.poll(() => toolbar.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
      await toolbar.screenshot({ path: path.join(info.outputDir, `${themeId}-close.png`) });
      await expect(toolbar.getByRole('button', { name: '关闭面板', exact: true })).toHaveCount(0);
      const state = await page.evaluate(() => window.api.sessions.list());
      expect(state.activeId).toBe(session.id); expect(state.sessions.find(row => row.id === session.id)?.archived).not.toBe(true);
      expect(await node!.evaluate(el => el.isConnected)).toBe(true);
    }
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("Write-Output ('PANE_CLOSE_' + 'ALIVE')"); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(id => window.api.pty.getBuffer(id), session.id)).toContain('PANE_CLOSE_ALIVE');
  } finally {
    await app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); }).catch(() => {});
    await app.close();
  }
});
