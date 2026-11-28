/** Real Electron/IPC + owned CLI transport; isolated Node executable, no model service. */
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);

test('Codex GUI 回收原生进程，在外部占用时续聊并同步会话历史状态', async ({}, testInfo) => {
  test.setTimeout(120_000);
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
  const holder = path.join(cwd, 'external-writer');
  const archived = path.join(cwd, 'archived-threads');
  const deleted = path.join(cwd, 'deleted-threads');
  fs.writeFileSync(path.join(workspace, 'app-server'), String.raw`
const fs = require('node:fs');
const path = require('node:path');
const rl = require('node:readline').createInterface({ input: process.stdin });
const ledger = process.env.TEST_CODEX_TURN_LEDGER;
const holder = process.env.TEST_CODEX_EXTERNAL_WRITER;
const archived = process.env.TEST_CODEX_ARCHIVED_STAGING_THREAD;
const deleted = process.env.TEST_CODEX_DELETED_THREADS;
const registry = process.env.TEST_CODEX_SESSION_REGISTRY;
const sourceThread = 'fixture-thread';
const stagingThread = 'fixture-thread-staging';
const continuationThread = 'fixture-thread-continuation';
let threadId = sourceThread;
let resumed = false;
let tools = {};
const readIds = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
const writeIds = (file, ids) => fs.writeFileSync(file, ids.join('\n') + '\n');
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  const { method, params } = request;
  const emit = message => console.log(JSON.stringify(message));
  const answer = result => emit({ id: request.id, result });
  const reject = message => emit({ id: request.id, error: { code: -32600, message } });
  if (method === 'initialize') return answer({ codexHome: process.env.CODEX_HOME });
  if (method === 'permissionProfile/list') return answer({ data: [], nextCursor: null });
  if (method === 'thread/turns/list') return answer({ data: [{ id: 'turn-2', status: 'completed' }] });
  if (method === 'thread/goal/get') return answer({ goal: null });
  if (['thread/archive', 'thread/unarchive', 'thread/delete', 'thread/read'].includes(method)) {
    const id = params.threadId;
    const archives = readIds(archived);
    const deletes = readIds(deleted);
    const missing = 'no rollout found for thread id ' + id;
    const isArchived = archives.includes(id);
    if (deletes.includes(id)) return reject(missing);
    if (method === 'thread/read') return answer({ thread: { id, path: path.join(fs.realpathSync.native(process.env.CODEX_HOME),
      isArchived ? 'archived_sessions' : 'sessions', 'fixture.jsonl') } });
    if (id === sourceThread && fs.existsSync(holder)) return reject('thread ' + id + ' already has an active writer');
    if (method === 'thread/archive') {
      if (isArchived) return reject(missing);
      writeIds(archived, [...archives, id]);
      return answer({});
    }
    if (method === 'thread/unarchive') {
      if (!isArchived) return reject('no archived rollout found for thread id ' + id);
      writeIds(archived, archives.filter(thread => thread !== id));
      return answer({ thread: { id } });
    }
    if (id === stagingThread && !deletes.includes(continuationThread))
      return reject('cannot delete thread while attached thread ' + continuationThread + ' exists; delete the attached thread first');
    if (id === sourceThread && !deletes.includes(stagingThread))
      return reject('cannot delete thread ' + sourceThread + ': forked history still references it');
    writeIds(deleted, [...deletes, id]);
    writeIds(archived, archives.filter(thread => thread !== id));
    return answer({});
  }
  if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
    resumed = method === 'thread/resume';
    if (resumed && fs.existsSync(holder) && params.threadId === sourceThread) return reject('thread ' + sourceThread + ' already has an active writer');
    if (resumed && readIds(archived).includes(params.threadId)) return reject('session ' + params.threadId + ' is archived.');
    const forking = method === 'thread/fork';
    if (forking) threadId = params.attachToSource ? continuationThread : stagingThread;
    else threadId = params.threadId || sourceThread;
    tools = Object.fromEntries((params.config['mcp_servers.muster'].enabled_tools ?? []).map(name => [name, {}]));
    return answer({ thread: { id: threadId, ...(forking ? { ephemeral: false, forkedFromId: params.threadId,
      historyMode: 'paginated', attachedToThreadId: params.attachToSource ? params.threadId : null } : {}) }, cwd: params.cwd });
  }
  if (method === 'mcpServerStatus/list') return answer({ data: [{ name: 'muster', runtimeStatus: 'connected', tools }] });
  if (method !== 'turn/start') return answer({});
  const n = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').length + 1 : 1;
  let previousAlive;
  if (n > 1) {
    const previous = JSON.parse(fs.readFileSync(ledger, 'utf8').split('\n')[0]);
    try { process.kill(previous.pid, 0); previousAlive = true; } catch { previousAlive = false; }
  }
  const bindingAtSubmission = JSON.parse(fs.readFileSync(registry, 'utf8')).find(row => row.runtime === 'codex-gui')?.runtimeResumeToken;
  const archivesAtSubmission = fs.existsSync(archived) ? fs.readFileSync(archived, 'utf8').trim().split('\n') : [];
  fs.appendFileSync(ledger, JSON.stringify({ pid: process.pid, n, resumed, previousAlive, threadId, bindingAtSubmission, archivesAtSubmission }) + '\n');
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
    TEST_CODEX_EXTERNAL_WRITER: holder, TEST_CODEX_ARCHIVED_STAGING_THREAD: archived, TEST_CODEX_DELETED_THREADS: deleted,
    TEST_CODEX_SESSION_REGISTRY: path.join(userData, 'sessions.json'),
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
    const chat = win.locator('.agent-chat-view').filter({ visible: true });
    const composer = chat.locator('.agent-composer');
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
    await expect(chat.getByText('answer 2', { exact: true })).toBeVisible();
    await expect(win.locator('.chat-execution-status')).toHaveCount(0);
    await test.step('外部客户端仍占用原线程时，原聊天窗口直接续聊', async () => {
      fs.writeFileSync(holder, 'held');
      expect((await win.evaluate(id => window.api.agentSession.send(id, 'continue while Codex is open'), session.id)).ok).toBe(true);
      await expect(chat.getByText('answer 3', { exact: true })).toBeVisible();
      await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.busy).toBe(false);
      const attempts = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(attempts).toHaveLength(3);
      expect(attempts[2]).toMatchObject({ threadId: 'fixture-thread-continuation', bindingAtSubmission: 'fixture-thread-continuation',
        archivesAtSubmission: ['fixture-thread-staging'] });
      expect(fs.existsSync(holder)).toBe(true);
      await expect(chat.getByText('answer 2', { exact: true })).toBeVisible();
      const { sessions: rows } = await win.evaluate(() => window.api.sessions.list());
      expect(rows.filter(row => row.runtime === 'codex-gui').map(row => row.id)).toEqual([session.id]);
    });
    const source = 'fixture-thread';
    const staging = 'fixture-thread-staging';
    const continuation = 'fixture-thread-continuation';
    const idsIn = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
    const rowState = () => win.evaluate(async id => (await window.api.sessions.list()).sessions.find(row => row.id === id), session.id);
    const archive = async () => {
      await win.evaluate(id => window.api.sessions.setArchived(id, true), session.id);
      await expect.poll(async () => {
        const row = await rowState();
        return !!row?.archived && !row.worktreeCleanupPending;
      }).toBe(true);
    };
    const row = win.locator(`[data-session-row="${session.id}"]`);
    const deleteDialog = win.getByRole('dialog', { name: '永久删除' });
    const showDelete = async () => {
      await row.hover();
      await row.getByRole('button', { name: '永久删除' }).click();
      await expect(deleteDialog.getByText(/同时永久删除 Codex 中的 3 条会话记录/)).toBeVisible();
    };
    await test.step('原生写锁阻止删除，恢复后仍能在原窗口接着聊', async () => {
      await archive();
      expect(idsIn(archived)).toEqual([staging]);
      await expect.poll(() => win.evaluate(async id => (await window.api.notify.list('codex-test'))
        .some(item => item.sessionId === id && item.text?.includes('集序已归档，原生会话同步失败')), session.id)).toBe(true);
      await win.locator('.left-panel-scroll .panel-header.sub').first().hover();
      await win.getByRole('button', { name: /显示已归档的工作会话/ }).click();
      await showDelete();
      await deleteDialog.screenshot({ path: testInfo.outputPath('codex-native-delete-dark.png'), animations: 'disabled' });
      const size = await app!.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const size = window.getContentSize();
        window.setMinimumSize(640, 480);
        window.setContentSize(820, 700);
        return size;
      });
      await win.evaluate(() => window.api.themes.activate('light'));
      await expect(deleteDialog.getByRole('button', { name: '永久删除' })).toBeInViewport();
      await deleteDialog.screenshot({ path: testInfo.outputPath('codex-native-delete-light-narrow.png'), animations: 'disabled' });
      await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), size);
      await win.evaluate(() => window.api.themes.activate('dark'));
      await deleteDialog.getByRole('button', { name: '永久删除' }).click();
      const failure = win.getByRole('dialog', { name: '删除失败' });
      await expect(failure.getByText(/Codex 仍在使用关联会话/)).toBeVisible();
      await expect(failure.getByRole('button', { name: /强制删除 worktree/ })).toHaveCount(0);
      await failure.getByRole('button', { name: '知道了' }).click();
      expect((await rowState())?.archived).toBe(true);
      expect(idsIn(deleted)).toEqual([]);
      await win.evaluate(id => window.api.sessions.continueArchived(id), session.id);
      expect((await win.evaluate(id => window.api.agentSession.send(id, 'continue after refused archive'), session.id)).ok).toBe(true);
      await expect(chat.getByText('answer 4', { exact: true })).toBeVisible();
      await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.busy).toBe(false);
      expect(JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1)!).threadId).toBe(continuation);
    });
    await test.step('归档、恢复和永久删除同步到拥有的原生线程', async () => {
      fs.unlinkSync(holder);
      await archive();
      expect(idsIn(archived)).toEqual([staging, source, continuation]);
      await win.evaluate(id => window.api.sessions.setArchived(id, false), session.id);
      expect((await rowState())?.archived).toBeUndefined();
      expect(idsIn(archived)).toEqual([staging]);
      await archive();
      if (!await row.isVisible()) {
        await win.locator('.left-panel-scroll .panel-header.sub').first().hover();
        await win.getByRole('button', { name: /显示已归档的工作会话/ }).click();
      }
      await showDelete();
      await deleteDialog.getByRole('button', { name: '永久删除' }).click();
      await expect.poll(rowState).toBeUndefined();
      expect(idsIn(deleted)).toEqual([continuation, staging, source]);
      expect(idsIn(archived)).toEqual([]);
    });
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
