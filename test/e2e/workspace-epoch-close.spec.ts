import { test, expect, _electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

test('工作区关闭遇到任务代次持久化失败时保留工作区和会话', async ({}, info) => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..'), cwd = info.outputDir;
  const root = path.join(cwd, 'first'), second = path.join(cwd, 'second');
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  for (const dir of [root, second, userData]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'epoch-close.txt'), 'retain editor');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: 'first', workspaces: [{ id: 'first', name: 'First', path: root }, { id: 'second', name: 'Second', path: second }],
    mcp: { enabled: false, servers: [] }, webAccess: { enabled: false } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1',
    MUSTER_INSTANCE_ID: `workspace-epoch-close-${process.pid}`, MUSTER_WEB_PORT: '0' } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  let app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
  try {
    const page = await app.firstWindow(); await page.locator('.app-shell').waitFor({ timeout: 60_000 });
    const worker = await page.evaluate(async cwd => window.api.sessions.create({ cwd, workspaceId: 'first', runtime: 'pi', name: 'Epoch fixture', force: true }), root);
    const ref = await page.evaluate(() => window.api.fs.resolveRef('first', 'epoch-close.txt'));
    if (!ref.ok) throw new Error(ref.error);
    const roots = await page.evaluate(() => window.api.workspaces.list());
    const rootsRevision = roots.workspaces.find(workspace => workspace.id === 'first')?.rootsRevision ?? 0;
    const windowId = await (await app.browserWindow(page)).evaluate(window => window.id);
    const opened = await app.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const win = BrowserWindow.fromId(args.windowId); if (!win) throw new Error('Window unavailable');
      return await new Promise<any>((resolve, reject) => {
        const requestId = 'workspace-close-test', channel = `panel:open-content:${requestId}`;
        const timer = setTimeout(() => { ipcMain.removeAllListeners(channel); reject(new Error('Panel open timed out')); }, 5000);
        ipcMain.once(channel, (_event, result) => { clearTimeout(timer); resolve(result); });
        win.webContents.send('panel:open-content-request', { requestId, workspaceId: 'first', rootsRevision: args.rootsRevision,
          content: { kind: 'file', path: args.fileRef.relativePath, fileRef: args.fileRef, placement: 'center' }, focus: true });
      });
    }, { windowId, rootsRevision, fileRef: ref.fileRef });
    expect(opened).toMatchObject({ ok: true, selected: true });
    const editor = page.locator('.center-file-dock .right-content-page.is-shown .file-editor');
    await expect(editor).toBeVisible();
    await editor.evaluate(element => element.setAttribute('data-epoch-close-probe', 'same'));
    const dbPath = path.join(userData, 'desktop', 'epochs.sqlite'); fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const faultDb = new DatabaseSync(dbPath);
    faultDb.exec(`CREATE TABLE IF NOT EXISTS desktop_epoch_sessions (session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
      CREATE TRIGGER fail_worker_epoch BEFORE UPDATE ON desktop_epoch_sessions
      WHEN OLD.session_id NOT LIKE 'orchestrator:%' BEGIN SELECT RAISE(ABORT, 'injected worker epoch failure'); END;`);
    faultDb.close();
    const failed = await page.evaluate(() => window.api.workspaces.close('first'));
    expect(failed.ok).toBe(false); expect(failed.message).toContain('injected worker epoch failure');
    await expect(editor).toBeVisible(); await expect(editor).toHaveAttribute('data-epoch-close-probe', 'same');
    await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
    expect((await page.evaluate(() => window.api.workspaces.list())).workspaces.some(workspace => workspace.id === 'first')).toBe(true);
    expect((await page.evaluate(() => window.api.sessions.list())).sessions.some(session => session.id === worker.id)).toBe(true);
    const repairDb = new DatabaseSync(dbPath); repairDb.exec('DROP TRIGGER fail_worker_epoch'); repairDb.close();
    const stillBlocked = await page.evaluate(() => window.api.workspaces.close('first'));
    expect(stillBlocked.ok).toBe(false); expect(stillBlocked.message).toMatch(/重启工作台/);
    await app.close();
    app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
    const reopened = await app.firstWindow(); await reopened.locator('.app-shell').waitFor({ timeout: 60_000 });
    const closed = await reopened.evaluate(() => window.api.workspaces.close('first'));
    expect(closed.ok).toBe(true);
    expect((await reopened.evaluate(() => window.api.sessions.list())).sessions.some(session => session.id === worker.id)).toBe(false);
    const read = new DatabaseSync(dbPath, { readOnly: true });
    try { expect(read.prepare('SELECT generation FROM desktop_epoch_sessions WHERE session_id = ?').get(worker.id)?.generation).toBe(1); }
    finally { read.close(); }
  } finally {
    const proc = app.process();
    if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* process already exited */ }
      } else proc.kill('SIGKILL');
    }
  }
});
