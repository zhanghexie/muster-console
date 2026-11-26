import { _electron, expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('permissions default to automatic approval and manual configuration opts into native ACP settings', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputDir;
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  const workspace = path.join(cwd, 'workspace');
  const bin = path.join(cwd, 'bin');
  for (const dir of [userData, workspace, bin]) fs.mkdirSync(dir, { recursive: true });
  const sessionId = 'eef10622-5229-46f4-946b-ad87e4eb32aa';
  const workspaceId = 'native-permissions-fixture';
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', activeWorkspaceId: workspaceId, defaultCwd: workspace,
    workspaces: [{ id: workspaceId, name: 'Native permissions fixture', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{
    id: sessionId, type: 'terminal', launchKind: 'agent', runtime: 'acp', piModeId: 'qwen',
    name: 'Native permissions', workspaceId, cwd: workspace, createdAt: Date.now(), lifecycle: 'idle'
  }]));
  const script = path.join(cwd, 'qwen-permissions.cjs');
  fs.writeFileSync(script, `
const { createInterface } = require('node:readline');
const lines = createInterface({ input: process.stdin });
const send = message => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
const sessionId = 'native-session';
let currentValue = 'engine-build';
let promptId;
const configOptions = () => [{ id: 'native-mode', name: 'Native workspace mode', category: 'mode', type: 'select', currentValue,
  options: [{ value: 'engine-build', name: 'Engine Build' }, { value: 'architect-v2', name: 'Architect v2' }] }];
lines.on('line', line => {
  const { id, method, params, result } = JSON.parse(line);
  const reply = result => send({ id, result });
  if (method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  else if (method === 'session/new') reply({ sessionId, configOptions: configOptions() });
  else if (method === 'session/set_config_option') {
    if (params.sessionId !== sessionId || params.configId !== 'native-mode' || params.value !== 'architect-v2') {
      send({ id, error: { code: -32602, message: 'Unexpected native selection' } });
    } else { currentValue = params.value; reply({ configOptions: configOptions() }); }
  } else if (method === 'session/prompt') {
    promptId = id;
    send({ id: 'permission-request', method: 'session/request_permission', params: { sessionId,
      toolCall: { toolCallId: 'read-native', title: 'Read fixture', name: 'Read', kind: 'read', status: 'pending', rawInput: {} },
      options: [{ optionId: 'fixture-persistent', name: 'Remember workspace approval', kind: 'allow_always' },
        { optionId: 'fixture-denial', name: 'Reject fixture', kind: 'reject_once' }] } });
  } else if (id === 'permission-request') {
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text',
      text: 'Received ' + currentValue + ' / ' + result?.outcome?.optionId } } } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
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
  env.MUSTER_INSTANCE_ID = `native-permissions-${process.pid}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor();
    await win.evaluate(id => window.api.sessions.select(id), sessionId);
    const chat = win.locator(`.agent-chat-view[data-session-id="${sessionId}"]`);
    const toggle = chat.getByRole('switch', { name: '配置权限' });
    const settings = chat.getByRole('button', { name: '引擎设置', exact: true });
    await expect(toggle).toHaveCount(0);
    await expect(settings).toBeVisible();
    const automatic = await win.evaluate(id => window.api.agentSession.send(id, 'Read with the default permissions.'), sessionId);
    expect(automatic.ok, JSON.stringify(automatic)).toBe(true);
    await expect(chat.getByText('Received engine-build / fixture-persistent')).toBeVisible();
    await expect(chat.getByRole('button', { name: /Remember workspace approval/ })).toHaveCount(0);
    await expect.poll(() => win.evaluate(async id => (await window.api.agentSession.historyRange(id))?.busy, sessionId)).toBe(false);
    await settings.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(await win.evaluate(async id => (await window.api.sessions.list()).sessions.find(session => session.id === id)?.configurePermissions, sessionId)).toBe(true);
    await chat.getByRole('button', { name: '刷新引擎设置' }).click();
    const mode = chat.getByRole('button', { name: 'Native workspace mode' });
    await expect(mode).toContainText('Engine Build');
    await mode.click();
    await win.getByRole('option', { name: 'Architect v2' }).click();
    await expect(mode).toContainText('Architect v2');
    await win.keyboard.press('Escape');
    const sent = await win.evaluate(id => window.api.agentSession.send(id, 'Read the fixture.'), sessionId);
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    await chat.getByRole('button', { name: /Remember workspace approval/ }).click();
    await expect(chat.getByText('Received architect-v2 / fixture-persistent')).toBeVisible();
    await expect.poll(() => win.evaluate(async id => (await window.api.agentSession.historyRange(id))?.busy, sessionId)).toBe(false);
    const waiting = await win.evaluate(id => window.api.agentSession.send(id, 'Read again while manual permissions are enabled.'), sessionId);
    expect(waiting.ok, JSON.stringify(waiting)).toBe(true);
    await expect(chat.getByRole('button', { name: /Remember workspace approval/ })).toBeVisible();
    await settings.click();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => win.evaluate(async id => (await window.api.agentSession.historyRange(id))?.busy, sessionId)).toBe(false);
    await expect(chat.getByRole('button', { name: /Remember workspace approval/ })).toHaveCount(0);
    expect(await win.evaluate(async id => (await window.api.sessions.list()).sessions.find(session => session.id === id)?.configurePermissions, sessionId)).toBe(false);
    await win.screenshot({ path: path.join(cwd, 'permissions-default.png') });
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
