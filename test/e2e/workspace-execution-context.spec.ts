import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('真实 Pi 多根文件写入、只读源仓与回合目录依赖', async () => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'execution-context-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  const initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  const a = path.join(fixture, 'a'); const b = path.join(fixture, 'b');
  const outside = path.join(fixture, 'outside');
  for (const dir of [a, b, outside]) fs.mkdirSync(dir);
  // Owned source repository, used to exercise the production isolation pipeline.
  const git = (args: string[]) => execFileSync('git', args, { cwd: a, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Local fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(a, 'base.txt'), 'base'); git(['add', 'base.txt']); git(['commit', '-m', 'fixture']);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: initial }],
    worktreeStorageRoot: path.join(fixture, 'worktrees'),
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  let held: http.ServerResponse | undefined;
  const reply = (res: http.ServerResponse, tool?: { name: string; args: string }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
      id: 'execution-context', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }]
    })}\n\n`);
    if (tool) { chunk({ tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: tool.name, arguments: tool.args } }] }); chunk({}, 'tool_calls'); }
    else { chunk({ content: 'Local fixture completed.' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  };
  const model = http.createServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => {
      const payload = JSON.parse(body); const last = payload.messages?.at(-1) ?? {};
      const text = typeof last.content === 'string' ? last.content : (last.content ?? []).map((block: { text?: string }) => block.text ?? '').join('');
      if (last.role === 'user' && text.trim() === 'hold-directory-turn') { held = res; return; }
      const match = last.role === 'user' ? /(?:^|\n)tool:(\w+) (\{[^\n]*\})/.exec(text) : null;
      let tool = match ? { name: match[1], args: match[2] } : undefined;
      // GUI 委派任务沿邮箱投递：收信提醒→读信；任务信正文携带 tool: 指令→转成真实工具调用
      const prev = [...payload.messages].reverse().find((m: any) => m.tool_calls?.length)?.tool_calls?.[0]?.function;
      if (!tool && last.role === 'user' && text.includes('宿主收信提醒')) tool = { name: 'sessions_readMessages', args: '{}' };
      if (!tool && last.role === 'tool' && prev?.name === 'sessions_readMessages') {
        // Read the actual message body rather than matching escaped JSON plus later envelope fields.
        let envelope: { result?: { messages?: Array<{ text?: unknown }> } } = {};
        try { envelope = JSON.parse(text); } catch { /* Invalid fixture response produces no tool call. */ }
        const body = envelope.result?.messages?.find(message => typeof message.text === 'string' && message.text.startsWith('tool:'))?.text;
        const letter = typeof body === 'string' ? /^tool:(\w+) (\{[^\n]*\})$/.exec(body) : null;
        if (letter) { JSON.parse(letter[2]); tool = { name: letter[1], args: letter[2] }; }
      }
      reply(res, tool);
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `execution-context-${process.pid}`;
  env.MUSTER_WEB = '1'; env.MUSTER_WEB_PORT = '0'; env.MUSTER_WEB_HOST = '127.0.0.1';
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await win.evaluate(async baseUrl => (window as any).api.config.update({ openai: { baseUrl, apiKey: 'local-test', model: 'mock' } }), `http://127.0.0.1:${port}/v1`);
    const opened = await win.evaluate(async ({ a, b }) => (window as any).api.workspaces.open({ name: 'Execution roots',
      roots: [{ id: 'a', path: a }, { id: 'b', path: b }], defaultRootId: 'b', controlRootId: 'a' }), { a, b });
    expect(opened.ok, opened.message).toBe(true);
    const wsId = opened.activeWorkspaceId;
    const ordinary = await win.evaluate(async workspaceId => (window as any).api.sessions.create({ workspaceId, rootId: 'a', runtime: 'pi', force: true, name: 'Scope worker' }), wsId);
    await win.evaluate(async id => (window as any).api.agentSession.setMode(id, 'default'), ordinary.id);
    const history = (id: string) => win.evaluate(async id => (window as any).api.agentSession.historyRange(id), id);
    const sendTool = async (id: string, name: string, args: unknown) => {
      const before = (await history(id)).messages.filter((m: { role: string }) => m.role === 'assistant').length;
      await win.evaluate(async ({ id, text }) => (window as any).api.agentSession.send(id, text), { id, text: `tool:${name} ${JSON.stringify(args)}` });
      await expect.poll(async () => { const h = await history(id); return !h.busy && h.messages.filter((m: { role: string }) => m.role === 'assistant').length > before; }, { timeout: 30_000 }).toBe(true);
      return history(id);
    };
    await sendTool(ordinary.id, 'write', { path: path.join(b, 'second-root.txt'), content: 'second-root edit' });
    expect(fs.readFileSync(path.join(b, 'second-root.txt'), 'utf8')).toBe('second-root edit');
    const denied = await sendTool(ordinary.id, 'write', { path: path.join(outside, 'escape.txt'), content: 'must not write' });
    expect(fs.existsSync(path.join(outside, 'escape.txt'))).toBe(false);
    // R0 英文化：write 越界拒绝文案改为英文（directory scope）；注入段名走 i18n 保持中文
    expect(JSON.stringify(denied.messages)).toContain('directory scope');
    const contextSegment = denied.injections.at(-1).segments.find((segment: { source: string }) => segment.source === '工作区目录范围');
    expect(contextSegment.text).toContain(JSON.stringify(b)); expect(contextSegment.text).toContain(JSON.stringify(a));

    await win.evaluate(async id => (window as any).api.agentSession.send(id, 'hold-directory-turn'), ordinary.id);
    await expect.poll(() => !!held).toBe(true);
    const registered = await win.evaluate(async wsId => (await (window as any).api.workspaces.list()).workspaces.find((w: { id: string }) => w.id === wsId), wsId);
    const remove = () => win.evaluate(async ({ wsId, registered }) => (window as any).api.workspaces.update(wsId, {
      roots: registered.roots.filter((root: { id: string }) => root.id !== 'b'), defaultRootId: 'a', expectedRootsRevision: registered.rootsRevision
    }), { wsId, registered });
    const blocked = await remove(); expect(blocked.ok).toBe(false);
    expect(blocked.rootDependencies.some((dep: { rootId: string; kind: string }) => dep.rootId === 'b' && dep.kind === 'session')).toBe(true);
    reply(held!); held = undefined;
    await expect.poll(async () => (await history(ordinary.id)).busy).toBe(false);
    // The idle connection has no persistent reference to the second source root.
    const removed = await remove(); expect(removed.ok, removed.message).toBe(true);
    await sendTool(ordinary.id, 'write', { path: path.join(b, 'after-removal.txt'), content: 'must not write' });
    expect(fs.existsSync(path.join(b, 'after-removal.txt'))).toBe(false);
    expect((await history(ordinary.id)).injections.at(-1).segments.find((segment: { source: string }) => segment.source === '工作区目录范围').text).not.toContain(JSON.stringify(b));

    const delegated = await win.evaluate(async ({ workspaceId, task }) => (window as any).api.sessions.delegate({ workspaceId, rootId: 'a', runtime: 'pi', isolate: true,
      guiMode: 'auto', name: 'Isolated scope', task }), { workspaceId: wsId,
        task: `tool:write ${JSON.stringify({ path: path.join(a, 'source-must-stay.txt'), content: 'must not write source' })}` });
    expect(delegated.session, JSON.stringify(delegated)).toBeTruthy();
    const isolatedId = delegated.session.id;
    await expect.poll(async () => (await history(isolatedId))?.busy, { timeout: 30_000 }).toBe(false);
    expect(fs.existsSync(path.join(a, 'source-must-stay.txt'))).toBe(false);
    // R4 常驻扩容后 GUI Pi 首回合启动更慢：初始 busy=false 会先于回合开始——轮询转录而非即时断言；
    // R0 英文化：write 越界拒绝文案为 directory scope
    await expect.poll(async () => JSON.stringify((await history(isolatedId)).messages), { timeout: 30_000 }).toContain('directory scope');
    await sendTool(isolatedId, 'write', { path: path.join(delegated.session.worktreePath, 'isolated.txt'), content: 'task tree edit' });
    const isolated = (await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((session: { id: string }) => session.id === isolatedId);
    expect(isolated.worktreePath).toBeTruthy(); expect(isolated.cwd).toBe(a); expect(fs.readFileSync(path.join(isolated.worktreePath, 'isolated.txt'), 'utf8')).toBe('task tree edit');
    expect(fs.existsSync(path.join(a, 'isolated.txt'))).toBe(false);
  } finally {
    if (held && !held.destroyed) reply(held);
    await app.close().catch(() => {}); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  }
});
