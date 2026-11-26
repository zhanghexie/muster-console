import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** Own app cwd and own local model endpoint; never reset a developer sandbox. */
test('第二根 GUI 会话通过真实 Pi 工具派后台终端，切区后仍继承来源', async () => {
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'background-source-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  const initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: initial }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] }, shell: { bgShellMode: process.platform === 'win32' ? 'powershell' : 'auto' } }));
  // Only model responses are controlled. Pi driver, host tools, manager, shell discovery and PTY are real.
  const toolSurfaces: Array<{ names: string[]; requested?: string; schema?: unknown }> = [];
  let toolContractError: string | undefined;
  const model = http.createServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const last = payload.messages?.at(-1) ?? {};
      const content = typeof last.content === 'string' ? last.content
        : (last.content ?? []).map((block: { text?: string }) => block.text ?? '').join('');
      const match = last.role === 'user' ? /(?:^|\n)tool:(\w+) (\{[^\n]*\})/.exec(content) : null;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
        id: 'background-source', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`);
      if (match) {
        const tools = (payload.tools ?? []).map((entry: { function?: { name?: string; parameters?: unknown }; name?: string; parameters?: unknown }) => entry.function ?? entry);
        const selected = tools.find((tool: { name?: string }) => tool.name === match[1]);
        toolSurfaces.push({ names: tools.map((tool: { name?: string }) => tool.name ?? ''), requested: match[1], schema: selected?.parameters });
        fs.writeFileSync(path.join(fixture, 'tool-surface.json'), JSON.stringify(toolSurfaces, null, 2));
        if (!selected) {
          toolContractError = `Requested tool ${match[1]} was not advertised. Available: ${toolSurfaces.at(-1)!.names.join(', ')}`;
          chunk({ content: toolContractError }); chunk({}, 'stop'); res.end('data: [DONE]\n\n'); return;
        }
        chunk({ tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: match[1], arguments: match[2] } }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ content: 'Local fixture completed.' }); chunk({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `background-source-${process.pid}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await win.evaluate(async baseUrl => window.api.config.update({
      llm: { activeProviderId: 'background-fixture', activeModelId: 'mock', providers: [{
        id: 'background-fixture', name: 'Background fixture', enabled: true, api: 'openai-completions',
        baseUrl, apiKey: 'local-test', models: [{ id: 'mock', name: 'Mock' }]
      }] }
    }), `http://127.0.0.1:${port}/v1`);
    const a = path.join(fixture, 'a'); const b = path.join(fixture, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
    const ws = await win.evaluate(async ({ a, b }) => (window as any).api.workspaces.open({ name: 'Background roots',
      roots: [{ id: 'a', path: a }, { id: 'b', path: b }], defaultRootId: 'a', controlRootId: 'a' }), { a, b });
    expect(ws.ok, ws.message).toBe(true);
    const session = await win.evaluate(async workspaceId => (window as any).api.sessions.create({
      workspaceId, rootId: 'b', runtime: 'pi', name: 'Background parent', force: true
    }), ws.activeWorkspaceId);
    await win.evaluate(async id => (window as any).api.agentSession.setMode(id, 'auto'), session.id);
    await win.evaluate(() => (window as any).api.workspaces.switch('demo-frontend'));
    const command = process.platform === 'win32' ? "[System.IO.File]::WriteAllText((Join-Path (Get-Location).Path 'background-cwd.txt'), (Get-Location).Path)" : 'pwd > background-cwd.txt';
    const sent = await win.evaluate(async ({ id, text }) => (window as any).api.agentSession.send(id, text), {
      id: session.id, text: `tool:host_bgtasks_shell ${JSON.stringify({ command })}`
    });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect(sent.queued, 'initial tool turn must start immediately').not.toBe(true);
    await expect.poll(() => toolSurfaces.length, { timeout: 15_000,
      message: `Tool registration evidence: ${path.join(fixture, 'tool-surface.json')}` }).toBeGreaterThan(0);
    expect(toolContractError, toolContractError).toBeUndefined();
    expect(toolSurfaces.at(-1)!.names).toContain('host_bgtasks_shell');
    const readHistory = () => win.evaluate(async id => (window as any).api.agentSession.historyRange(id), session.id);
    const toolDeadline = Date.now() + 15_000;
    let confirmedToolResult = false;
    let lastDiagnostics = '';
    while (Date.now() < toolDeadline) {
      const history = await readHistory();
      lastDiagnostics = JSON.stringify(history?.messages ?? []);
      if (/Tool host_bgtasks_shell not found|后台命令启动失败|后台命令清理失败|后台任务服务已停止/.test(lastDiagnostics)) throw new Error(lastDiagnostics);
      const tools = (history?.messages ?? []).flatMap((message: { parts?: Array<{ kind: string; tool?: { name: string; status: string; output?: string } }> }) => message.parts ?? [])
        .filter((part: { kind: string }) => part.kind === 'tool')
        .map((part: { tool?: { name: string; status: string; output?: string } }) => part.tool);
      const called = tools.find((tool: { name: string } | undefined) => tool?.name === 'host.bgtasks.shell' || tool?.name === 'host_bgtasks_shell');
      if (called?.status === 'error' || called?.status === 'cancelled') throw new Error(JSON.stringify(called));
      if (called?.status === 'ok' && typeof called.output === 'string') {
        const execution = JSON.parse(called.output);
        expect(execution.ok, called.output).toBe(true);
        confirmedToolResult = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(confirmedToolResult, lastDiagnostics).toBe(true);
    await expect.poll(() => {
      try { return fs.readFileSync(path.join(b, 'background-cwd.txt'), 'utf8').trim(); } catch { return ''; }
    }, { timeout: 10_000 }).toBe(b);
    expect(fs.existsSync(path.join(a, 'background-cwd.txt'))).toBe(false);
    const list = () => win.evaluate(async id => (window as any).api.bgTasks.list(id), session.id);
    await expect.poll(async () => (await list()).tasks.find((task: { kind: string }) => task.kind === 'shell')?.status).toBe('done');
    const shell = (await list()).tasks.find((task: { kind: string }) => task.kind === 'shell');
    expect(shell.workspaceId).toBe(ws.activeWorkspaceId); expect(shell.sourceRoot.rootId).toBe('b'); expect(shell.cwd).toBe(b);
    // 子代理（bgtasks.spawn）已于 2026-10-20 移除：改为带 parentSessionId 的普通会话，
    // 由 delegate/sessions.create 拉活，其来源继承回归见 test/launch-defaults.mjs
    // 与 docs/plans/subagent-generalization-plan.md §5.3（目录守卫重设计）。
    await win.evaluate(() => { void (window as any).api.app.quit(); }).catch(() => {});
    await app.close();
    const records = JSON.parse(fs.readFileSync(path.join(userData, 'bg-tasks.json'), 'utf8')).tasks;
    expect(records.find((task: { id: string }) => task.id === shell.id).sourceRoot.rootId).toBe('b');
    expect(records.find((task: { id: string }) => task.id === shell.id).cwd).toBe(b);
  } finally {
    await app.close().catch(() => {});
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  }
});
