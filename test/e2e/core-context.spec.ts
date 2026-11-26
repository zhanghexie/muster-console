import { _electron, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

test('Core GUI sends a full tool result once and subsequently recovers it by its source ID', async ({}, info) => {
  const raw = 'ordinary output\n'.repeat(520) + 'WARNING E531\nunique record';
  const messages: Array<Array<{ role: string; content: string; tool_call_id?: string }>> = [];
  const server = http.createServer(async (req, res) => {
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    messages.push(JSON.parse(Buffer.concat(chunks).toString()).messages);
    const sourceId = messages.at(-1)?.find(m => m.role === 'tool')?.content.match(/^\[Core excerpt · source (\S+) ·/)?.[1];
    const tool = messages.length === 1 ? { name: 'read', arguments: '{"path":"fixture.log"}' } :
      messages.length === 3 ? { name: 'core_context', arguments: JSON.stringify({ action: 'read', id: sourceId, offset: raw.indexOf('WARNING') }) } : null;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + messages.length, type: 'function', function: tool }] } :
      { role: 'assistant', content: 'Done.' };
    const packet = (data: object, finish: string | null) => 'data: ' + JSON.stringify({ id: 'fixture', model: 'fixture',
      choices: [{ index: 0, delta: data, finish_reason: finish }] }) + '\n\n';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(packet(delta, null) + packet({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const workspace = path.join(info.outputDir, 'workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox', 'userData');
  const sessionId = randomUUID();
  let app;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'fixture.log'), raw);
    const baseUrl = 'http://127.0.0.1:' + (server.address() as {port: number}).port + '/v1';
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
      activeWorkspaceId: 'fixture', workspaces: [{ id: 'fixture', name: 'Fixture', path: workspace }], defaultCwd: workspace,
      llm: { activeProviderId: 'local', activeModelId: 'fixture', providers: [{ id: 'local', name: 'Local', enabled: true,
        api: 'openai-completions', baseUrl, apiKey: 'fixture', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 128000, maxTokens: 4096 }] }] }
    }));
    fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{ id: sessionId, type: 'terminal', launchKind: 'agent',
      runtime: 'pi', workspaceId: 'fixture', cwd: workspace, name: 'Fixture', createdAt: Date.now(), lifecycle: 'idle' }]));
    const env: NodeJS.ProcessEnv = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: sessionId };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.MUSTER_NO_SANDBOX;
    app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '../..'), '--disable-gpu'],
      cwd: info.outputDir, env: env as Record<string, string> });
    const page = await app.firstWindow();
    await page.locator('.app-shell').waitFor();
    await page.evaluate(id => window.api.sessions.select(id), sessionId);
    const submit = async (text: string) => {
      expect((await page.evaluate(({ id, text }) => window.api.agentSession.send(id, text), { id: sessionId, text })).ok).toBe(true);
      await expect.poll(() => page.evaluate(async id => (await window.api.agentSession.historyRange(id))?.busy, sessionId),
        { timeout: 45000 }).toBe(false);
    };
    await submit('Read the fixture.');
    expect(await page.evaluate(async id => (await window.api.agentSession.historyRange(id))?.usage?.contextWindow, sessionId)).toBe(128000);
    expect(messages[1]?.find(m => m.role === 'tool')?.content).toBe(raw);
    // Discover the ID from the actual next request, as the model would.
    await submit('Recover the warning.');
    const excerpt = messages[2]?.find(m => m.role === 'tool');
    expect(excerpt?.tool_call_id).toBe('call-1');
    expect(excerpt?.content).toContain('unique record');
    expect(JSON.parse(messages[3]!.filter(m => m.role === 'tool').at(-1)!.content).text).toBe('WARNING E531\nunique record');
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
