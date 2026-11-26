import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('归档当前会话后选中当前搜索结果中的下一行', async ({}, info) => {
  test.setTimeout(60_000);
  const project = path.resolve(__dirname, '../..');
  const workspace = path.join(info.outputDir, 'workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox', 'userData');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'archive-test', defaultCwd: workspace,
    workspaces: [{ id: 'archive-test', name: '归档验收', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  const row = (id: string, name: string, createdAt: number) => ({
    id, name, createdAt, type: 'terminal', launchKind: 'agent', runtime: 'pi', guiMode: 'auto',
    workspaceId: 'archive-test', cwd: workspace, lifecycle: 'idle'
  });
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([
    row('last', '计划末尾', 1), row('next', '计划下一个', 2), row('filtered', '其他内容', 3),
    row('current', '计划当前', 4), row('first', '最前一项', 5)
  ]));
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `archive-selection-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: info.outputDir, env });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor();
    await win.evaluate(() => window.api.sessions.select('current'));
    await expect(win.locator('[data-session-row="current"]')).toHaveAttribute('aria-current', 'true');
    await win.locator('.left-panel-scroll .panel-header.sub').first().hover();
    await win.getByRole('button', { name: '搜索工作会话' }).click();
    await win.getByPlaceholder('搜索工作会话…').fill('计划');
    await expect(win.locator('[data-session-row="filtered"]')).toHaveCount(0);
    const current = win.locator('[data-session-row="current"]');
    await current.hover();
    await current.getByRole('button', { name: '归档' }).click();
    await expect(win.locator('[data-session-row="current"]')).toHaveCount(0);
    await expect(win.locator('[data-session-row="next"]')).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => win.evaluate(async () => (await window.api.sessions.list()).activeId)).toBe('next');
  } finally {
    await app.evaluate(({ app: electronApp }) => { setTimeout(() => electronApp.exit(0), 0); }).catch(() => {});
    await app.close();
  }
});
