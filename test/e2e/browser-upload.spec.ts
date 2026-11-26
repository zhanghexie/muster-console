/** Authenticated, isolated Electron regression for file assignment and upload verification. */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);

async function stopApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([app.close().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
  } finally { if (timer) clearTimeout(timer); }
  if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
    } else proc.kill('SIGKILL');
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([new Promise<void>(resolve => proc.once('exit', () => resolve())),
        new Promise<void>(resolve => { exitTimer = setTimeout(resolve, 2000); })]);
    } finally { if (exitTimer) clearTimeout(exitTimer); }
  }
  if (proc.exitCode === null && proc.signalCode === null) throw new Error('Electron fixture process did not exit');
  // A descendant can keep inherited pipes open after the Electron process exits.
  // These handles belong to this fixture; closing them lets Playwright observe close.
  if (proc.exitCode !== null || proc.signalCode !== null) for (const stream of proc.stdio) stream?.destroy();
}

test('file assignment is scoped and upload outcomes require independent verification', async () => {
  test.setTimeout(75_000);
  const fixtureParent = path.join(repoRoot, '.tmp');
  fs.mkdirSync(fixtureParent, { recursive: true });
  const resolvedRepo = fs.realpathSync(repoRoot), resolvedParent = fs.realpathSync(fixtureParent);
  const parentRelative = path.relative(resolvedRepo, resolvedParent);
  if (!parentRelative || parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new Error('Upload fixture parent is outside the task worktree');
  }
  const fixture = fs.mkdtempSync(path.join(resolvedParent, 'browser-upload-'));
  const cwd = fixture;
  fs.mkdirSync(cwd, { recursive: true });
  const longPath = process.env.MUSTER_TEST_LONG_UPLOAD_PATH === '1';
  const workspace = path.join(cwd, ...(longPath ? Array(3).fill('long-' + 'x'.repeat(35)) : []), 'workspace');
  if (longPath && path.join(workspace, '.muster', 'memory', 'runtime', 'state.sqlite').length <= 260) {
    throw new Error('Long-path fixture must put the memory database beyond 260 characters');
  }
  const userData = path.join(cwd, '.dev-sandbox', 'userData'), workspaceId = 'browser-upload-test';
  fs.mkdirSync(path.join(workspace, '.muster'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'example.txt'), 'fixture upload body');
  fs.writeFileSync(path.join(workspace, 'success.txt'), 'accepted upload body');
  fs.writeFileSync(path.join(cwd, 'outside.txt'), 'not in read scope');
  fs.writeFileSync(path.join(workspace, '.muster', 'workspace.json'), JSON.stringify({ hVirtualScreen: true, hDock: 'git', sideToolsTab: 'browser' }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: workspaceId, defaultCwd: workspace, workspaces: [{ id: workspaceId, name: 'Upload test', path: workspace }],
    mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const uploads: string[] = [];
  let uploadStatus = 422;
  const server = createServer((request, response) => {
    if (request.url === '/upload' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => { uploads.push(Buffer.concat(chunks).toString('utf8')); response.writeHead(uploadStatus); response.end(uploadStatus === 200 ? 'accepted' : 'rejected'); });
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><title>Upload fixture</title><input id="file" type="file"><script>
      window.uploadStatus = null;
      document.querySelector('#file').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (file) window.uploadStatus = (await fetch('/upload', {method:'POST',body:file})).status;
      });
    </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `browser-upload-${process.pid}`,
    MUSTER_WEB: '0', APPDATA: path.join(cwd, 'appdata'), LOCALAPPDATA: path.join(cwd, 'localappdata') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined, win: Page | undefined;
  try {
    app = await _electron.launch({ executablePath: nodeRequire('electron') as unknown as string,
      args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 30_000 });
    win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 30_000 });
    const session = await win.evaluate(async ({ workspace, workspaceId }) => {
      const profiles = await window.api.shell.listProfiles();
      if (!profiles.length) throw new Error('No local shell profile available');
      return window.api.sessions.create({ name: 'Upload worker', cwd: workspace, workspaceId, shellProfileId: profiles[0].id });
    }, { workspace, workspaceId }) as { id: string };
    const sessions = await win.evaluate(() => window.api.sessions.list());
    const token = sessions.sessions.find(item => item.id === session.id)?.statusToken;
    expect(token).toBeTruthy();
    await expect.poll(() => fs.existsSync(path.join(userData, 'shell-api.json'))).toBe(true);
    const toolUrl = (JSON.parse(fs.readFileSync(path.join(userData, 'shell-api.json'), 'utf8')) as { toolUrl: string }).toolUrl;
    const call = async (action: string, params: Record<string, unknown>) => {
      const response = await fetch(toolUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'host.browser.run', arguments: { action, params } }), signal: AbortSignal.timeout(30_000) });
      expect(response.ok).toBe(true);
      return await response.json() as { ok: boolean; result?: Record<string, unknown>; error?: string };
    };
    const opened = await win.evaluate(async ({ baseUrl, workspaceId, sessionId }) => window.api.browser.open({ url: baseUrl, workspaceId, sessionId }),
      { baseUrl, workspaceId, sessionId: session.id });
    await win.evaluate(id => window.api.browser.activate({ id }), opened.id);
    const view = win.locator(`webview[data-tab-id="${opened.id}"]`);
    await expect(view).toBeVisible();
    await expect.poll(async () => (await call('snapshot', { tabId: opened.id })).ok).toBe(true);
    const guestId = await view.evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
    const read = async <T,>(expression: string): Promise<T> => await app!.evaluate(async ({ webContents }, { guestId, expression }) => {
      const guest = webContents.fromId(guestId);
      if (!guest || guest.isDestroyed()) throw new Error('guest unavailable');
      return await guest.executeJavaScript(expression);
    }, { guestId, expression }) as T;
    const outside = await call('upload', { tabId: opened.id, target: '#file', files: [path.join(cwd, 'outside.txt')] });
    expect(outside.ok).toBe(false); expect(outside.error).toContain('outside');
    const address = win.locator('.browser-addr'); await address.fill('unsent address'); await address.focus();
    const clear = await call('upload', { tabId: opened.id, target: '#file', files: [] });
    expect(clear.result).toMatchObject({ assignment: 'completed', upload: 'unverified' });
    await expect(address).toBeFocused();
    const assignment = call('upload', { tabId: opened.id, target: '#file', files: ['example.txt'] });
    const confirm = win.locator('.confirm-modal');
    await expect(confirm).toBeVisible({ timeout: 25_000 });
    await confirm.locator('.modal-actions .btn.danger').click();
    const result = await assignment;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.result).toMatchObject({ assignment: 'completed', upload: 'unverified' });
    await expect.poll(() => read<number>('window.uploadStatus')).toBe(422);
    expect(uploads).toEqual(['fixture upload body']);
    expect(await read<string>(`document.querySelector('#file').files[0].text()`)).toBe('fixture upload body');
    uploadStatus = 200;
    const accepted = call('upload', { tabId: opened.id, target: '#file', files: ['success.txt'] });
    await expect(confirm).toBeVisible({ timeout: 25_000 });
    await confirm.locator('.modal-actions .btn.danger').click();
    const acceptedResult = await accepted;
    expect(acceptedResult.ok, JSON.stringify(acceptedResult)).toBe(true);
    expect(acceptedResult.result).toMatchObject({ assignment: 'completed', upload: 'unverified' });
    await expect.poll(() => read<number>('window.uploadStatus')).toBe(200);
    expect(uploads).toEqual(['fixture upload body', 'accepted upload body']);
    // Retire both fixture-owned resources before quitting the application.
    await win.evaluate(async ({ tabId, sessionId }) => {
      await window.api.browser.close({ id: tabId });
      await window.api.sessions.setArchived(sessionId, true);
      await window.api.sessions.close(sessionId);
    }, { tabId: opened.id, sessionId: session.id });
  } finally {
    try { if (app) await stopApp(app); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    const resolvedFixture = fs.realpathSync(fixture);
    const relative = path.relative(resolvedRepo, resolvedFixture);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        !path.basename(resolvedFixture).startsWith('browser-upload-')) throw new Error('Invalid upload fixture cleanup target');
    fs.rmSync(resolvedFixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
