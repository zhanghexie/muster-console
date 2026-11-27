/** 真 Electron/preload/IPC/SessionMeta；隔离的 Codex app-server 夹具。 */
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);

test('Codex GUI 模型目录 → 覆盖 → 原生回合参数 → 恢复 CLI 默认', async ({}, testInfo) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-menu-e2e-'));
  const workspace = path.join(cwd, 'workspace');
  const secondary = path.join(cwd, 'secondary');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  const codexHome = path.join(cwd, 'codex-home');
  const profile = path.join(cwd, 'profile');
  const appData = path.join(profile, 'AppData', 'Roaming');
  const localAppData = path.join(profile, 'AppData', 'Local');
  const bin = process.platform === 'darwin'
    ? path.join(profile, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS')
    : process.platform === 'win32' ? path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'abcde1234567890f')
      : path.join(profile, '.local', 'bin');
  for (const dir of [workspace, secondary, userData, bin, codexHome, appData, localAppData,
    path.join(profile, 'Documents'), path.join(profile, 'Desktop')]) fs.mkdirSync(dir, { recursive: true });
  const executable = path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.copyFileSync(process.execPath, executable); fs.chmodSync(executable, 0o755);
  const discoveryLedger = path.join(cwd, 'discovery.log');
  const degradedCatalog = path.join(workspace, 'degraded-model-catalog');
  fs.writeFileSync(path.join(workspace, 'app-server'), String.raw`
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const threadId = 'fixture-thread';
const defaultModel = 'cli-default';
let resumed = false;
let tools = {};
rl.on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const params = request.params ?? {};
  const reply = value => console.log(JSON.stringify({ id: request.id, ...value }));
  if (request.method === 'initialize') {
    reply({ result: { codexHome: process.env.CODEX_HOME } });
  } else if (request.method === 'config/read') {
    reply({ result: { config: { model: defaultModel, model_reasoning_effort: 'high' } } });
  } else if (request.method === 'model/list') {
    fs.appendFileSync(process.env.TEST_CODEX_DISCOVERY_LEDGER, 'list\n');
    if (fs.existsSync('degraded-model-catalog')) {
      reply({ error: { code: -32601, message: 'Model listing unavailable' } });
      return;
    }
    const parameters = { supportedReasoningEfforts: ['low', 'medium', 'high', 'max'], defaultReasoningEffort: 'medium' };
    reply({ result: { data: [
      { model: defaultModel, displayName: 'CLI Default', isDefault: true, ...parameters },
      { model: 'chosen', displayName: 'Selected Codex', ...parameters }
    ], nextCursor: null } });
  } else if (request.method === 'permissionProfile/list' || request.method === 'collaborationMode/list') {
    reply({ result: { data: [], nextCursor: null } });
  } else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    resumed = params.threadId === threadId;
    tools = Object.fromEntries((params.config?.['mcp_servers.muster']?.enabled_tools ?? []).map(name => [name, {}]));
    reply({ result: { thread: { id: threadId }, cwd: params.cwd, model: params.model ?? defaultModel } });
  } else if (request.method === 'mcpServerStatus/list') {
    reply({ result: { data: [{ name: 'muster', runtimeStatus: 'connected', tools }] } });
  } else if (request.method === 'turn/start') {
    const model = params.model ?? defaultModel;
    fs.appendFileSync(process.env.TEST_CODEX_MODEL_LEDGER, JSON.stringify({ model, resume: resumed,
      effort: params.effort ?? null, explicitModel: params.model ?? null, cwd: params.cwd ?? process.cwd(),
      text: params.input?.find(item => item.type === 'text')?.text }) + '\n');
    const turnId = 'fixture-turn';
    reply({ result: { turn: { id: turnId } } });
    console.log(JSON.stringify({ method: 'item/completed', params: { threadId, turnId,
      item: { id: 'reply', type: 'agentMessage', text: 'model:' + model } } }));
    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }));
  } else {
    reply({ result: {} });
  }
});`);
  fs.copyFileSync(path.join(workspace, 'app-server'), path.join(secondary, 'app-server'));
  const ledger = path.join(cwd, 'models.jsonl');
  const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  for (const entry of registry.runtimes) {
    entry.enabled = entry.id === 'codex-gui' || entry.id === 'codex';
    entry.updatedAt = 1;
  }
  fs.mkdirSync(path.join(userData, 'agent-runtimes'));
  fs.writeFileSync(path.join(userData, 'agent-runtimes/registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'codex-test', defaultCwd: workspace,
    workspaces: [{ id: 'codex-test', name: 'Codex models', path: workspace, controlRoot: workspace, defaultRootId: 'main',
      roots: [{ id: 'main', path: workspace, label: 'Main source' }, { id: 'secondary', path: secondary }] }],
    worktreeStorageRoot: path.join(cwd, 'tasks'),
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd), CODEX_HOME: codexHome,
    USERPROFILE: profile, APPDATA: appData, LOCALAPPDATA: localAppData, HOME: profile,
    TEST_CODEX_MODEL_LEDGER: ledger, TEST_CODEX_DISCOVERY_LEDGER: discoveryLedger } as Record<string, string>;
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  const systemPaths = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')]
    : ['/usr/bin', '/bin'];
  const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
  const gitDirectory = (process.env.PATH ?? '').split(path.delimiter).map(dir => dir.replace(/^"(.*)"$/, '$1'))
    .find(dir => path.isAbsolute(dir) && fs.existsSync(path.join(dir, gitName)));
  if (!gitDirectory) throw new Error('Git is required for the isolated Codex child fixture');
  env.PATH = [bin, ...systemPaths, gitDirectory].join(path.delimiter);
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  const launch = () => _electron.launch({ executablePath: nodeRequire('electron'), args: [repoRoot], cwd, env, timeout: 60000 });
  const waitForBoot = async (instance: ElectronApplication) => {
    const output: string[] = [];
    const append = (chunk: unknown) => { output.push(String(chunk)); if (output.length > 24) output.shift(); };
    instance.process().stderr?.on('data', append);
    instance.process().stdout?.on('data', append);
    const page = await instance.firstWindow();
    const ready = await page.evaluate(() => window.api.app.bootWait()).catch(error => {
      throw new Error(`${String(error)}\n${output.join('')}`);
    });
    expect(ready.ok, `${ready.ok ? '' : ready.error}\n${output.join('')}`).toBe(true);
    await page.locator('.app-shell').waitFor({ timeout: 60000 });
    return page;
  };
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    const win = await waitForBoot(app);
    const availability = await win.evaluate(() => window.api.runtimes.availability(true));
    expect(availability.runtimePreflights?.['codex-gui']?.status).toBe('available');
    expect(availability.cliPrograms?.codex?.status).toBe('found');
    const terminal = await win.evaluate(() => window.api.runtimes.preflight('codex'));
    expect(terminal.results?.[0]).toMatchObject({ status: 'available', executable });
    const session = await win.evaluate(async () => {
      const s = await window.api.sessions.create({ runtime: 'codex-gui', name: 'Codex model acceptance' });
      await window.api.sessions.select(s.id); return s;
    });
    const composer = win.locator('.agent-chat-view').filter({ visible: true }).locator('.agent-composer');
    const trigger = composer.locator('.agent-composer-model-trigger');
    const menu = win.locator('.agent-composer-model-menu');
    const followEngineDefault = menu.getByRole('option', { name: '跟随引擎默认', exact: true });
    const cold = await win.evaluate(id => window.api.agentSession.listCodexModels(id, false), session.id);
    expect(cold.ok).toBe(false);
    expect(fs.existsSync(discoveryLedger)).toBe(false);
    await win.getByRole('button', { name: '设置', exact: true }).click();
    await win.getByRole('button', { name: 'Harness 接入', exact: true }).click();
    await win.getByTitle('重新检测本机并刷新模型目录').click();
    const refresh = win.getByRole('dialog', { name: '模型目录刷新' });
    await expect(refresh.getByText('已处理 2/2 项')).toBeVisible({ timeout: 20_000 });
    await expect(refresh.getByText('已读取 2 个模型', { exact: true })).toHaveCount(2);
    await expect(refresh.getByText('Main source')).toBeVisible();
    await expect(refresh.getByText('secondary', { exact: true })).toBeVisible();
    await expect(refresh.getByText(secondary, { exact: true })).toHaveCount(0);
    for (const [theme, width] of [['dark', 1280], ['light', 780]] as const) {
      await win.setViewportSize({ width, height: 900 });
      await win.evaluate(themeId => window.api.themes.activate(themeId), theme);
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(refresh.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
      const bounds = await refresh.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      await win.screenshot({ path: testInfo.outputPath(`harness-refresh-catalogs-${theme}-${width}.png`), animations: 'disabled' });
    }
    await refresh.getByRole('button', { name: '关闭', exact: true }).click();
    await win.getByRole('button', { name: /返回工作台/ }).click();
    await expect(trigger).toContainText('CLI Default');
    await expect.poll(() => fs.readFileSync(discoveryLedger, 'utf8')).toBe('list\nlist\n');
    await trigger.click();
    fs.writeFileSync(degradedCatalog, '');
    await menu.getByRole('button', { name: '刷新模型目录' }).click();
    await expect(menu.getByText(/已保留上次成功的目录/)).toBeVisible();
    await expect(menu.getByRole('radio', { name: 'high', exact: true })).toBeVisible();
    await menu.screenshot({ path: testInfo.outputPath('codex-catalog-retained-after-refresh.png'), animations: 'disabled' });
    fs.unlinkSync(degradedCatalog);
    await menu.getByRole('option', { name: 'Selected Codex', exact: true }).click();
    await menu.getByRole('radio', { name: 'low', exact: true }).click();
    await menu.getByRole('button', { name: '确认配置' }).click();
    await expect(trigger).toContainText('Selected Codex');
    await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.modelOverride?.modelId).toBe('chosen');
    await expect(composer.locator('.agent-thinking-chip')).toHaveCount(0);
    await expect(trigger).toHaveAttribute('title', /思考强度: low/);
    const sent = await win.evaluate(id => window.api.agentSession.send(id, 'Reply with the selected model'), session.id);
    expect(sent.ok, sent.error).toBe(true);
    await expect.poll(async () => {
      const history = await win.evaluate(id => window.api.agentSession.historyRange(id), session.id);
      const error = history?.messages.find(m => m.role === 'assistant' && m.error)?.error;
      return error || (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '');
    }).toContain('"model":"chosen"');
    expect(JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n')[0]).effort).toBe('low');
    await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.busy).toBe(false);
    await win.reload();
    await expect(trigger).toContainText('Selected Codex');
    await expect(trigger).toHaveAttribute('title', /思考强度: low/);
    for (const [theme, width] of [['dark', 1280], ['light', 1280], ['dark', 780], ['light', 780]] as const) {
      await win.setViewportSize({ width, height: 900 });
      await win.evaluate(themeId => window.api.themes.activate(themeId), theme);
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
      await trigger.click();
      await expect(followEngineDefault).toBeVisible();
      const bounds = await menu.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      await win.screenshot({ path: testInfo.outputPath('codex-model-menu-' + theme + '-' + width + '.png') });
      await trigger.click();
    }
    await trigger.click();
    await followEngineDefault.click();
    await menu.getByRole('button', { name: '确认配置' }).click();
    await expect(trigger).toContainText('CLI Default');
    await expect(trigger).toHaveAttribute('title', /思考强度: 默认/);
    const defaultSent = await win.evaluate(id => window.api.agentSession.send(id, 'Reply with the default model'), session.id);
    expect(defaultSent.ok, defaultSent.error).toBe(true);
    await expect.poll(() => fs.readFileSync(ledger, 'utf8')).toContain('"model":"cli-default","resume":true');
    expect(JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1)!)).toMatchObject({ effort: null, explicitModel: null });
    await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.busy).toBe(false);
    expect((await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.modelOverride).toBeFalsy();

    // A disabled configured default falls back to the first allowed catalog item,
    // and the next native turn receives the concrete model.
    await win.evaluate(() => window.api.agentSession.setHarnessModelSelection({ key: 'runtime:codex-gui', modelIds: ['chosen'] }));
    await expect(trigger).toContainText('Selected Codex');
    const fallbackSent = await win.evaluate(id => window.api.agentSession.send(id, 'Use an enabled model'), session.id);
    expect(fallbackSent.ok, fallbackSent.error).toBe(true);
    await expect.poll(() => fs.readFileSync(ledger, 'utf8').trim().split('\n').length).toBe(3);
    expect(JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1)!).model).toBe('chosen');
    await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.busy).toBe(false);
    const rejected = await win.evaluate(id => window.api.agentSession.setModel(id, { providerId: 'codex-gui', modelId: 'cli-default' }), session.id);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('该模型已在设置中禁用');
    expect(rejected.error).toContain('chosen');

    await win.evaluate(() => window.api.agentSession.setHarnessModelSelection({ key: 'runtime:codex-gui', modelIds: [] }));
    const emptyError = await win.evaluate(async () => {
      try { await window.api.sessions.create({ runtime: 'codex-gui', name: 'Empty selection' }); return ''; }
      catch (error) { return String(error); }
    });
    expect(emptyError).toContain('至少选择一个模型');

    // An existing saved override is checked again when a later turn reconnects.
    await win.evaluate(() => window.api.agentSession.setHarnessModelSelection({ key: 'runtime:codex-gui', modelIds: null }));
    expect((await win.evaluate(id => window.api.agentSession.setModel(id, { providerId: 'codex-gui', modelId: 'cli-default' }), session.id)).ok).toBe(true);
    await win.evaluate(() => window.api.agentSession.setHarnessModelSelection({ key: 'runtime:codex-gui', modelIds: ['chosen'] }));
    const oldOverrideSent = await win.evaluate(id => window.api.agentSession.send(id, 'Do not run the disabled old model'), session.id);
    expect(oldOverrideSent.ok).toBe(true);
    await expect.poll(async () => {
      const history = await win.evaluate(id => window.api.agentSession.historyRange(id), session.id);
      return history?.messages.filter(m => m.role === 'assistant').at(-1)?.error || '';
    }).toContain('该模型已在设置中禁用');
    expect(fs.readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(3);

    await app.evaluate(({ app }) => app.exit()).catch(() => {});
    await app.close().catch(() => {});
    app = await launch();
    const restarted = await waitForBoot(app);
    await expect.poll(async () => {
      try {
        const saved = await restarted.evaluate(id => window.api.agentSession.listCodexModels(id, false), session.id);
        return saved.ok ? saved.items.map(item => item.id) : saved.error;
      } catch (error) {
        if (!String(error).includes("No handler registered for 'codex:listModels'")) throw error;
        return String(error);
      }
    }, { timeout: 15_000 }).toEqual(['cli-default', 'chosen']);
    expect(fs.readFileSync(discoveryLedger, 'utf8')).toBe('list\nlist\nlist\n');

    await test.step('Core Worker creates an isolated Codex child with the selected model and effort', async () => {
      const git = (...args: string[]) => execFileSync(path.join(gitDirectory, gitName), [
        '-c', `core.hooksPath=${path.join(cwd, 'hooks')}`, '-c', 'commit.gpgsign=false',
        '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', ...args
      ], { cwd: workspace, stdio: 'pipe', windowsHide: true });
      git('init', '-b', 'main');
      git('add', 'app-server');
      git('commit', '-m', 'Codex app-server fixture');

      const task = 'Return the model selected for this child.';
      const model = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const last = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages.at(-1);
        let call: { id: string; name: string; args: object } | undefined;
        if (last?.role === 'user') {
          call = { id: 'lookup', name: 'host_workers_options', args: { mode: 'models', harnessId: 'codex', surface: 'gui',
            modelId: 'chosen', providerId: 'codex-gui', modelParameters: { reasoning: 'max' } } };
        } else if (last?.role === 'tool' && last.tool_call_id === 'lookup') {
          const targetRef = JSON.stringify(last.content).match(/wr1\.[A-Za-z0-9_-]{32}/)?.[0];
          if (targetRef) call = { id: 'delegate', name: 'host_sessions_create',
            args: { target: { targetRef }, task, isolation: 'isolated', asSubagent: true, select: false } };
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: object, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
          id: 'core-worker-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`);
        if (call) {
          chunk({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, null);
          chunk({}, 'tool_calls');
        } else {
          chunk({ content: 'Delegation fixture finished.' }, null);
          chunk({}, 'stop');
        }
        response.end('data: [DONE]\n\n');
      });
      try {
        await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
        const enabled = await restarted.evaluate(() => window.api.runtimes.update({ id: 'pi', enabled: true }));
        expect(enabled.ok, enabled.error).toBe(true);
        await restarted.evaluate(baseUrl => window.api.config.update({ openai: { baseUrl, apiKey: 'fixture-key', model: 'core-fixture' } }), baseUrl);
        const parent = await restarted.evaluate(() => window.api.sessions.create({ runtime: 'pi', workspaceId: 'codex-test',
          rootId: 'main', name: 'Core parent', configurePermissions: false }));
        const sent = await restarted.evaluate(id => window.api.agentSession.send(id, 'Delegate to the chosen Codex model.'), parent.id);
        expect(sent.ok, sent.error).toBe(true);
        const children = () => restarted.evaluate(async id => (await window.api.sessions.list()).sessions.filter(s => s.parentSessionId === id), parent.id);
        await expect.poll(async () => (await children()).length, { timeout: 25_000 }).toBe(1);
        const [child] = await children();
        expect(child).toMatchObject({ runtime: 'codex-gui', workspaceId: parent.workspaceId,
          modelOverride: { providerId: 'codex-gui', modelId: 'chosen' }, modelParameters: { reasoning: 'max' } });
        expect(child.worktreeGroups?.cwdPolicy).toBe('source');
        expect(child.cwd).toBe(parent.cwd);
        expect(child.worktreePath).toBeTruthy();
        await expect.poll(() => JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1)!), { timeout: 25_000 })
          .toMatchObject({ model: 'chosen', effort: 'max', cwd: child.worktreePath, text: expect.stringContaining(task) });
        const history = () => restarted.evaluate(id => window.api.agentSession.historyRange(id), child.id);
        await expect.poll(async () => JSON.stringify((await history())?.messages), { timeout: 15_000 }).toContain('model:chosen');
        expect((await history())?.messages.filter(message => message.role === 'user')).toHaveLength(1);
      } finally {
        model.closeAllConnections();
        await new Promise<void>(resolve => model.close(() => resolve()));
      }
    });

  } finally {
    const proc = app?.process();
    if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {});
    if (app) await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 8000))]);
    if (proc && proc.exitCode === null) proc.kill();
    if (proc && proc.exitCode === null) await new Promise<void>(resolve => proc.once('exit', () => resolve()));
    if (path.dirname(cwd) !== os.tmpdir() || !path.basename(cwd).startsWith('codex-menu-e2e-')) throw Error('Invalid fixture cleanup path');
    try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) {
      if (testInfo.status === 'passed') throw error;
      console.warn('Fixture cleanup failed after earlier test failure:', (error as Error).message);
    }
  }
});
