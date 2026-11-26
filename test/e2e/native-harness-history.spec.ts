import { _electron, expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('external Harness history loads without a Core mode through real IPC', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputDir;
  const workspace = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  const histories = path.join(userData, 'agent-sessions');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(histories, { recursive: true });
  const workspaceId = 'native-history-fixture';
  const nativeId = '298c1e22-e531-4360-b282-7d7e02e609f8';
  const coreId = 'aa70a615-5b04-472c-b734-8a4a15b35424';
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: workspaceId, defaultCwd: workspace,
    workspaces: [{ id: workspaceId, name: 'Native history fixture', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([
    { id: nativeId, type: 'terminal', launchKind: 'agent', runtime: 'acp', piModeId: 'qwen',
      name: 'Qwen history regression', workspaceId, cwd: workspace, createdAt: Date.now(), lifecycle: 'idle' },
    { id: coreId, type: 'terminal', launchKind: 'agent', runtime: 'pi', guiMode: 'ask',
      name: 'Core history control', workspaceId, cwd: workspace, createdAt: Date.now(), lifecycle: 'idle' }
  ]));
  for (const [sessionId, count] of [[nativeId, 125], [coreId, 1]] as const) {
    fs.writeFileSync(path.join(histories, `${sessionId}.json`), JSON.stringify({
      version: 2, messages: Array.from({ length: count }, (_, index) => ({
        id: `${sessionId}-${index}`, role: 'user', ts: Date.now() - (count - index) * 1000,
        parts: [{ kind: 'text', text: `History fixture ${index}` }]
      }))
    }));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `native-history-${process.pid}` });
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor();
    await win.evaluate(id => window.api.sessions.select(id), nativeId);
    const chat = win.locator(`.agent-chat-view[data-session-id="${nativeId}"]`);
    const raw = await win.evaluate(id => window.api.agentSession.historyRange(id, undefined, 120), nativeId);
    expect(raw).not.toBeNull();
    if (!raw) throw new Error('The native history range was not returned');
    expect(raw.mode).toBeUndefined();
    expect(raw.total).toBe(125);
    expect(raw.messages).toHaveLength(120);
    await expect(chat.locator(`[data-mid="${nativeId}-124"]`)).toBeVisible();
    await expect(chat.getByText('Error: Invalid GUI history range response', { exact: true })).toHaveCount(0);
    await chat.locator('.chat-list').evaluate((element, target) => {
      element.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: target }));
    }, `${nativeId}-0`);
    await expect(chat.locator(`[data-mid="${nativeId}-0"]`)).toBeVisible();
    await win.screenshot({ path: path.join(cwd, 'native-history-loaded.png') });

    await win.evaluate(id => window.api.sessions.select(id), coreId);
    const corePage = await win.evaluate(id => window.api.agentSession.historyRange(id), coreId);
    expect(corePage).not.toBeNull();
    if (!corePage) throw new Error('The Core history range was not returned');
    expect(corePage.mode).toBe('auto');
    const coreChat = win.locator(`.agent-chat-view[data-session-id="${coreId}"]`);
    const coreMode = coreChat.getByRole('button', { name: '权限模式', exact: true });
    await expect(coreChat.getByRole('switch')).toHaveCount(0);
    await expect(coreMode).toContainText('完全访问');
    await coreMode.click();
    await coreChat.getByRole('switch', { name: '配置权限' }).click();
    await expect(coreChat.getByRole('switch', { name: '配置权限' })).toHaveAttribute('aria-checked', 'true');
    const configuredPage = await win.evaluate(id => window.api.agentSession.historyRange(id), coreId);
    expect(configuredPage?.mode).toBe('ask');
    await expect(coreMode).toContainText('旧权限：只读问答');
    await coreChat.getByRole('menuitemradio', { name: '标准', exact: true }).click();
    await expect.poll(() => win.evaluate(async id => (await window.api.agentSession.historyRange(id))?.mode, coreId)).toBe('standard');
    const coreToggle = coreChat.getByRole('switch', { name: '配置权限' });
    await coreMode.click();
    await coreToggle.click();
    await expect(coreToggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => win.evaluate(async id => (await window.api.agentSession.historyRange(id))?.mode, coreId)).toBe('auto');
    await expect(coreMode).toContainText('完全访问');
    await coreToggle.click();
    await expect(coreToggle).toHaveAttribute('aria-checked', 'true');
    await expect(coreMode).toContainText('标准');
    await expect.poll(() => win.evaluate(async id => (await window.api.agentSession.historyRange(id))?.mode, coreId)).toBe('standard');
    await expect(win.locator(`[data-mid="${coreId}-0"]`)).toBeVisible();
    await win.evaluate(id => window.api.sessions.select(id), nativeId);
    await expect(chat.locator(`[data-mid="${nativeId}-0"]`)).toBeVisible();
    await win.evaluate(id => window.api.sessions.select(id), coreId);
    if (await coreMode.getAttribute('aria-expanded') !== 'true') await coreMode.click();
    await expect(coreToggle).toHaveAttribute('aria-checked', 'true');
    await expect(coreMode).toContainText('标准');
    await win.reload();
    await win.locator('.app-shell').waitFor();
    await win.evaluate(id => window.api.sessions.select(id), coreId);
    await coreMode.click();
    await expect(coreToggle).toHaveAttribute('aria-checked', 'true');
    await expect(coreMode).toContainText('标准');
    await win.screenshot({ path: path.join(cwd, 'core-permission-restored.png') });
    await win.evaluate(id => window.api.sessions.select(id), nativeId);
    await expect(chat.locator('[data-mid]').first()).toBeVisible();
    await expect(chat.getByText('Error: Invalid GUI history range response', { exact: true })).toHaveCount(0);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
