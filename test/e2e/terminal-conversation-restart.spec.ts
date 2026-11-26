import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionMeta } from '../../src/shared/types';

test('terminal restore keeps the exact conversation and a manifest terminal starts only on request', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const cwd = fs.mkdtempSync(path.join(project, '.tmp', 'terminal-restart-'));
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  const workspace = path.join(cwd, 'workspace');
  const bin = path.join(cwd, 'bin');
  const home = path.join(cwd, 'home');
  for (const dir of [userData, workspace, bin, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local'),
    path.join(home, 'Documents'), path.join(home, 'Desktop')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const workspaceId = 'restart-fixture';
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', workspace, defaultRuntime: 'qwen-cli', activeWorkspaceId: workspaceId,
    workspaces: [{ id: workspaceId, name: 'Restart fixture', path: workspace }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] },
    webAccess: { enabled: false }
  }));
  const history = path.join(cwd, 'history.jsonl');
  const launches = path.join(cwd, 'launches.jsonl');
  const child = path.join(cwd, 'fixture.cjs');
  fs.writeFileSync(history, '');
  fs.writeFileSync(child, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'sessions') {
  process.stdout.write(fs.readFileSync(${JSON.stringify(history)}));
} else {
  fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
  process.stdout.write('Fixture terminal ready\\n');
  process.stdin.resume();
}
`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'qwen.cmd'), `@"${process.execPath}" "${child}" %*\r\n`);
  } else {
    const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(path.join(bin, 'qwen'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(child)} "$@"\n`, { mode: 0o755 });
  }
  const env = { ...process.env } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_HOST', 'MUSTER_STATUS_URL',
    'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const pathName = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathName] = `${bin}${path.delimiter}${env[pathName] ?? ''}`;
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd), HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
  const readLaunches = (): { args: string[]; cwd: string }[] => fs.existsSync(launches)
    ? fs.readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor();
    expect(await win.evaluate(() => window.api.app.bootWait())).toEqual({ ok: true });
    const getSession = (id: string) => win.evaluate(async id => (await window.api.sessions.list()).sessions.find(row => row.id === id), id);
    const create = (name: string, runtime: string, activate = false): Promise<SessionMeta> => win.evaluate(
      opts => window.api.sessions.create(opts), { name, runtime, workspaceId, force: true, activate }
    );
    const openMenu = async (name: string) => {
      await win.locator('.session-item').filter({ hasText: name }).first().click({ button: 'right' });
      return win.locator('.ctx-menu').filter({ has: win.getByText('开启新对话', { exact: true }) });
    };
    const dismissScheduler = async () => {
      const backdrop = win.locator('[data-agent-backdrop-interactive="true"]');
      if (await backdrop.isVisible()) await backdrop.click({ position: { x: 12, y: 12 } });
      await expect(backdrop).toHaveCount(0);
    };
    const first = await create('Qwen first fixture', 'qwen-cli', true);
    await expect.poll(() => readLaunches().length).toBe(1);
    const second = await create('Qwen second fixture', 'qwen-cli');
    await expect.poll(() => readLaunches().length).toBe(2);
    const nativeFirst = (await getSession(first.id))!.externalSessionId!;
    const nativeSecond = (await getSession(second.id))!.externalSessionId!;
    expect(nativeFirst).toBeTruthy();
    expect(nativeSecond).not.toBe(nativeFirst);
    fs.writeFileSync(history, [nativeSecond, nativeFirst].map(sessionId => JSON.stringify({ sessionId })).join('\n') + '\n');

    let menu = await openMenu(first.name);
    await expect(menu.getByText('恢复原对话', { exact: true })).toBeVisible();
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
    await win.screenshot({ path: info.outputPath('qwen-restart-dark.png'), animations: 'disabled' });
    await menu.getByText('恢复原对话', { exact: true }).click();
    await expect.poll(() => readLaunches().length).toBe(3);
    expect(readLaunches()[2].args.slice(0, 2)).toEqual(['--resume', nativeFirst]);
    expect(path.normalize(readLaunches()[2].cwd)).toBe(path.normalize(workspace));

    fs.writeFileSync(history, JSON.stringify({ sessionId: nativeSecond }) + '\n');
    menu = await openMenu(first.name);
    await menu.getByText('恢复原对话', { exact: true }).click();
    await expect.poll(async () => (await getSession(first.id))?.meta?.launchError).toContain('找不到原对话');
    expect((await getSession(first.id))?.externalSessionId).toBe(nativeFirst);
    expect((await getSession(first.id))?.status).toBe('running');
    expect(readLaunches()).toHaveLength(3);
    menu = await openMenu(first.name);
    await menu.getByText('开启新对话', { exact: true }).click();
    await expect.poll(() => readLaunches().length).toBe(4);
    expect(readLaunches()[3].args[0]).toBe('--session-id');
    expect(readLaunches()[3].args[1]).not.toBe(nativeFirst);
    await expect.poll(async () => (await getSession(first.id))?.externalSessionId).toBe(readLaunches()[3].args[1]);

    const manifest = { id: 'fixture-terminal', label: 'Fixture Terminal',
      terminal: { command: process.execPath, args: [child, 'manifest'] } };
    const registered = win.evaluate(manifest => window.api.runtimes.register(manifest), manifest);
    const confirmation = win.getByTestId('confirm-mask');
    await expect(confirmation.getByText('注册 Agent Runtime（终端仅启动）', { exact: true })).toBeVisible();
    await confirmation.getByRole('button', { name: '确认执行', exact: true }).click();
    expect((await registered).ok).toBe(true);
    const dynamic = await create('Manifest fixture', manifest.id);
    await expect.poll(() => readLaunches().length).toBe(5);
    const archive = await win.evaluate(id => window.api.sessions.setArchived(id, true), dynamic.id);
    expect(archive).toEqual({ archiveConfirmation: [dynamic.id] });
    expect((await getSession(dynamic.id))?.archived).toBeFalsy();
    await win.evaluate(id => window.api.sessions.setArchived(id, true, undefined, [id]), dynamic.id);
    await expect.poll(async () => (await getSession(dynamic.id))?.status).toBe('exited');
    await win.evaluate(id => window.api.sessions.select(id), dynamic.id);
    expect((await getSession(dynamic.id))?.archived).toBeTruthy();
    const archived = win.locator('.archived-session-view');
    await expect(archived.getByText('归档历史 · 只读', { exact: true })).toBeVisible();
    await dismissScheduler();
    await archived.getByRole('button', { name: '继续会话', exact: true }).click();
    await expect.poll(async () => (await getSession(dynamic.id))?.archived).toBeFalsy();
    await expect(win.evaluate(id => window.api.sessions.respawn(id), dynamic.id)).rejects.toThrow(/不支持恢复原对话/);
    expect(readLaunches()).toHaveLength(5);

    await win.evaluate(() => window.api.config.update({ themeId: 'light' }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 720));
    await win.reload();
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    await dismissScheduler();
    menu = await openMenu(dynamic.name);
    await expect(menu.getByText('恢复原对话', { exact: true })).toHaveCount(0);
    await expect(menu.getByText('开启新对话', { exact: true })).toBeVisible();
    await win.screenshot({ path: info.outputPath('manifest-restart-light.png'), animations: 'disabled' });
    await menu.getByText('开启新对话', { exact: true }).click();
    await expect.poll(() => readLaunches().length).toBe(6);
    expect(readLaunches()[5].args).toEqual(['manifest']);
  } finally {
    await app?.close().catch(() => {});
  }
});
