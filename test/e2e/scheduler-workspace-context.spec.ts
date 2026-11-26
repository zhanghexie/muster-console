import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

test('真实调度 Pi 的多根访问、忙时快照、默认切换与用户消息分叉冷启动', async () => {
  test.setTimeout(100_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'scheduler-context-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  const initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  const [a, b, c, outside] = ['a', 'b', 'c', 'outside'].map(name => path.join(fixture, name));
  for (const dir of [a, b, c, outside]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: initial }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  let held: http.ServerResponse | undefined;
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const reply = (res: http.ServerResponse, tool?: { name: string; args: string }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'scheduler-context',
      object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (tool) { chunk({ tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: tool.name, arguments: tool.args } }] }); chunk({}, 'tool_calls'); }
    else { chunk({ content: 'Local scheduler completed.' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  };
  const content = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(block => block.text ?? '').join('') : '';
  const model = http.createServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; }); req.on('end', () => {
      const payload = JSON.parse(body); requests.push(payload); const last = payload.messages?.at(-1) ?? {};
      const text = content(last.content);
      if (last.role === 'user' && text.trim().endsWith('hold-scheduler-roots')) { held = res; return; }
      const match = last.role === 'user' ? /(?:^|\n)tool:(\w+) (\{[^\n]*\})\s*$/.exec(text) : null;
      const advertised = match && payload.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === match[1]);
      reply(res, advertised ? { name: match![1], args: match![2] } : undefined);
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `scheduler-context-${process.pid}`;
  env.MUSTER_WEB = '1'; env.MUSTER_WEB_PORT = '0'; env.MUSTER_WEB_HOST = '127.0.0.1';
  if (process.env.MUSTER_E2E_SHUTDOWN_DIAGNOSTICS === '1') env.MUSTER_RUNTIME_DIAGNOSTICS = '1';
  let launchNumber = 0;
  const launch = async () => {
    const instance = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
    const log = path.join(fixture, `electron-${++launchNumber}.log`);
    instance.process().stdout?.on('data', chunk => fs.appendFileSync(log, chunk));
    instance.process().stderr?.on('data', chunk => fs.appendFileSync(log, chunk));
    instance.process().once('exit', (code, signal) => fs.appendFileSync(log, `\n[e2e] launcher exit ${code} ${signal}\n`));
    instance.process().once('close', (code, signal) => fs.appendFileSync(log, `\n[e2e] launcher close ${code} ${signal}\n`));
    return instance;
  };
  let app = await launch();
  const closingApps = new WeakSet<object>();
  const processSnapshot = () => process.platform === 'win32' ? JSON.parse(execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 })) as Array<{ ProcessId: number; ParentProcessId: number; Name: string }> : [];
  const close = async () => {
    if (closingApps.has(app)) return;
    closingApps.add(app);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (process.env.MUSTER_E2E_SHUTDOWN_DIAGNOSTICS === '1') {
      fs.writeFileSync(path.join(fixture, `processes-before-${launchNumber}.json`), JSON.stringify({
        pid: app.process().pid, mainPid: await app.evaluate(() => process.pid), processes: processSnapshot()
      }));
    }
    try {
      if (process.env.MUSTER_E2E_SHUTDOWN_DIAGNOSTICS === '1') await app.evaluate(({ app }) => {
        app.on('before-quit', event => console.info('[e2e] before-quit prevented:', event.defaultPrevented));
        app.on('will-quit', event => console.info('[e2e] will-quit prevented:', event.defaultPrevented));
      });
      await Promise.race([app.close(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Electron shutdown exceeded 20s; diagnostics: ${fixture}`)), 20_000);
      })]);
    } catch (error) {
      const child = app.process();
      console.error('[e2e] shutdown timeout', { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode });
      if (process.env.MUSTER_E2E_SHUTDOWN_DIAGNOSTICS === '1') fs.writeFileSync(path.join(fixture, `processes-after-${launchNumber}.json`), JSON.stringify(processSnapshot()));
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); }
          catch { child.kill('SIGKILL'); }
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    let win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await win.evaluate(async baseUrl => (window as any).api.config.update({ openai: { baseUrl, apiKey: 'local-test', model: 'mock' } }), `http://127.0.0.1:${port}/v1`);
    const opened = await win.evaluate(async ({ a, b, c }) => (window as any).api.workspaces.open({ name: 'Scheduler roots',
      roots: [{ id: 'a', path: a }, { id: 'b', path: b }, { id: 'c', path: c }], defaultRootId: 'b', controlRootId: 'a' }), { a, b, c });
    expect(opened.ok, opened.message).toBe(true); const wsId = opened.activeWorkspaceId;
    await win.evaluate(async wsId => (window as any).api.chat.setMode('default', wsId), wsId);
    const watchDone = () => win.evaluate(wsId => {
      (window as any).__schedulerDone = 0;
      (window as any).api.on('agent:done', (event: { workspaceId: string }) => {
        if (event.workspaceId === wsId) (window as any).__schedulerDone++;
      });
    }, wsId);
    await watchDone();
    const history = () => win.evaluate(async wsId => (window as any).api.chat.historyRange(wsId).then((page: { messages: unknown[] }) => page.messages), wsId);
    const send = async (text: string) => {
      const before = await win.evaluate(() => (window as any).__schedulerDone);
      const accepted = await win.evaluate(async ({ wsId, text }) => (window as any).api.chat.send(text, wsId), { wsId, text });
      expect(accepted.accepted, accepted.error).toBe(true);
      await expect.poll(() => win.evaluate(() => (window as any).__schedulerDone), { timeout: 30_000 }).toBeGreaterThan(before);
      expect((await history()).at(-1).error).toBeFalsy();
    };
    const write = (target: string, value: string) => send(`tool:write ${JSON.stringify({ path: target, content: value })}`);
    await write(path.join(a, 'second-root.txt'), 'second root'); expect(fs.readFileSync(path.join(a, 'second-root.txt'), 'utf8')).toBe('second root');
    await write(pathToFileURL(path.join(outside, 'uri-escape.txt')).href, 'denied');
    await write(`@${path.join(outside, 'at-escape.txt')}`, 'denied');
    expect(fs.existsSync(path.join(outside, 'uri-escape.txt'))).toBe(false); expect(fs.existsSync(path.join(outside, 'at-escape.txt'))).toBe(false);
    // R0 英文化：write 越界拒绝文案改为英文（directory scope）
    expect(JSON.stringify(await history())).toContain('directory scope');
    const status = await win.evaluate(async wsId => (window as any).api.chat.context(wsId), wsId);
    expect(status.injection.find((segment: { name: string }) => segment.name === 'workspace-context').bytes).toBeGreaterThan(0);
    await win.evaluate(async wsId => (window as any).api.chat.send('hold-scheduler-roots', wsId), wsId);
    await expect.poll(() => !!held).toBe(true);
    const registered = await win.evaluate(async wsId => (await (window as any).api.workspaces.list()).workspaces.find((w: { id: string }) => w.id === wsId), wsId);
    const remove = () => win.evaluate(async ({ wsId, registered }) => (window as any).api.workspaces.update(wsId, {
      roots: registered.roots.filter((root: { id: string }) => root.id !== 'c'), defaultRootId: 'a', expectedRootsRevision: registered.rootsRevision
    }), { wsId, registered });
    const blocked = await remove(); expect(blocked.ok).toBe(false);
    expect(blocked.rootDependencies.some((dep: { rootId: string; kind: string }) => dep.rootId === 'c' && dep.kind === 'launch')).toBe(true);
    const busyPreview = await win.evaluate(() => (window as any).api.capabilities.get());
    expect(busyPreview.dispatcher.fullPreview).toContain(JSON.stringify(c));
    const beforeHeldDone = await win.evaluate(() => (window as any).__schedulerDone);
    reply(held!); held = undefined;
    await expect.poll(() => win.evaluate(() => (window as any).__schedulerDone)).toBeGreaterThan(beforeHeldDone);
    const removed = await remove(); expect(removed.ok, removed.message).toBe(true);
    await write('relative-after-default.txt', 'pinned cwd');
    expect(fs.readFileSync(path.join(b, 'relative-after-default.txt'), 'utf8')).toBe('pinned cwd');
    expect(fs.existsSync(path.join(a, 'relative-after-default.txt'))).toBe(false);
    const request = requests.at(-2) ?? requests.at(-1)!;
    expect(JSON.stringify(request.messages)).toContain('second-root.txt');
    const preview = await win.evaluate(() => (window as any).api.capabilities.get());
    expect(preview.dispatcher.fullPreview).toContain(`"cwd": ${JSON.stringify(b)}`);
    expect(preview.dispatcher.fullPreview).not.toContain(JSON.stringify(c));
    await write(path.join(c, 'removed.txt'), 'denied'); expect(fs.existsSync(path.join(c, 'removed.txt'))).toBe(false);
    await close(); app = await launch(); win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await watchDone();
    await write('cold-resume.txt', 'cold pinned cwd');
    expect(fs.readFileSync(path.join(b, 'cold-resume.txt'), 'utf8')).toBe('cold pinned cwd');
    const coldRequest = requests.at(-2) ?? requests.at(-1)!;
    expect(JSON.stringify(coldRequest.messages)).toContain('relative-after-default.txt');
    // Cut at a user message: Pi normally defers persistence until an assistant appears.
    const firstUser = (await history()).find((message: { role: string; local?: boolean }) => message.role === 'user' && !message.local);
    const forked = await win.evaluate(async ({ id, wsId }) => (window as any).api.chat.fork(id, wsId), { id: firstUser.id, wsId });
    expect(forked.ok, forked.error).toBe(true);
    expect(fs.existsSync(forked.sessionFile)).toBe(true);
    const parentBytes = fs.readFileSync(forked.originalSessionFile);
    const forkEntries = fs.readFileSync(forked.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(forkEntries[0].cwd).toBe(b); expect(forkEntries[0].parentSession).toBe(forked.originalSessionFile);
    expect(forkEntries.filter(entry => entry.type === 'message').map(entry => entry.message.role)).toEqual(['user']);
    await close(); app = await launch(); win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await watchDone();
    await write('after-user-only-fork.txt', 'fork pinned cwd');
    expect(fs.readFileSync(path.join(b, 'after-user-only-fork.txt'), 'utf8')).toBe('fork pinned cwd');
    expect(fs.existsSync(path.join(a, 'after-user-only-fork.txt'))).toBe(false);
    expect(fs.readFileSync(forked.originalSessionFile)).toEqual(parentBytes);
    const forkRequest = requests.at(-2) ?? requests.at(-1)!;
    expect(JSON.stringify(forkRequest.messages)).toContain('second-root.txt');
    expect(JSON.stringify(forkRequest.messages)).not.toContain('relative-after-default.txt');
    // Exceed Pi's retained-history budget so this exercises compaction, not its small-session guard.
    await send(`Local compaction fixture history: ${'history context '.repeat(12_000)}`);
    await send('Finish the local compaction fixture history.');
    const compacted = await win.evaluate(async wsId => (window as any).api.chat.compact('Preserve the workspace directory facts.', wsId), wsId);
    expect(compacted.ok, compacted.error).toBe(true);
    await write('after-compact.txt', 'compact pinned cwd');
    expect(fs.readFileSync(path.join(b, 'after-compact.txt'), 'utf8')).toBe('compact pinned cwd');
  } finally {
    if (held && !held.destroyed) reply(held);
    try { if (app.process().exitCode === null) await close(); }
    finally { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
    if (process.env.MUSTER_E2E_SHUTDOWN_DIAGNOSTICS === '1') {
      console.info('scheduler shutdown resources', process.getActiveResourcesInfo());
    }
  }
});
