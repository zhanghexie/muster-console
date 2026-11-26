import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('GitLab webhook is accepted as an event without starting a scheduled task', async ({ request }) => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  const tmpBase = path.join(project, '.tmp');
  fs.mkdirSync(tmpBase, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(tmpBase, 'gitlab-webhook-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox', 'userData');
  const workspace = path.join(fixture, 'workspace');
  const runtimeRoot = path.join(userData, 'agent-runtimes');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const builtinRoot = path.join(project, 'src/main/runtime/builtins');
  fs.cpSync(path.join(builtinRoot, 'scripts'), path.join(runtimeRoot, 'scripts'), { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(builtinRoot, 'registry.json'), 'utf8'));
  const fixtureRuntime = registry.runtimes.find((entry: { id: string }) => entry.id === 'cursor-cli');
  fixtureRuntime.extraArgs = [];
  fixtureRuntime.enabled = true;
  fs.writeFileSync(path.join(runtimeRoot, 'registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', workspace, activeWorkspaceId: 'ws',
    workspaces: [{ id: 'ws', name: 'Webhook fixture', path: workspace }],
    defaultRuntime: 'cursor-cli', openai: { baseUrl: '', apiKey: '', model: '' },
    mcp: { enabled: false, servers: [] }
  }));
  const captured = path.join(fixture, 'captured-prompt.txt');
  const child = path.join(fixture, 'fixture-cli.cjs');
  fs.writeFileSync(child, [
    "const fs = require('node:fs');",
    "const prefix = '请使用 UTF-8 编码读取并立即执行任务文件：';",
    "const arg = process.argv.find(value => value.includes(prefix)) || '';",
    "const file = arg.includes(prefix) ? arg.slice(arg.indexOf(prefix) + prefix.length).trim() : '';",
    "fs.writeFileSync(" + JSON.stringify(captured) + ", file ? fs.readFileSync(file, 'utf8') : '', 'utf8');",
    "console.log('fixture done');",
    "setTimeout(() => process.exit(0), 1000);"
  ].join(String.fromCharCode(10)));
  fs.writeFileSync(path.join(runtimeRoot, 'scripts', 'fixture-cli.mjs'), [
    "import { randomUUID } from 'node:crypto';",
    "import { appendCliPrompt } from './_helpers.mjs';",
    "export async function allocate() { return { sessionId: randomUUID() }; }",
    "export function appendPrompt(options) { return appendCliPrompt(options); }",
    "export function resolveLaunch({ extraArgs }) { return { command: " + JSON.stringify(process.execPath) +
      ", args: [" + JSON.stringify(child) + ", ...extraArgs] }; }"
  ].join(String.fromCharCode(10)));
  for (const dir of ['appdata', 'localappdata', 'cli-home']) fs.mkdirSync(path.join(fixture, dir), { recursive: true });
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX',
    'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'GITLAB_TOKEN']) delete env[key];
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: 'gitlab-e2e-' + process.pid,
    MUSTER_WEB: '1', MUSTER_WEB_PORT: '0', MUSTER_WEB_HOST: '127.0.0.1',
    APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata'),
    MUSTER_CLI_HOME: path.join(fixture, 'cli-home') });
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env, timeout: 30_000 });
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    // The registry now admits built-in runtimes only. Replace this adapter solely in
    // the isolated userData after boot so no real CLI, account, or network is used.
    fs.copyFileSync(path.join(runtimeRoot, 'scripts', 'fixture-cli.mjs'), path.join(runtimeRoot, 'scripts', 'cursor-cli.mjs'));
    const setup = await win.evaluate(async () => {
      const api = (window as any).api;
      const configured = await api.webAccess.setHookSecret('fixture-secret');
      if (!configured.ok) throw new Error(configured.error);
      return { status: await api.webAccess.status() };
    });
    expect(setup.status.running).toBe(true);
    const hookUrl = 'http://127.0.0.1:' + setup.status.port + setup.status.hook.path;
    const headers = { 'x-gitlab-event': 'Issue Hook', 'x-gitlab-token': 'fixture-secret' };
    const payload = { object_kind: 'issue', project: { id: 6528 },
      object_attributes: { project_id: 6528, iid: 42, action: 'open', title: 'Fixture title' } };
    const denied = await request.post(hookUrl, { headers: { ...headers, 'x-gitlab-token': 'wrong' }, data: payload });
    expect(denied.status()).toBe(401);
    const other = await request.post(hookUrl, { headers, data: { ...payload,
      project: { id: 99 }, object_attributes: { ...payload.object_attributes, project_id: 99 } } });
    expect((await other.json()).triggered).toBe(0);
    const deliveryHeaders = { ...headers, 'x-gitlab-event-uuid': 'fixture-delivery-1' };
    const response = await request.post(hookUrl, { headers: deliveryHeaders, data: payload });
    expect(response.status()).toBe(200);
    expect((await response.json()).queued).toBe(true);
    expect((await request.post(hookUrl, { headers: deliveryHeaders, data: payload })).status()).toBe(200);
    await win.waitForTimeout(1500);
    expect(fs.existsSync(captured)).toBe(false);
    const services = await win.evaluate(async () => (window as any).api.services.list('ws'));
    expect(services.services).toHaveLength(0);
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    const resolved = fs.realpathSync(fixture);
    expect(path.dirname(resolved)).toBe(fs.realpathSync(tmpBase));
    expect(path.basename(resolved)).toMatch(/^gitlab-webhook-e2e-/);
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
