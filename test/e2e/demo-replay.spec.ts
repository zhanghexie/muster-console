import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

test('已有项目 → 调度建 Worker → 离线回放 → 还原基准 → 删 demo 保留原项目', async ({}, info) => {
  test.setTimeout(115_000);
  const project = path.resolve(__dirname, '../..'), base = info.outputPath('local');
  const existing = info.outputPath('existing-project');
  fs.mkdirSync(existing, { recursive: true });
  execFileSync('git', ['-C', existing, 'init', '-q']);
  fs.writeFileSync(path.join(existing, 'project.txt'), 'keep the existing project\n');
  execFileSync('git', ['-C', existing, 'add', '--', 'project.txt']);
  fs.writeFileSync(path.join(existing, 'untracked.txt'), 'keep untracked work\n');
  const projectGitStatus = () => execFileSync('git', ['-C', existing, 'status', '--porcelain=v1', '-uall'], { encoding: 'utf8' });
  const initialStatus = projectGitStatus();
  const name = '片头校对', reply = '分镜校对已经准备好了。';
  const delegate = '请把片尾交给子代理。', childTask = '检查片尾字幕，只回复检查结果。', childReply = '片尾字幕已核对。';
  const args = ['--demo-base', base, '--scene', '真实场景'];
  const bin = require('electron') as string;
  const cli = (mode: string, ...extra: string[]) => promisify(execFile)(bin, [project, mode, ...args, ...extra], { timeout: 15000 });
  let app: ElectronApplication | undefined;
  const server = http.createServer();
  let requests = 0, calls = 0;
  server.on('request', async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests++;
    const emit = (delta: unknown, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({
      id: 'demo-local', model: 'demo-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }]
    }) + '\n\n');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    emit({ role: 'assistant' });
    const last = body.messages.at(-1), lastUser = JSON.stringify(body.messages.findLast((m: { role: string }) => m.role === 'user')?.content);
    const delegateNow = last.role === 'user' && lastUser?.includes(delegate);
    if (last.role === 'user' && (delegateNow || calls === 0)) {
      calls++;
      const args = delegateNow ? { name: '片尾字幕', task: childTask, asSubagent: true, isolation: 'shared', select: false } : { name, isolation: 'shared', select: false };
      emit({ tool_calls: [{ index: 0, id: 'create_' + calls, type: 'function', function: { name: 'host_sessions_create', arguments: JSON.stringify(args) } }] });
      emit({}, 'tool_calls');
    } else {
      const answer = calls >= 2 ? childReply : reply;
      emit({ content: answer.slice(0, 4) }); emit({ content: answer.slice(4) }); emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  async function launch(mode: string, ...extra: string[]) {
    app = await _electron.launch({ executablePath: bin, args: [project, mode, ...args, ...extra,
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])], cwd: project });
    const page = await app.firstWindow();
    page.on('pageerror', error => console.error('demo page', error.message));
    return page;
  }
  async function close() { if (app) { await app.close(); app = undefined; } }
  try {
    const author = await launch('--demo-build', '--record');
    await expect(author.locator('.app-shell')).toBeVisible();
    expect(await author.evaluate(() => !!window.demoRecording)).toBe(true);
    const result = await author.evaluate(async ({ existing, url }) => {
      const api = window.api;
      await api.config.update({ locale: 'zh-CN', defaultRuntime: 'pi', themeId: 'light',
        openai: { baseUrl: url, apiKey: 'local-e2e-key', model: 'demo-test' },
        llm: { activeProviderId: 'demo-local', activeModelId: 'demo-test', providers: [{ id: 'demo-local', name: 'Local', enabled: true,
          api: 'openai-completions', baseUrl: url, apiKey: 'local-e2e-key', models: [{ id: 'demo-test', name: 'Demo' }] }] } });
      return api.workspaces.open({ name: '现有分镜项目', roots: [{ id: 'existing', path: existing }], defaultRootId: 'existing', controlRootId: 'existing' });
    }, { existing, url: 'http://127.0.0.1:' + address.port + '/v1' });
    expect(result.ok).toBe(true);
    const registered = result.workspaces!.find(w => w.id === result.activeWorkspaceId)!;
    expect(registered.path).toBe(existing);
    expect(registered.demoDataRoot).toContain(path.join('.muster-demo', 'scenes', '真实场景'));
    expect(fs.existsSync(path.join(existing, '.muster', 'manifest.json'))).toBe(false);
    const internal = await author.evaluate(folder => window.api.workspaces.open(folder), registered.demoDataRoot!);
    expect(internal.ok).toBe(false);
    expect(internal.message).toContain('演示数据目录以外');
    await author.locator('.agent-ws-stack-item.is-active .agent-notify-chat').first().click();
    const panel = author.locator('.agent-float-panel');
    await panel.locator('.composer-editable').fill('请创建一个分镜校对会话。');
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    await expect(panel.getByText(reply, { exact: true }).last()).toBeVisible({ timeout: 22000 });
    await expect.poll(() => author.evaluate(async name => (await window.api.sessions.list()).sessions.some(s => s.name === name), name)).toBe(true);
    await panel.getByRole('button', { name: /1 个工具调用/ }).click();
    await expect(panel.getByRole('button', { name: /1 个工具调用/ })).toHaveAttribute('aria-expanded', 'true');
    await author.screenshot({ path: info.outputPath('01-author.png') });
    await expect(cli('--demo-delete')).rejects.toThrow();
    // Leave a recording cue on screen long enough to inspect it in the replay.
    await author.waitForTimeout(1400);
    await author.locator('.agent-float-backdrop').click({ position: { x: 12, y: 30 } });
    const parent = await author.evaluate(async workspaceId => {
      const parent = await window.api.sessions.create({ workspaceId, rootId: 'existing', runtime: 'pi', name: '字幕编辑' });
      await window.api.agentSession.setMode(parent.id, 'auto');
      return parent.id;
    }, result.activeWorkspaceId);
    await author.locator('.session-item').filter({ hasText: '字幕编辑' }).first().click();
    const chat = author.locator('.agent-chat-view.is-shown');
    await chat.locator('.composer-editable').fill(delegate);
    await chat.getByRole('button', { name: '发送', exact: true }).click();
    const children = () => author.evaluate(async id => (await window.api.sessions.list()).sessions.filter(s => s.parentSessionId === id), parent);
    await expect.poll(async () => (await children()).length, { timeout: 18000 }).toBe(1);
    const child = (await children())[0];
    await expect.poll(() => author.evaluate(async ({ id, text }) => (await window.api.agentSession.historyRange(id))?.messages
      .some(m => m.role === 'assistant' && m.parts.some(p => p.kind === 'text' && p.text.includes(text))), { id: child.id, text: childReply }), { timeout: 18000 }).toBe(true);
    const childRow = author.locator('.session-item').filter({ hasText: child.name }).first();
    if (!await childRow.isVisible()) await author.getByTitle('折叠/展开子代理').first().click();
    await childRow.click();
    await expect(chat.getByText(childReply, { exact: true }).last()).toBeVisible();
    await author.screenshot({ path: info.outputPath('03-child-author.png') });
    await author.evaluate(() => {
      const surface = document.createElement('div');
      surface.id = 'demo-test-paint';
      Object.assign(surface.style, { position: 'fixed', right: '15px', top: '50px', zIndex: '30000' });
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 64;
      surface.append(canvas); document.body.append(surface);
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#20a080'; context.fillRect(0, 0, 128, 64);
    });
    const capturedSurface = author.locator('#demo-test-paint img');
    await expect(capturedSurface).toHaveAttribute('src', /^data:image\/png/);
    const capturedPng = await capturedSurface.evaluate((image: HTMLImageElement) => image.src);
    await author.evaluate(() => window.api.themes.activate('dark'));
    await expect(author.locator('html')).toHaveAttribute('data-theme', 'dark');
    await author.waitForTimeout(1600);
    await author.evaluate(() => window.api.themes.activate('light'));
    await expect(author.locator('html')).toHaveAttribute('data-theme', 'light');
    await close();
    const before = requests;
    const recorded = (await cli('--demo-run', '--list')).stdout;
    expect(recorded).toMatch(/\d{8}T\d{9}Z-/);
    const viewer = await launch('--demo-run', '--replay');
    const reconstruction = viewer.frameLocator('.replayer-wrapper > iframe');
    await expect(reconstruction.getByText(reply, { exact: true }).last()).toBeVisible({ timeout: 22000 });
    await expect(reconstruction.getByRole('button', { name: /1 个工具调用/ })).toHaveAttribute('aria-expanded', 'true');
    await viewer.keyboard.press('Space');
    await expect(reconstruction.locator('.session-item').filter({ hasText: name }).first()).toBeVisible();
    expect(await viewer.evaluate(() => typeof window.api)).toBe('undefined');
    expect(await viewer.locator('.replayer-wrapper > iframe').getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(requests).toBe(before);
    await viewer.screenshot({ path: info.outputPath('02-replay.png') });
    await viewer.keyboard.press('Space');
    await expect(reconstruction.locator('.session-item.active').filter({ hasText: child.name }).first()).toBeVisible({ timeout: 20000 });
    await expect(reconstruction.locator('.agent-chat-view.is-shown').getByText(childReply, { exact: true }).last()).toBeVisible();
    await viewer.screenshot({ path: info.outputPath('04-child-replay.png') });
    const sample = reconstruction.locator('#demo-test-paint img');
    await expect(sample).toBeVisible();
    // rrweb can display an inlined copy while retaining the original capture URL.
    await expect.poll(() => sample.evaluate((image: HTMLImageElement) =>
      image.getAttribute('rrweb-original-src') ?? image.src)).toBe(capturedPng);
    const rgb = await sample.evaluate(async (image: HTMLImageElement) => {
      await image.decode();
      const context = document.createElement('canvas').getContext('2d')!;
      context.drawImage(image, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
    // Display color conversion can round a channel by one.
    for (const [channel, expected] of [32, 160, 128].entries()) {
      expect(Math.abs(rgb[channel] - expected)).toBeLessThanOrEqual(1);
    }
    await expect(reconstruction.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 600));
    await expect.poll(() => viewer.locator('.replayer-wrapper > iframe').evaluate((frame: HTMLIFrameElement) => {
      const bounds = frame.getBoundingClientRect(), scale = Math.min(innerWidth / frame.offsetWidth, innerHeight / frame.offsetHeight);
      return innerWidth <= 900 && Math.abs(bounds.width - frame.offsetWidth * scale) < 1
        && bounds.left >= -1 && bounds.top >= -1 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1;
    })).toBe(true);
    await viewer.screenshot({ path: info.outputPath('05-replay-dark-narrow.png') });
    await expect(reconstruction.locator('html')).toHaveAttribute('data-theme', 'light');
    await viewer.keyboard.press('Home');
    await expect(reconstruction.getByText(reply, { exact: true })).toHaveCount(0);
    await expect(reconstruction.getByText(reply, { exact: true }).last()).toBeVisible({ timeout: 20000 });
    expect(requests).toBe(before);
    await close();
    const interactive = await launch('--demo-run');
    await expect(interactive.locator('.app-shell')).toBeVisible();
    expect(await interactive.evaluate(async () => (await window.api.workspaces.list()).workspaces.some(w => w.name === '现有分镜项目'))).toBe(true);
    await interactive.evaluate(() => window.api.config.update({ themeId: 'dark' }));
    await close();
    const restored = await launch('--demo-build');
    await expect(restored.locator('.app-shell')).toBeVisible();
    expect(await restored.evaluate(() => !!window.demoRecording)).toBe(false);
    expect(await restored.evaluate(async () => (await window.api.config.get()).themeId)).toBe('light');
    const material = await restored.evaluate(id => window.api.agentSession.replayMaterial(id), child.id);
    expect(material.messages.some(m => m.parts.some(p => p.kind === 'text' && p.text.includes(childReply)))).toBe(true);
    await close();
    expect((await cli('--demo-run', '--list')).stdout).toBe(recorded);
    await cli('--demo-delete');
    expect(fs.existsSync(path.join(base, '.muster-demo/scenes/真实场景'))).toBe(false);
    expect(fs.readFileSync(path.join(existing, 'project.txt'), 'utf8')).toBe('keep the existing project\n');
    expect(fs.readFileSync(path.join(existing, 'untracked.txt'), 'utf8')).toBe('keep untracked work\n');
    expect(fs.statSync(path.join(existing, '.git')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(existing, '.muster', 'manifest.json'))).toBe(false);
    expect(execFileSync('git', ['-C', existing, 'ls-files', '--', 'project.txt'], { encoding: 'utf8' }).trim()).toBe('project.txt');
    expect(projectGitStatus()).toBe(initialStatus);
  } finally {
    await close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('无 demo 参数仍使用原来的开发沙箱', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputPath('checkout'), home = info.outputPath('home');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const app = await _electron.launch({ executablePath: require('electron'), cwd,
    args: [project, '--user-data-dir=' + path.join(home, 'chromium'), ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])],
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, MUSTER_SANDBOX: '1', MUSTER_NO_SANDBOX: '0' } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.app-shell')).toBeVisible();
    const details = await page.evaluate(async () => ({
      info: await window.api.sandbox.getInfo(), canRecord: !!window.demoRecording,
      projects: (await window.api.workspaces.list()).workspaces.map(w => w.id)
    }));
    expect(details.info.enabled).toBe(true);
    expect(fs.realpathSync(details.info.rootDir!)).toBe(fs.realpathSync(path.join(cwd, '.dev-sandbox')));
    expect(details.projects).toEqual(expect.arrayContaining(['demo-playground', 'demo-frontend', 'demo-backend']));
    expect(details.canRecord).toBe(false);
  } finally { await app.close(); }
});

test('搭建和可交互 Demo 的首条命令能使用宿主工具并保留场景主目录', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const base = info.outputPath('local'), userHome = info.outputPath('desktop user'), tools = path.join(userHome, 'tools');
  const windows = process.platform === 'win32';
  fs.mkdirSync(tools, { recursive: true });
  const login = path.join(userHome, 'login-shell'), name = 'muster-fixture-command';
  fs.writeFileSync(login, '#!/bin/sh\nprintf "%s\\n" "$HOME" >> "$PATH_PROBE_LOG"\nprintf "%s" "$HOME/tools:$PATH"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, windows ? name + '.cmd' : name),
    windows ? '@echo off\r\necho %USERPROFILE%\r\n' : '#!/bin/sh\nprintf "%s\\n" "$HOME"\n', { mode: 0o755 });
  const log = info.outputPath('login-probes.txt');
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, SHELL: login, PATH_PROBE_LOG: log };
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const launchEnv = { ...env, [pathKey]: windows ? tools + path.delimiter + (process.env[pathKey] ?? '') : '/usr/bin:/bin' };
  const args = ['--demo-base', base, '--scene', '工具路径'];
  const bin = require('electron') as string;
  for (const mode of ['--demo-build', '--demo-run']) {
    const app = await _electron.launch({ executablePath: bin, cwd: project, env: launchEnv,
      args: [project, mode, ...args, ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])] });
    try {
      const page = await app.firstWindow();
      await expect(page.locator('.app-shell')).toBeVisible();
      const actual = await app.evaluate(({ app }, tool) => {
        const { execFileSync } = process.getBuiltinModule('child_process')!;
        const output = process.platform === 'win32'
          ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', tool], { encoding: 'utf8' })
          : execFileSync(tool, [], { encoding: 'utf8' });
        return { home: app.getPath('home'), commandHome: output.trim() };
      }, name);
      expect(actual.commandHome).toBe(actual.home);
      expect(path.relative(base, actual.home).split(path.sep)).toEqual(['.muster-demo', 'scenes', '工具路径', 'work', 'home']);
    } finally { await app.close(); }
  }
  await promisify(execFile)(bin, [project, '--demo-run', ...args, '--list'], { env: launchEnv, timeout: 15_000 });
  const probes = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  expect(probes).toEqual(windows ? [] : [userHome, userHome]);
});
