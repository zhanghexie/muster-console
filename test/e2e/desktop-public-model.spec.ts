import { test, expect, _electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

test('调度和 GUI Worker 经公开工具读取桌面元数据', async ({}, info) => {
  test.setTimeout(120_000);
  const project = path.resolve(__dirname, '../..'), cwd = info.outputDir;
  const workspace = path.join(cwd, 'workspace'), userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  const results = new Map<string, { listed?: boolean; unsupported?: boolean; tools?: boolean; error?: string }>();
  const textOf = (message: any): string => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map((part: any) => part.text ?? '').join('');
  const deep = (value: any): any[] => {
    if (typeof value === 'string') { try { return deep(JSON.parse(value)); } catch { return []; } }
    return !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(deep)];
  };
  let sequence = 0;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body), messages = payload.messages ?? [], last = messages.at(-1);
      const userText = textOf([...messages].reverse().find((message: any) => message.role === 'user'));
      const marker = ['SCHEDULER_DESKTOP_PROBE', 'GUI_DESKTOP_PROBE'].find(value => userText.includes(value));
      let call: { name: string; args: unknown } | undefined;
      if (marker) {
        const state = results.get(marker) ?? {}; results.set(marker, state);
        const names = new Set((payload.tools ?? []).map((item: any) => item.function?.name));
        if (names.size) state.tools = names.has('host_desktop_list') && names.has('host_desktop_look');
        const previous = [...messages].reverse().find((message: any) => message.tool_calls?.length)?.tool_calls[0]?.function?.name;
        if (last?.role !== 'tool') call = { name: 'host_desktop_list', args: { limit: 2 } };
        else if (previous === 'host_desktop_list') {
          const rows = deep(textOf(last));
          state.listed = rows.some((item: any) => item.displays?.surfaces?.length > 0 && item.runtime);
          if (!state.listed) state.error = rows.find((item: any) => typeof item.error === 'string')?.error?.slice(0, 300) ?? 'list result missing';
          call = { name: 'host_desktop_look', args: { surfaceId: 'fixture' } };
        } else if (previous === 'host_desktop_look') {
          state.unsupported = deep(textOf(last)).some((item: any) => item.ok === false && item.code === 'capability_unsupported');
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: 'desktop-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (call) {
        chunk({ tool_calls: [{ index: 0, id: `desktop-${++sequence}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, null);
        chunk({}, 'tool_calls');
      } else { chunk({ content: 'Fixture complete.' }, null); chunk({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace, activeWorkspaceId: 'desktop-ws',
    workspaces: [{ id: 'desktop-ws', name: 'Desktop fixture', path: workspace }],
    openai: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture', model: 'fixture' },
    llm: { activeProviderId: 'fixture', activeModelId: 'fixture', providers: [{ id: 'fixture', name: 'Fixture', enabled: true,
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 128000, maxTokens: 4096 }] }] },
    mcp: { enabled: false, servers: [] }, webAccess: { enabled: false } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1',
    MUSTER_INSTANCE_ID: `desktop-model-${process.pid}`, MUSTER_WEB_PORT: '0' } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
  try {
    const page = await app.firstWindow(); await page.locator('.app-shell').waitFor({ timeout: 60_000 });
    const accepted = await page.evaluate(() => window.api.chat.send('SCHEDULER_DESKTOP_PROBE', 'desktop-ws'));
    expect(accepted.accepted, accepted.error).toBe(true);
    await expect.poll(() => results.get('SCHEDULER_DESKTOP_PROBE')?.unsupported, { timeout: 40_000 }).toBe(true);
    expect(results.get('SCHEDULER_DESKTOP_PROBE')).toMatchObject({ tools: true, listed: true, unsupported: true });
    await expect.poll(async () => (await page.evaluate(() => window.api.chat.state('desktop-ws'))).busy).toBe(false);
    const worker = await page.evaluate(async cwd => window.api.sessions.create({ cwd, workspaceId: 'desktop-ws', runtime: 'pi', name: 'Desktop GUI', force: true }), workspace);
    expect((await page.evaluate(id => window.api.agentSession.send(id, 'GUI_DESKTOP_PROBE'), worker.id)).ok).toBe(true);
    await expect.poll(() => results.get('GUI_DESKTOP_PROBE')?.unsupported, { timeout: 40_000 }).toBe(true);
    expect(results.get('GUI_DESKTOP_PROBE')).toMatchObject({ tools: true, listed: true, unsupported: true });
    const audit = new DatabaseSync(path.join(userData, 'desktop', 'audit.sqlite'), { readOnly: true });
    try {
      for (const owner of ['orchestrator:desktop-ws', worker.id]) {
        const hash = createHash('sha256').update(owner).digest('hex');
        const row = audit.prepare("SELECT action, result FROM desktop_audit WHERE session_hash = ? ORDER BY sequence DESC LIMIT 1").get(hash);
        expect(row).toMatchObject({ action: 'list', result: 'allowed' });
      }
    } finally { audit.close(); }
  } finally {
    const proc = app.process();
    if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* process already exited */ }
      } else proc.kill('SIGKILL');
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
