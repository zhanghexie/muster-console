import { test as base, expect, _electron } from '@playwright/test';
import type { AppContext } from './fixtures/electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 使用独立配置，不重置共享开发沙盒，也不继承个人配置。
const repoRoot = path.resolve(__dirname, '../..');
const test = base.extend<{}, { appCtx: AppContext }>({
  appCtx: [async ({}, use) => {
    fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
    const cwd = fs.mkdtempSync(path.join(repoRoot, '.tmp/e2e-composer-'));
    const userData = path.join(cwd, '.dev-sandbox/userData');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
      locale: 'zh-CN', themeId: 'dark', uiFont: 'oppo', activeWorkspaceId: 'demo-playground',
      workspaces: [], mcp: { enabled: false, servers: [] }
    }));
    fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    env.MUSTER_SANDBOX = '1';
    env.MUSTER_INSTANCE_ID = path.basename(cwd);
    for (const key of ['MUSTER_NO_SANDBOX', 'MUSTER_DEV_MOBILE_WS', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
    const app = await _electron.launch({ executablePath: createRequire(__filename)('electron'), args: [repoRoot], cwd, env, timeout: 60_000 });
    try {
      const win = await app.firstWindow();
      const consoleErrors: string[] = [];
      win.on('pageerror', e => consoleErrors.push(e.message));
      await win.waitForSelector('.app-shell', { timeout: 60_000 });
      await use({ app, win, consoleErrors });
    } finally {
      await app.evaluate(({ app }) => app.exit()).catch(() => {});
      await app.close().catch(() => {});
    }
  }, { scope: 'worker' }]
});
import http from 'node:http';

test('附件从真实输入框经 IPC、后台转换和 Pi 请求发送，清空后清理文件', async ({ appCtx }, testInfo) => {
  const { app, win: page } = appCtx;
  const requests: any[] = [];
  let requestedConversion = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const request = JSON.parse(body);
      requests.push(request);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null = null) => ({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'attachment-test', choices: [{ index: 0, delta, finish_reason }] });
      if (!requestedConversion) {
        const content = request.messages.find((m: any) => m.role === 'user')?.content;
        const text = typeof content === 'string' ? content : content?.find((b: any) => b.type === 'text')?.text;
        const metadata = JSON.parse(text.split('[Attachment metadata]\n')[1].split('\n')[0]);
        requestedConversion = true;
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'convert-test', type: 'function', function: {
          name: 'attachments_convert', arguments: JSON.stringify({ sourcePath: metadata.sourcePath, mode: 'text', offset: 0, maxChars: 6000 })
        } }] }))}\n\n`);
        res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '附件已收到' }))}\n\n`);
        res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const wsId = await page.evaluate(async port => {
      const api = (window as any).api;
      const cfg = await api.config.get();
      await api.config.update({ llm: { providers: [{ id: 'attachment-test', name: '附件测试', api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-only', models: [{ id: 'attachment-test', multimodal: false, attachments: { nativeAudio: true } }] }], activeProviderId: 'attachment-test', activeModelId: 'attachment-test' } });
      return cfg.activeWorkspaceId;
    }, port);
    await page.locator('.agent-ws-stack-item.is-active .agent-notify-chat').click();
    const shell = page.locator('.agent-float-panel .chat-input-shell');
    await expect(shell).toBeVisible();
    await shell.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('本地转换验证 attachment-local-text') });
    await expect(shell.getByText('notes.txt', { exact: true })).toBeVisible();
    await shell.screenshot({ path: testInfo.outputPath('attachment-card.png') });
    await shell.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests[0])).toContain('attachment-local-text');
    expect(JSON.stringify(requests[0])).toContain('utf-8 text decoding');
    await expect.poll(() => requests.some(r => r.messages?.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes('attachment-local-text')))).toBe(true);
    await expect(shell.getByRole('button', { name: '发送', exact: true })).toBeVisible({ timeout: 30000 });
    await shell.locator('input[type=file]').setInputFiles({ name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from('audio-payload-test') });
    await expect(shell.getByText('voice.wav', { exact: true })).toBeVisible();
    await shell.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => requests.some(r => r.messages?.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'input_audio')))).toBe(true);
    const data = await app.evaluate(({ app }) => app.getPath('userData'));
    const attachmentRoot = path.join(data, 'conversation-attachments');
    expect(fs.readdirSync(attachmentRoot).length).toBe(1);
    await expect(shell.getByRole('button', { name: '发送', exact: true })).toBeVisible({ timeout: 30000 });
    await page.evaluate(wsId => (window as any).api.chat.clear(wsId), wsId);
    expect(fs.readdirSync(attachmentRoot)).toHaveLength(0);
    const gui = await page.evaluate(wsId => (window as any).api.sessions.create({ workspaceId: wsId, runtime: 'pi', name: '附件 GUI 回归', force: true }), wsId);
    const beforeGui = requests.length;
    const sent = await page.evaluate(id => (window as any).api.agentSession.send(id, 'GUI audio', [{ id: 'gui-audio', name: 'voice.wav', mimeType: 'audio/wav', data: btoa('gui-native-audio') }]), gui.id);
    expect(sent.ok, sent.error).toBe(true);
    await expect.poll(() => requests.length, { timeout: 30000 }).toBeGreaterThan(beforeGui);
    expect(JSON.stringify(requests.at(-1))).toContain('input_audio');
    expect(JSON.stringify(requests.at(-1))).toContain(Buffer.from('gui-native-audio').toString('base64'));
    await page.evaluate(id => (window as any).api.agentSession.clear(id), gui.id);
    expect(fs.readdirSync(attachmentRoot)).toHaveLength(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
