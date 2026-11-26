import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('真实 Electron：万条历史 tail → target → wheel → tail → restart', async ({}, info) => {
  test.setTimeout(180_000);
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputDir;
  const root = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  const session = 'e5d12e52-d5c1-42ab-8946-a244061c26af';
  const otherSession = '4bb64cf1-08ec-43ab-942a-b874928214d4';
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(userData, 'agent-sessions'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'sparse', defaultCwd: root,
    workspaces: [{ id: 'sparse', name: '范围历史验收', path: root }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{
    id: session, type: 'terminal', launchKind: 'agent', runtime: 'pi', name: '万条范围历史',
    workspaceId: 'sparse', cwd: root, createdAt: Date.now(), lifecycle: 'idle'
  }, {
    id: otherSession, type: 'terminal', launchKind: 'agent', runtime: 'pi', name: '切换验证',
    workspaceId: 'sparse', cwd: root, createdAt: Date.now(), lifecycle: 'idle'
  }]));
  fs.writeFileSync(path.join(userData, 'agent-sessions', `${otherSession}.json`), JSON.stringify({
    version: 2, messages: [{ id: 'other-message', role: 'user', ts: Date.now(), parts: [{ kind: 'text', text: '另一会话' }] }]
  }));
  fs.writeFileSync(path.join(userData, 'agent-sessions', `${session}.json`), JSON.stringify({
    version: 2,
    messages: Array.from({ length: 10000 }, (_, i) => ({
      id: `sparse-${i}`, role: i % 2 ? 'assistant' : 'user', ts: Date.now() - (10000 - i) * 1000,
      parts: [
        ...(i === 2401 ? Array.from({ length: 12 }, (_, tool) => ({ kind: 'tool', tool: {
          id: `tool-${tool}`, name: 'sessions.list', input: {}, status: 'ok', output: '{"ok":true}'
        } })) : []),
        { kind: 'text', text: `第 ${i} 条可恢复历史。\n\n${i % 7 === 0 ? '```typescript\nconst index = ' + i + ';\n```' : '正文与绝对位置一致。'}` }
      ]
    }))
  }));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `sparse-${process.pid}`,
    APPDATA: path.join(cwd, 'appdata'), LOCALAPPDATA: path.join(cwd, 'localappdata') });

  async function launch() {
    const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env, timeout: 30000 });
    console.log('sparse-history: Electron launched');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60000 });
    console.log('sparse-history: app shell ready');
    await win.evaluate(id => window.api.sessions.select(id), session);
    return { app, win };
  }
  async function stop(app: ElectronApplication) {
    const proc = app.process();
    const pid = proc.pid;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([app.close(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Sparse history Electron quit exceeded 20s')), 20000); })]);
    } finally {
      clearTimeout(timer);
    if (proc.exitCode === null && pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* exited */ }
      } else proc.kill('SIGKILL');
    }
    }
  }
  const first = await launch();
  try {
    const { win } = first;
    const chat = win.locator(`.agent-chat-view[data-session-id="${session}"]`);
    const list = chat.locator('.chat-list');
    await expect(chat.locator('[data-mid="sparse-9999"]')).toBeVisible({ timeout: 30000 });
    console.log('sparse-history: tail visible');
    await chat.locator('[data-mid="sparse-9999"]').click();
    await win.keyboard.press('Control+f');
    const search = chat.getByRole('searchbox', { name: '搜索当前会话', exact: true });
    await search.fill('第 3 条可恢复历史');
    await expect(chat.locator('[data-mid="sparse-3"]')).toBeVisible({ timeout: 20000 });
    await expect(chat.locator('[data-mid="sparse-3"] mark.chat-find-hit')).toHaveCount(1);
    await win.screenshot({ path: path.join(cwd, 'search-unloaded-history.png') });
    await search.press('Escape');

    await expect.poll(() => chat.locator('[data-mid]').count()).toBeLessThanOrEqual(120);
    // Multiple disjoint seeks expose races between range retention, DOM seek,
    // scroll events and row measurement that one initial jump can miss.
    for (const index of [7300, 10, 6100]) {
      await list.evaluate((el, id) => el.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: id })), `sparse-${index}`);
      await expect(chat.locator(`[data-mid="sparse-${index}"]`)).toBeVisible({ timeout: 20000 });
    }
    await list.evaluate(el => el.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'sparse-2400' })));
    await expect(chat.locator('[data-mid="sparse-2400"]')).toBeVisible({ timeout: 20000 });
    console.log('sparse-history: target visible');
    const fold = chat.locator('[data-mid="sparse-2401"] .turn-fold');
    await fold.click();
    await expect(chat.locator('[data-mid="sparse-2401"] .tool-call-block')).toHaveCount(12);
    await expect(chat.locator('[data-mid="sparse-2400"]')).toBeVisible();
    await list.evaluate(el => el.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'sparse-7300' })));
    await expect(chat.locator('[data-mid="sparse-7300"]')).toBeVisible({ timeout: 20000 });
    await expect(chat.locator('[data-mid="sparse-2401"]')).toHaveCount(0);
    await list.evaluate(el => el.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'sparse-2400' })));
    await expect(chat.locator('[data-mid="sparse-2401"] .tool-call-block')).toHaveCount(12, { timeout: 20000 });
    await fold.click();
    await expect(chat.locator('[data-mid="sparse-2401"] .tool-call-block')).toHaveCount(0);
    const readingTop = (await chat.locator('[data-mid="sparse-2400"]').boundingBox())!.y;
    console.log('sparse-history: before switch', readingTop, await list.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight })));
    await win.evaluate(id => window.api.sessions.select(id), otherSession);
    await expect(win.locator('[data-mid="other-message"]')).toBeVisible();
    await win.evaluate(id => window.api.sessions.select(id), session);
    await expect(chat.locator('[data-mid="sparse-2400"]')).toBeVisible();
    console.log('sparse-history: after switch', (await chat.locator('[data-mid="sparse-2400"]').boundingBox())!.y, await list.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight })));
    await expect.poll(async () => Math.abs((await chat.locator('[data-mid="sparse-2400"]').boundingBox())!.y - readingTop)).toBeLessThan(2);
    await win.screenshot({ path: path.join(cwd, 'dark-target.png') });
    const targetTop = (await chat.locator('[data-mid="sparse-2400"]').boundingBox())!.y;
    // Exercise the real main→preload→surface event path with a controlled
    // streaming update. No model/network dependency and no durable fixture edit.
    await first.app.evaluate(({ BrowserWindow }, sessionId) => {
      BrowserWindow.getAllWindows()[0].webContents.send('agentSession:event', {
        sessionId, kind: 'delta', messageId: 'sparse-9999', partIndex: 0,
        deltaKind: 'text', delta: '\n实时追加不拉走旧页读者。', liveSeq: 1
      });
    }, session);
    await expect.poll(async () => Math.abs((await chat.locator('[data-mid="sparse-2400"]').boundingBox())!.y - targetTop)).toBeLessThan(2);
    const oldTop = await list.evaluate(el => el.scrollTop);
    await list.hover();
    await win.mouse.wheel(0, -18000);
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeLessThan(oldTop);
    await expect.poll(() => list.evaluate(el => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll<HTMLElement>('[data-mid]')].find(node => node.getBoundingClientRect().bottom > top);
      return Number(row?.dataset.mid?.split('-')[1] ?? 10000);
    })).toBeLessThan(2340);
    await expect.poll(() => chat.locator('[data-mid]').count()).toBeLessThanOrEqual(120);
    await win.evaluate(() => window.api.themes.activate('light'));
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 760));
    await win.screenshot({ path: path.join(cwd, 'light-narrow-history.png') });
    await list.evaluate(el => el.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'sparse-9999' })));
    await expect(chat.locator('[data-mid="sparse-9999"]')).toBeVisible({ timeout: 20000 });
    await expect(chat.locator('[data-mid="sparse-9999"]')).toContainText('实时追加不拉走旧页读者。');
    const range = await win.evaluate(id => window.api.agentSession.historyRange(id, undefined, 120, 'sparse-2400'), session);
    expect(range?.messages).toHaveLength(120);
    expect(range?.messages.some(message => message.id === 'sparse-2400')).toBe(true);
    await win.screenshot({ path: path.join(cwd, 'tail.png') });
  } finally { await stop(first.app); }
  const restarted = await launch();
  try {
    await expect(restarted.win.locator(`[data-mid="sparse-9999"]`)).toBeVisible({ timeout: 30000 });
    expect(fs.existsSync(path.join(userData, 'agent-sessions', `${session}.json.ranges`))).toBe(true);
    await restarted.app.evaluate((_electron, checkpoint) => {
      const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
      const original = fs.readFileSync;
      (globalThis as any).__rangeFullReads = 0;
      (globalThis as any).__restoreRangeReader = () => { fs.readFileSync = original; };
      fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (String(file) === checkpoint) (globalThis as any).__rangeFullReads++;
        return (original as (...args: unknown[]) => unknown)(file, ...args);
      }) as typeof fs.readFileSync;
    }, path.join(userData, 'agent-sessions', `${session}.json`));
    const range = await restarted.win.evaluate(id => window.api.agentSession.historyRange(id, undefined, 120, 'sparse-2400'), session);
    expect(range?.total).toBe(10000);
    expect(range?.messages.some(message => message.id === 'sparse-2400')).toBe(true);
    expect(await restarted.app.evaluate(() => (globalThis as any).__rangeFullReads)).toBe(0);
    await restarted.app.evaluate(() => (globalThis as any).__restoreRangeReader());
  } finally { await stop(restarted.app); }
});
