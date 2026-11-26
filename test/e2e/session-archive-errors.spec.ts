import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('unfinished isolated session confirms archive and reports a rejected request', async ({}, info) => {
  test.setTimeout(75_000);
  const project = path.resolve(__dirname, '../..');
  const workspace = path.join(info.outputDir, 'workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox', 'userData');
  const worktree = path.join(info.outputDir, 'task-tree');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'archive-test', defaultCwd: workspace,
    workspaces: [{ id: 'archive-test', name: '归档验收', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{
    id: 'worker', name: '隔离工作', createdAt: 1, type: 'terminal', launchKind: 'agent', runtime: 'pi', guiMode: 'auto',
    workspaceId: 'archive-test', cwd: workspace, lifecycle: 'idle', worktreePath: worktree, phase: { value: 'needs_you', source: 'user' }
  }]));
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `archive-errors-${process.pid}`, MUSTER_WEB_PORT: '0',
    APPDATA: path.join(info.outputDir, 'appdata'), LOCALAPPDATA: path.join(info.outputDir, 'localappdata') } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  const bootstrap = path.join(info.outputDir, 'bootstrap.cjs');
  fs.writeFileSync(bootstrap, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(env.APPDATA)});app.setPath('userData',${JSON.stringify(userData)});require(${JSON.stringify(path.join(project, 'out/main/index.js'))});`);
  const app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap, '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu', '--no-sandbox'], cwd: info.outputDir, env });
  const shots = path.join(project, '.tmp', 'ui-captures', 'archive-errors'); fs.mkdirSync(shots, { recursive: true });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor();
    await expect(win.locator('[data-session-row="worker"]')).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('sessions:setArchived');
      ipcMain.handle('sessions:setArchived', () => { throw new Error('epoch storage unavailable'); });
    });
    for (const theme of ['dark', 'light']) {
      await win.evaluate(async value => window.api.themes.activate(value), theme);
      const worker = win.locator('[data-session-row="worker"]');
      await worker.hover();
      await worker.getByRole('button', { name: '归档' }).click();
      const confirmation = win.getByRole('dialog', { name: '归档隔离会话' });
      await expect(confirmation).toBeVisible();
      await confirmation.locator('..').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
      await win.screenshot({ path: path.join(shots, `${theme}-confirm.png`) });
      await confirmation.getByRole('button', { name: '归档', exact: true }).click();
      const failure = win.getByRole('dialog', { name: '会话归档失败' });
      await expect(failure).toBeVisible();
      await expect(failure.getByText(/epoch storage unavailable/)).toBeVisible();
      await expect(failure.getByText(/Error invoking remote method/)).toHaveCount(0);
      await failure.locator('..').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
      await win.screenshot({ path: path.join(shots, `${theme}-failure.png`) });
      await failure.getByRole('button', { name: '知道了' }).click();
      await expect(failure).toHaveCount(0);
      await expect(worker).toBeVisible();
    }
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(640, 480); win.setContentSize(860, 720); });
    await win.locator('[data-session-row="worker"]').hover();
    await win.locator('[data-session-row="worker"]').getByRole('button', { name: '归档' }).click();
    await expect(win.getByRole('dialog', { name: '归档隔离会话' })).toBeVisible();
    await win.getByRole('dialog', { name: '归档隔离会话' }).locator('..').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await win.screenshot({ path: path.join(shots, 'narrow-confirm.png') });
  } finally {
    // This fixture owns an isolated application process. Terminate its tree so
    // background helpers cannot keep Playwright's transport pipes open.
    const child = app.process();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
        else child.kill('SIGTERM');
      }
      await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Isolated Electron did not close in time')), 8000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
});
