import { _electron, expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('Qwen ACP displays the tool result and the exact submitted text on demand', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputDir;
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  const workspace = path.join(cwd, 'workspace');
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(workspace, 'settings-example.txt');
  const content = 'Fixture read result.';
  fs.writeFileSync(file, content);
  const sessionId = '7e5642ab-2be5-4d0b-9ebc-6923858c2f16';
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'qwen-fixture', defaultCwd: workspace,
    workspaces: [{ id: 'qwen-fixture', name: 'Qwen ACP fixture', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{
    id: sessionId, type: 'terminal', launchKind: 'agent', runtime: 'acp', piModeId: 'qwen',
    name: 'Qwen fixture', workspaceId: 'qwen-fixture', cwd: workspace, createdAt: Date.now(), lifecycle: 'idle'
  }]));
  const script = path.join(cwd, 'qwen-fixture.cjs');
  const capturedPrompt = path.join(cwd, 'acp-prompt.json');
  fs.writeFileSync(script, `
const { createInterface } = require('node:readline');
const lines = createInterface({ input: process.stdin });
const send = message => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
const sessionId = 'qwen-fixture';
const toolCallId = 'read-1';
const update = fields => send({ method: 'session/update', params: { sessionId, update: fields } });
lines.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  const reply = result => send({ id, result });
  if (method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  else if (method === 'session/new') reply({ sessionId });
  else if (method === 'session/prompt') {
    require('node:fs').writeFileSync(${JSON.stringify(capturedPrompt)}, JSON.stringify(params.prompt));
    const file = ${JSON.stringify(file)};
    update({ sessionUpdate: 'tool_call', toolCallId, kind: 'read', status: 'pending', title: 'ReadFile',
      rawInput: {}, locations: [], _meta: { toolName: 'read_file', phase: 'preparing' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', title: 'ReadFile: settings-example.txt',
      rawInput: { file_path: file, limit: 2 }, locations: [{ path: file, line: null }], _meta: { toolName: 'read_file' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: '',
      content: [{ type: 'content', content: { type: 'text', text: ${JSON.stringify(content)} } }] });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Read complete.' } });
    reply({ stopReason: 'end_turn' });
  } else if (id != null) reply({});
});
`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'qwen.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(path.join(bin, 'qwen'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
  env.MUSTER_SANDBOX = '1';
  env.MUSTER_INSTANCE_ID = `qwen-tools-${process.pid}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
  try {
    const win = await app.firstWindow();
    win.setDefaultTimeout(8_000);
    await win.locator('.app-shell').waitFor();
    await win.evaluate(id => window.api.sessions.select(id), sessionId);
    const sent = await win.evaluate(id => window.api.agentSession.send(id, 'Read the fixture.'), sessionId);
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const chat = win.locator(`.agent-chat-view[data-session-id="${sessionId}"]`);
    await expect(chat.getByText('Read complete.')).toBeVisible({ timeout: 20_000 });
    const sentText = JSON.parse(fs.readFileSync(capturedPrompt, 'utf8')).find((block: { type: string }) => block.type === 'text').text;
    expect(sentText).toMatch(/^Read the fixture\.\n\n<muster_host_context source="automatic">\nMuster Console opens or resumes your Harness session\.[\s\S]*\n<\/muster_host_context>$/);
    expect(sentText).toContain(`Your session ID in Muster is ${sessionId}.`);
    expect(sentText.split('</muster_host_context>')).toHaveLength(2);
    expect(sentText).toContain('## Workspace Directory Scope');
    expect(sentText).toContain('ACP registers cwd.');
    expect(sentText).not.toContain('Pi file tools');
    expect(sentText).toContain('search first with mcp__muster__host_memory_search');
    const userRow = chat.locator('.chat-turn-anchor[data-role="user"]');
    const raw = userRow.getByLabel('发送给 Harness 的完整文本');
    await expect(userRow.getByText('Read the fixture.', { exact: true })).toBeVisible();
    await expect(raw).toHaveCount(0);
    await userRow.screenshot({ path: info.outputPath('harness-off.png') });
    const menu = win.getByTestId('center-pane-handle-0');
    const transparency = win.getByRole('menuitemcheckbox', { name: 'Harness 透明', exact: true });
    await menu.press('Enter');
    await expect(transparency).toHaveAttribute('aria-checked', 'false');
    await transparency.click();
    await expect(raw).toBeVisible();
    expect(await raw.textContent()).toBe(sentText);
    await expect(chat.locator('.harness-inject')).toHaveCount(0);
    await expect(chat.getByText(/注入与压缩记录/)).toHaveCount(0);
    await win.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { value: {
        writeText: async (value: string) => { document.documentElement.dataset.copied = value; }
      } });
    });
    await userRow.getByRole('button', { name: '复制内容' }).click();
    expect(await win.locator('html').getAttribute('data-copied')).toBe(sentText);
    await win.evaluate(() => { delete document.documentElement.dataset.copied; });
    await chat.screenshot({ path: info.outputPath('harness-on.png') });
    const originalWidth = (await chat.boundingBox())!.width;
    await win.evaluate(() => window.api.themes.activate('light'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 820));
    await expect.poll(async () => (await chat.boundingBox())!.width).toBeLessThan(originalWidth);
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await raw.evaluate(node => node.scrollWidth === node.clientWidth && node.scrollHeight > node.clientHeight)).toBe(true);
    await raw.press('End');
    await expect.poll(() => raw.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await raw.press('Home');
    await expect.poll(() => raw.evaluate(node => node.scrollTop)).toBe(0);
    await expect(chat.locator('.harness-inject')).toHaveCount(0);
    await chat.screenshot({ path: info.outputPath('harness-on-light-narrow.png') });
    await menu.press('Enter');
    await expect(transparency).toHaveAttribute('aria-checked', 'true');
    await transparency.click();
    await expect(raw).toHaveCount(0);
    await expect(userRow.getByText('Read the fixture.', { exact: true })).toBeVisible();
    await chat.locator('.turn-fold[aria-expanded="false"]').click();
    const card = chat.locator('details.tool-card');
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('link', { name: /settings-example\.txt/ })).toBeVisible();
    await card.locator('summary .tool-lite-verb').click();
    await expect(card.getByText(content, { exact: true })).toBeVisible();
    expect(JSON.parse(await card.locator('pre').first().innerText())).toEqual({ file_path: file, limit: 2 });
    const messageId = (await userRow.getAttribute('data-mid'))!;
    const savedDir = path.join(userData, 'agent-inputs', sessionId, messageId);
    const files = fs.readdirSync(savedDir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(savedDir, files[0]!), 'utf8'))).toBe(sentText);
    const wrongRef = '00000000-0000-0000-0000-000000000000';
    expect(await win.evaluate(({ sessionId, messageId, wrongRef }) => window.api.agentSession.engineInput(sessionId, messageId, wrongRef), { sessionId, messageId, wrongRef })).toBeNull();
    expect(await win.evaluate(id => window.api.agentSession.clear(id), sessionId)).toEqual({ ok: true });
    expect(fs.existsSync(savedDir)).toBe(false);

    const task = 'Read the fixture from a new task.\n\nKeep the whole first message.';
    const launched = await win.evaluate(task => window.api.sessions.delegate({
      task, name: 'Direct Qwen task', runtime: 'acp', piModeId: 'qwen', workspaceId: 'qwen-fixture', isolate: false
    }), task);
    expect(launched.inject?.mode).toBe('gui-prompt');
    const taskChat = win.locator(`.agent-chat-view[data-session-id="${launched.session!.id}"]`);
    await expect(taskChat.getByText('Read complete.')).toBeVisible({ timeout: 20_000 });
    const firstMessage = taskChat.locator('.chat-turn-anchor[data-role="user"]');
    await expect(firstMessage).toHaveCount(1);
    await expect(firstMessage).toHaveAttribute('data-mid', launched.inject!.messageId!);
    await expect(firstMessage.getByText('Read the fixture from a new task.', { exact: true })).toBeVisible();
    await expect(firstMessage.getByText('Keep the whole first message.', { exact: true })).toBeVisible();
    await expect(firstMessage.getByText(/scheduler is your task authority/)).toBeVisible();
    await expect(firstMessage.getByLabel('发送给 Harness 的完整文本')).toHaveCount(0);
    const taskInput = JSON.parse(fs.readFileSync(capturedPrompt, 'utf8')).find((block: { type: string }) => block.type === 'text').text;
    const [submittedTask, context, ...extra] = taskInput.split('\n\n<muster_host_context source="automatic">\n');
    expect(context).toContain('mcp__muster__host_turnChanges_trackFiles');
    expect(context).not.toContain('[Host initial assignment]');
    expect(context.endsWith('\n</muster_host_context>')).toBe(true);
    expect(submittedTask).toContain('scheduler is your task authority');
    expect(submittedTask.endsWith(`\n\n${task}`)).toBe(true);
    expect(extra).toHaveLength(0);
    await firstMessage.screenshot({ path: info.outputPath('delegated-first-message.png') });
    await menu.press('Enter');
    await transparency.click();
    const taskRaw = firstMessage.getByLabel('发送给 Harness 的完整文本');
    await expect(taskRaw).toBeVisible();
    expect(await taskRaw.textContent()).toBe(taskInput);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
