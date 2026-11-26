/** Real Pi/Host/preload/renderer lifecycle; model replies are held by a local HTTP fixture. */
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('GUI 新回合清旧完成态；静默保持运行；调度刷新后从主进程恢复 busy', async () => {
  test.setTimeout(90_000);
  const repo = path.resolve(__dirname, '../..');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'board-status-e2e-'));
  const workspace = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(workspace); fs.mkdirSync(userData, { recursive: true });
  const ws = 'board-test';
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'light', activeWorkspaceId: ws, defaultCwd: workspace,
    workspaces: [{ id: ws, name: 'Board test', path: workspace }],
    openai: { baseUrl: '', apiKey: '', model: '' },
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{
    id: 'board-worker', name: '静默任务', type: 'terminal', launchKind: 'agent', runtime: 'pi',
    guiMode: 'auto', workspaceId: ws, cwd: workspace, createdAt: Date.now() - 600_000,
    lifecycle: 'idle', phase: { value: 'done', source: 'model', ts: 1 }
  }]));
  const held = new Map<string, http.ServerResponse>();
  const reply = (res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'board', object: 'chat.completion.chunk', choices: [
      { index: 0, delta: { content: 'Local fixture completed.' }, finish_reason: 'stop' }
    ] })}\n\ndata: [DONE]\n\n`);
  };
  const model = http.createServer((req, res) => {
    let body = ''; req.on('data', part => { body += part; });
    req.on('end', () => {
      const last = JSON.parse(body).messages?.at(-1);
      const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      const key = text?.includes('hold-board-worker') ? 'worker' : text?.includes('hold-board-scheduler') ? 'scheduler' : undefined;
      if (key) held.set(key, res); else reply(res);
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd) } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [repo, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 30_000 });
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 30_000 });
    await win.evaluate(baseUrl => window.api.config.update({ openai: { baseUrl, apiKey: 'local-fixture', model: 'mock' } }), `http://127.0.0.1:${port}/v1`);
    const row = () => win.evaluate(async () => (await window.api.sessions.list()).sessions.find(s => s.id === 'board-worker'));
    expect((await row())?.phase?.value).toBe('done');
    await win.evaluate(() => window.api.sessions.select('board-worker'));
    await expect.poll(() => win.evaluate(() => window.api.agentSession.historyRange('board-worker'))).not.toBeNull();
    expect((await win.evaluate(() => window.api.agentSession.send('board-worker', 'hold-board-worker'))).ok).toBe(true);
    await expect.poll(() => held.has('worker')).toBe(true);
    expect((await row())?.phase).toBeUndefined();
    expect((await row())?.activity?.guiTurn).toBe(true);
    await win.locator('.chrome-gboard-btn').click();
    const card = win.locator('.board-grid .board-card').filter({ has: win.getByRole('button', { name: '静默任务', exact: true }) });
    await expect(card.locator('.board-card-status')).toHaveText('工作中');
    // Advance only renderer time: the real Host still owns an unfinished request.
    await win.clock.install();
    await win.clock.fastForward(600_001);
    await expect(card.locator('.board-card-status')).toHaveText('工作中');
    const rejection = await win.evaluate(async () => {
      try { await window.api.sessions.review({ sessionId: 'board-worker', decision: 'passed' }); return ''; }
      catch (error) { return String(error); }
    });
    expect(rejection).toContain('不是待验收');
    expect((await row())?.archived).not.toBe(true);
    reply(held.get('worker')!); held.delete('worker');
    await expect.poll(async () => (await row())?.activity?.kind).toBe('idle');
    await expect(card.locator('.board-card-status')).toHaveText('空闲');

    await win.evaluate(ws => window.api.chat.setMode('default', ws), ws);
    expect((await win.evaluate(ws => window.api.chat.send('hold-board-scheduler', ws), ws)).accepted).toBe(true);
    await expect.poll(() => held.has('scheduler')).toBe(true);
    expect((await win.evaluate(ws => window.api.chat.state(ws), ws)).busy).toBe(true);
    await win.reload();
    await win.locator('.app-shell').waitFor();
    await win.locator('.chrome-gboard-btn').click();
    await expect(win.locator('.board-grid .board-sched-card')).toHaveCount(0);
    reply(held.get('scheduler')!); held.delete('scheduler');
    await expect.poll(async () => (await win.evaluate(ws => window.api.chat.state(ws), ws)).busy).toBe(false);
    await expect(win.locator('.board-grid .board-sched-card')).toHaveCount(0);
  } finally {
    for (const res of held.values()) if (!res.destroyed) reply(res);
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    if (app) {
      await app.evaluate(({ app }) => app.exit()).catch(() => {});
      await app.close().catch(() => {});
    }
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
