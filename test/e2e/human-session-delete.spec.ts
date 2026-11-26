import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

test('自带扩展已启用，人工删除已归档会话需要确认并且不进入业务审核', async ({}, info) => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  const root = path.join(info.outputDir, 'workspace');
  const spare = path.join(info.outputDir, 'other-workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox', 'userData');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(spare, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const workspaces = [{ id: 'delete-ws', name: '删除测试', path: root, controlRoot: root, rootsRevision: 1,
    roots: [{ id: 'delete-root', path: root }], defaultRootId: 'delete-root' }, { id: 'other-ws', name: '另一个工作区', path: spare }];
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: 'delete-ws', workspaces,
    mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `human-delete-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: info.outputDir, env });
  try {
    const page = await app.firstWindow();
    await page.locator('.app-shell').waitFor({ timeout: 60_000 });
    await page.evaluate(() => window.api.app.bootWait());
    await expect.poll(async () => (await page.evaluate(() => window.api.extensionCatalog.catalog()))
      .packages.find(item => item.extensionId === 'daily-report')?.enabled, { timeout: 30_000 }).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const initialSafety = await page.evaluate(() => window.api.safety.snapshot('delete-ws'));
    expect(initialSafety.records.filter(record => record.action === 'extensions.trust')).toHaveLength(0);
    const id = await page.evaluate(async cwd => {
      const options = { cwd, workspaceId: 'delete-ws', runtime: 'pi', name: '人工删除回归', force: true };
      return (await window.api.sessions.create(options)).id;
    }, root);
    const row = page.locator(`[data-session-row="${id}"]`);
    await row.hover();
    const archiveIcon = await row.getByRole('button', { name: '归档', exact: true }).locator('svg').innerHTML();
    await page.evaluate(sessionId => window.api.sessions.setArchived(sessionId, true), id);
    const epochDb = new DatabaseSync(path.join(userData, 'desktop', 'epochs.sqlite'), { readOnly: true });
    try {
      const generation = epochDb.prepare('SELECT generation FROM desktop_epoch_sessions WHERE session_id = ?').get(id);
      expect(generation?.generation).toBe(1);
    } finally { epochDb.close(); }
    expect(await page.evaluate(() => window.api.chat.clear('delete-ws'))).toEqual({ cleared: true });
    const schedulerEpochDb = new DatabaseSync(path.join(userData, 'desktop', 'epochs.sqlite'), { readOnly: true });
    try {
      const generation = schedulerEpochDb.prepare('SELECT generation FROM desktop_epoch_sessions WHERE session_id = ?').get('orchestrator:delete-ws');
      expect(generation?.generation).toBe(1);
    } finally { schedulerEpochDb.close(); }
    expect((await page.evaluate(() => window.api.workspaces.close('delete-ws'))).ok).toBe(true);
    expect(await page.evaluate(async sessionId => (await window.api.sessions.list()).sessions.some(session => session.id === sessionId), id)).toBe(false);
    expect((await page.evaluate(cwd => window.api.workspaces.open(cwd), root)).activeWorkspaceId).toBe('delete-ws');
    expect(await page.evaluate(async sessionId => (await window.api.sessions.list()).sessions.find(session => session.id === sessionId)?.archived, id)).toBe(true);
    await page.locator('.left-panel-scroll .panel-header.sub').first().hover();
    await page.getByRole('button', { name: /显示已归档的工作会话/ }).click();
    await expect(row).toBeVisible();
    await row.hover();
    const restore = row.getByRole('button', { name: '取消归档' });
    await expect(restore).toBeVisible();
    expect(await restore.locator('svg').innerHTML()).not.toBe(archiveIcon);
    await page.locator('.left-panel').screenshot({ path: info.outputPath('archive-only-dark.png'), animations: 'disabled' });
    await app.evaluate(({ ipcMain }, sessionId) => {
      ipcMain.removeHandler('agentSession:getHistoryRange');
      ipcMain.handle('agentSession:getHistoryRange', (_event, id) => id === sessionId ? {
        busy: false, mode: 'auto', before: 0, total: 1, hasEarlier: false,
        messages: [{ id: 'archived-message', role: 'user', ts: Date.now(), parts: [{ kind: 'text', text: '归档里的测试消息' }] }]
      } : null);
    }, id);
    await row.click();
    await expect(page.getByText('归档历史 · 只读')).toBeVisible();
    await expect(page.getByText('归档里的测试消息')).toBeVisible();
    await expect(page.getByRole('button', { name: '批量删除' })).toBeVisible();
    expect(await page.evaluate(async sessionId => (await window.api.sessions.list()).sessions.find(session => session.id === sessionId)?.archived, id)).toBe(true);
    await row.click({ button: 'right' });
    await expect(page.locator('#ctx-item-delete')).toBeVisible();
    await page.screenshot({ path: info.outputPath('before-delete.png') });
    await page.locator('#ctx-item-delete').click();
    const confirm = page.getByRole('dialog', { name: '永久删除' });
    await expect(confirm.getByText(/人工删除回归/)).toBeVisible();
    await confirm.getByRole('button', { name: '取消' }).click();
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole('button', { name: '永久删除' }).click();
    await expect(confirm).toBeVisible();
    await page.screenshot({ path: info.outputPath('delete-confirm.png'), animations: 'disabled' });
    await confirm.getByRole('button', { name: '永久删除' }).click();
    await expect.poll(async () => (await page.evaluate(() => window.api.sessions.list())).sessions.some(session => session.id === id)).toBe(false);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.archived-session-actions')).toHaveCount(0);
    await expect(page.getByText('暂无归档会话')).toBeVisible();
    await expect(page.getByRole('button', { name: '返回工作会话' })).toBeVisible();
    const snapshot = await page.evaluate(() => window.api.safety.snapshot('delete-ws'));
    expect(snapshot.records.filter(record => record.action === 'sessions.delete')).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('after-delete.png') });
    await page.getByRole('button', { name: '返回工作会话' }).click();
    await expect(page.getByText('暂无归档会话')).toHaveCount(0);
    await page.locator('.left-panel-scroll .panel-header.sub').first().hover();
    await page.getByRole('button', { name: '显示已归档的工作会话（0）' }).click();
    await expect(page.getByText('暂无归档会话')).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(640, 480); win.setContentSize(820, 700); });
    await page.evaluate(() => window.api.themes.activate('light'));
    await page.getByRole('button', { name: '会话', exact: true }).click();
    await expect(page.getByRole('button', { name: '返回工作会话' })).toBeInViewport();
    // Wait for the work surface to clear the rail after the window resize and theme switch.
    await page.waitForFunction(() => {
      const empty = [...document.querySelectorAll('.left-panel .session-empty')].find(element => element.textContent === '暂无归档会话');
      if (!empty) return false;
      const { x, y, width, height } = empty.getBoundingClientRect();
      return empty.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }, undefined, { timeout: 5_000 });
    await page.screenshot({ path: info.outputPath('archive-empty-light-narrow.png'), animations: 'disabled' });
  } finally {
    const owned = app.process();
    if (owned.exitCode === null && owned.signalCode === null && owned.pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(owned.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
      } else owned.kill('SIGKILL');
    }
  }
});
