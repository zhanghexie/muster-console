/** Real Electron/IPC + owned CLI transport; isolated Node executable, no model service. */
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);

test('Codex GUI 停止并回收运行中的 app-server，再恢复线程发送排队消息', async ({}, testInfo) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-e2e-'));
  const workspace = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  const bin = path.join(cwd, 'bin');
  const codexHome = path.join(cwd, 'codex-home');
  const profile = path.join(cwd, 'profile');
  const appData = path.join(profile, 'AppData', 'Roaming');
  const localAppData = path.join(profile, 'AppData', 'Local');
  for (const dir of [workspace, userData, bin, codexHome, profile, appData, localAppData]) fs.mkdirSync(dir, { recursive: true });
  const executable = path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.copyFileSync(process.execPath, executable); fs.chmodSync(executable, 0o755);
  const ledger = path.join(cwd, 'turns.jsonl');
  fs.writeFileSync(path.join(workspace, 'app-server'), String.raw`
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const ledger = process.env.TEST_CODEX_TURN_LEDGER;
const threadId = 'fixture-thread';
let resumed = false;
let tools = {};
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  const { method, params } = request;
  const emit = message => console.log(JSON.stringify(message));
  const answer = result => emit({ id: request.id, result });
  if (method === 'initialize') return answer({ codexHome: process.env.CODEX_HOME });
  if (method === 'permissionProfile/list') return answer({ data: [], nextCursor: null });
  if (method === 'thread/start' || method === 'thread/resume') {
    resumed = params.threadId === threadId;
    tools = Object.fromEntries((params.config['mcp_servers.muster'].enabled_tools ?? []).map(name => [name, {}]));
    return answer({ thread: { id: threadId }, cwd: params.cwd });
  }
  if (method === 'mcpServerStatus/list') return answer({ data: [{ name: 'muster', runtimeStatus: 'connected', tools }] });
  if (method !== 'turn/start') return answer({});
  const n = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').length + 1 : 1;
  let previousAlive;
  if (n > 1) {
    const previous = JSON.parse(fs.readFileSync(ledger, 'utf8').split('\n')[0]);
    try { process.kill(previous.pid, 0); previousAlive = true; } catch { previousAlive = false; }
  }
  fs.appendFileSync(ledger, JSON.stringify({ pid: process.pid, n, resumed, previousAlive }) + '\n');
  const turnId = 'turn-' + n;
  answer({ turn: { id: turnId } });
  emit({ method: 'item/completed', params: { threadId, turnId, item: { id: 'reply', type: 'agentMessage', text: 'answer ' + n } } });
  if (n > 1) emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
});`);
  const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  for (const entry of registry.runtimes) entry.enabled = entry.id === 'codex-gui';
  fs.mkdirSync(path.join(userData, 'agent-runtimes'));
  fs.writeFileSync(path.join(userData, 'agent-runtimes/registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'codex-test', defaultCwd: workspace, workspaces: [{ id: 'codex-test', name: 'Codex models', path: workspace }], webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd), CODEX_HOME: codexHome, TEST_CODEX_TURN_LEDGER: ledger,
    HOME: profile, USERPROFILE: profile, APPDATA: appData, LOCALAPPDATA: localAppData } as Record<string, string>;
  const originalPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = bin + path.delimiter + originalPath;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: nodeRequire('electron'), args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 60000 });
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60000 });
    const session = await win.evaluate(async () => {
      const s = await window.api.sessions.create({ runtime: 'codex-gui', name: 'Codex model acceptance', guiMode: 'auto' });
      await window.api.sessions.select(s.id); return s;
    });
    const composer = win.locator('.agent-chat-view').filter({ visible: true }).locator('.agent-composer');
    await expect(composer).toBeVisible();
    expect((await win.evaluate(id => window.api.agentSession.send(id, 'first'), session.id)).ok).toBe(true);
    await expect.poll(() => fs.existsSync(ledger), { timeout: 15_000, message: 'first native turn submitted' }).toBe(true);
    await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.execution?.process).toBe('running');
    const history = await win.evaluate(id => window.api.agentSession.historyRange(id), session.id);
    expect(history?.execution?.process).toBe('running');
    expect(history?.busy).toBe(true);
    expect((await win.evaluate(id => window.api.agentSession.send(id, 'queued', undefined, { steerOnBusy: false }), session.id)).queued).toBe(true);
    expect(fs.readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    await composer.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.busy,
      { timeout: 15000 }).toBe(false);
    const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[1].resumed).toBe(true);
    expect(rows[1].previousAlive).toBe(false);
    let alive = true; try { process.kill(rows[0].pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
    await expect(win.getByText('answer 2', { exact: true })).toBeVisible();
    await expect(win.locator('.chat-execution-status')).toHaveCount(0);
  } finally {
    const proc = app?.process();
    if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {});
    if (app) await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 8000))]);
    if (proc && proc.exitCode === null) proc.kill();
    if (proc && proc.exitCode === null) await new Promise<void>(resolve => proc.once('exit', () => resolve()));
    if (path.dirname(cwd) !== os.tmpdir() || !path.basename(cwd).startsWith('codex-lifecycle-e2e-')) throw Error('Invalid fixture cleanup path');
    try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) {
      if (testInfo.status === 'passed') throw error;
      console.warn('Fixture cleanup failed after earlier test failure:', (error as Error).message);
    }
  }
});
