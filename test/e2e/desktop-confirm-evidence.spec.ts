import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..'), nodeRequire = createRequire(__filename);

async function stopApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([app.close().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
  if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
    } else proc.kill('SIGKILL');
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([new Promise<void>(resolve => proc.once('exit', () => resolve())), new Promise<void>(resolve => { exitTimer = setTimeout(resolve, 2000); })]); }
    finally { if (exitTimer) clearTimeout(exitTimer); }
  }
  if (proc.exitCode === null && proc.signalCode === null) throw new Error('Electron fixture process did not exit');
  for (const stream of proc.stdio) stream?.destroy();
}

test('desktop evidence is displayed before a local confirmation is sent', async () => {
  test.setTimeout(75_000);
  const parent = path.join(root, '.tmp'); fs.mkdirSync(parent, { recursive: true });
  const realRoot = fs.realpathSync(root), realParent = fs.realpathSync(parent), parentRelative = path.relative(realRoot, realParent);
  if (!parentRelative || parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) throw new Error('Invalid fixture parent');
  const fixture = fs.mkdtempSync(path.join(realParent, 'desktop-confirm-e2e-'));
  const workspace = path.join(fixture, 'workspace'), userData = path.join(fixture, '.dev-sandbox', 'userData');
  fs.mkdirSync(path.join(workspace, '.muster'), { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'confirm-fixture',
    defaultCwd: workspace, workspaces: [{ id: 'confirm-fixture', name: 'Confirm fixture', path: workspace }], mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)),
    MUSTER_SANDBOX: '1', MUSTER_WEB: '0', MUSTER_INSTANCE_ID: `confirm-e2e-${process.pid}`,
    APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: nodeRequire('electron') as unknown as string,
      args: [root, '--disable-gpu', '--in-process-gpu'], cwd: fixture, env, timeout: 30_000 });
    const page = await app.firstWindow(); await page.locator('.app-shell').waitFor({ timeout: 30_000 });
    const browserWindow = await app.browserWindow(page), windowId = await browserWindow.evaluate(window => window.id);
    const png = await nodeRequire('sharp')({ create: { width: 80, height: 40, channels: 4, background: '#4383a3' } }).png().toBuffer();
    const response = app.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const window = BrowserWindow.fromId(args.windowId); if (!window) throw new Error('Test window unavailable');
      return await new Promise<{ confirmed: boolean; mainFrame: boolean }>((resolve, reject) => {
        const channel = `ui:confirm:${args.id}`;
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error('Confirmation timeout')); }, 15000);
        const listener = (event: Electron.IpcMainEvent, value: { confirmed?: boolean }) => {
          clearTimeout(timer); ipcMain.removeListener(channel, listener);
          const mainFrame = event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
          window.webContents.send('ui:confirmClosed', { requestId: args.id }); resolve({ confirmed: value.confirmed === true, mainFrame });
        };
        ipcMain.on(channel, listener);
        window.webContents.send('ui:confirm', { requestId: args.id, title: '扩展当前桌面任务链？', detail: '检查截图', localOnly: true, dangerous: true,
          confirmLabel: '允许', desktopEvidence: { dataUrl: args.dataUrl, region: { x: 1, y: 2, width: 80, height: 40 } } });
      });
    }, { windowId, id: 'desktop-evidence-fixture', dataUrl: `data:image/png;base64,${png.toString('base64')}` });
    const dialog = page.getByRole('dialog', { name: '扩展当前桌面任务链？' });
    await expect(dialog.getByRole('img', { name: '操作区域截图' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '允许' })).toBeEnabled();
    await dialog.getByRole('button', { name: '允许' }).click();
    expect(await response).toEqual({ confirmed: true, mainFrame: true });
  } finally {
    if (app) await stopApp(app);
    const resolved = fs.realpathSync(fixture), relative = path.relative(realParent, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !path.basename(resolved).startsWith('desktop-confirm-e2e-')) throw new Error('Invalid fixture cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
  }
});
