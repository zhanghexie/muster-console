import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('空白 CLI 创建通过真实 IPC 和 PTY 把会话选项传给进程', async () => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'cli-task-options-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox', 'userData');
  const workspace = path.join(fixture, '.dev-sandbox', 'workspaces', 'demo-frontend');
  const bin = path.join(fixture, 'bin');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(bin);
  const home = path.join(userData, 'capability-home');
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
  const runtimeDir = path.join(userData, 'agent-runtimes');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(project, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  for (const entry of registry.runtimes) entry.enabled = entry.id === 'claude-code';
  fs.writeFileSync(path.join(runtimeDir, 'registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: workspace }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  const records = path.join(fixture, 'argv.json');
  const child = path.join(fixture, 'fake-claude.cjs');
  fs.writeFileSync(child, `require('node:fs').writeFileSync(${JSON.stringify(records)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('fixture ready\\n'); process.stdin.resume();`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${child}" %*\r\n`);
    fs.writeFileSync(path.join(bin, 'lark-cli.cmd'), '@exit /b 1\r\n');
  } else {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${child.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'lark-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_HOST', 'MUSTER_STATUS_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `cli-options-${process.pid}`,
    MUSTER_WEB_PORT: '0', HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  let sessionId: string | undefined;
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    const session = await win.evaluate(async () => (window as any).api.sessions.create({ workspaceId: 'demo-frontend', runtime: 'claude-code', force: true,
      cliLaunchOptions: { model: 'test-model', permission: 'edits', reasoning: 'high' } }));
    sessionId = session.id;
    expect(session.cliLaunchOptions).toEqual({ model: 'test-model', permission: 'edits', reasoning: 'high' });
    await expect.poll(() => fs.existsSync(records), { timeout: 20_000 }).toBe(true);
    const argv: string[] = JSON.parse(fs.readFileSync(records, 'utf8'));
    expect(argv).toEqual(expect.arrayContaining(['--model', 'test-model', '--permission-mode', 'acceptEdits', '--effort', 'high']));
    expect(argv.indexOf('--model')).toBeLessThan(argv.indexOf('--'));
    const reloaded = await win.evaluate(async id => (await (window as any).api.sessions.list()).sessions.find((row: { id: string }) => row.id === id), sessionId);
    expect(reloaded.cliLaunchOptions).toEqual({ model: 'test-model', permission: 'edits', reasoning: 'high' });
  } finally {
    if (sessionId) { const win = await app.firstWindow().catch(() => undefined); await win?.evaluate(async id => (window as any).api.sessions.setArchived(id, true), sessionId).catch(() => {}); }
    await app.close().catch(() => {});
  }
});

test('Kimi CLI 复用 GUI 目录并将思考强度写入终端接续的原生会话', async () => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'kimi-task-options-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox', 'userData');
  const workspace = path.join(fixture, '.dev-sandbox', 'workspaces', 'demo-frontend');
  const bin = path.join(fixture, 'bin'), home = path.join(userData, 'capability-home');
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true }); fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
  const runtimeDir = path.join(userData, 'agent-runtimes'); fs.mkdirSync(runtimeDir, { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(project, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  const extraDir = path.join(fixture, 'extra'); fs.mkdirSync(extraDir);
  for (const entry of registry.runtimes) {
    entry.enabled = entry.id === 'kimi-cli';
    if (entry.id === 'kimi-cli') entry.extraArgs = ['--add-dir', extraDir];
  }
  fs.writeFileSync(path.join(runtimeDir, 'registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: workspace }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  const rpcLog = path.join(fixture, 'rpc.jsonl'), tuiLog = path.join(fixture, 'tui.json');
  const child = path.join(project, 'test/fixtures/fake-kimi-acp.mjs');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'kimi.cmd'), `@"${process.execPath}" "${child}" %*\r\n`);
    fs.writeFileSync(path.join(bin, 'lark-cli.cmd'), '@exit /b 1\r\n');
  } else {
    fs.writeFileSync(path.join(bin, 'kimi'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${child.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'lark-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_HOST', 'MUSTER_STATUS_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `kimi-options-${process.pid}`, MUSTER_WEB_PORT: '0',
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    KIMI_TEST_LOG: rpcLog, KIMI_TEST_TUI_LOG: tuiLog });
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  let sessionId: string | undefined;
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    const source = { workspaceId: 'demo-frontend', rootId: 'root-demo-frontend' };
    const catalog = await win.evaluate(async source => (window as any).api.agentSession.listAcpModels({ source, agentId: 'kimi',
      cliRuntimeId: 'kimi-cli', requestId: 'kimi-test-catalog', refresh: true }), source);
    expect(catalog.ok).toBe(true);
    expect(catalog.items.map((item: { id: string }) => item.id)).toContain('provider/two');
    const parameters = await win.evaluate(async source => (window as any).api.agentSession.describeModelParameters({ source, runtimeId: 'acp', piModeId: 'kimi' }), source);
    expect(parameters.parameters.find((item: { id: string }) => item.id === 'reasoning').options.map((item: { value: string }) => item.value)).toContain('low');
    const mismatch = await win.evaluate(async source => (window as any).api.agentSession.listAcpModels({ source, agentId: 'opencode',
      cliRuntimeId: 'kimi-cli', requestId: 'kimi-test-mismatch', refresh: false }), source);
    expect(mismatch.ok).toBe(false);
    const session = await win.evaluate(async () => (window as any).api.sessions.create({ workspaceId: 'demo-frontend', runtime: 'kimi-cli', force: true,
      injectHostIntro: false, cliLaunchOptions: { model: 'provider/two', reasoning: 'low', mode: 'plan' } }));
    sessionId = session.id;
    await expect.poll(() => fs.existsSync(tuiLog), { timeout: 25_000 }).toBe(true);
    expect(JSON.parse(fs.readFileSync(tuiLog, 'utf8'))).toEqual(['--session', 'session_test', '--add-dir', extraDir]);
    const requests = fs.readFileSync(rpcLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(item => item.method === 'session/set_config_option').map(item => [item.params.configId, item.params.value]))
      .toEqual(expect.arrayContaining([['model', 'provider/two'], ['thinking', 'low'], ['mode', 'plan']]));
    expect(requests.filter(item => item.method === 'session/new').some(item => item.params.additionalDirectories?.[0] === extraDir)).toBe(true);
    const saved = await win.evaluate(async id => (await (window as any).api.sessions.list()).sessions.find((row: { id: string }) => row.id === id), sessionId);
    expect(saved.externalSessionId).toBe('session_test');
  } finally {
    if (sessionId) { const win = await app.firstWindow().catch(() => undefined); await win?.evaluate(async id => (window as any).api.sessions.setArchived(id, true), sessionId).catch(() => {}); }
    await app.close().catch(() => {});
  }
});
