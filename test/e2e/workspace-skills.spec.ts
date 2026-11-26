import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

test('真实多根技能清单、菜单限定选择、GUI/Pi 注入与根移除', async () => {
  test.setTimeout(100_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'workspace-skills-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  const initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  const a = path.join(fixture, 'Alpha'); const b = path.join(fixture, 'Beta');
  for (const [dir, body] of [[a, 'BODY_FROM_ALPHA_SKILL'], [b, 'BODY_FROM_BETA_SKILL']]) {
    const skillDir = path.join(dir, '.agents/skills/fixture-review'); fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: fixture-review\ndescription: Local source review\n---\n\n${body}\n`);
  }
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: initial }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const model = http.createServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; }); req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'workspace-skills', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'Local skill completed.' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'workspace-skills', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `workspace-skills-${process.pid}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await win.evaluate(async baseUrl => (window as any).api.config.update({ openai: { baseUrl, apiKey: 'local-test', model: 'mock' } }), `http://127.0.0.1:${port}/v1`);
    const opened = await win.evaluate(async ({ a, b }) => (window as any).api.workspaces.open({ name: 'Skill sources',
      roots: [{ id: 'a', path: a, label: 'Alpha' }, { id: 'b', path: b, label: 'Beta' }], defaultRootId: 'a', controlRootId: 'a' }), { a, b });
    expect(opened.ok, opened.message).toBe(true); const wsId = opened.activeWorkspaceId;
    const listed = await win.evaluate(async wsId => (window as any).api.agent.listSkills(wsId), wsId);
    expect(listed.error).toBeFalsy();
    const collisions = listed.skills.filter((skill: { name: string }) => skill.name === 'fixture-review');
    expect(collisions.map((skill: { commandName: string }) => skill.commandName).sort()).toEqual(['root:a/fixture-review', 'root:b/fixture-review']);
    const ordinary = await win.evaluate(async workspaceId => {
      const session = await (window as any).api.sessions.create({ workspaceId, rootId: 'a', runtime: 'pi', force: true, name: 'Skill source worker' });
      await (window as any).api.sessions.select(session.id); return session;
    }, wsId);
    await win.locator('.chat-surface-view').waitFor();
    const editor = win.locator('.chat-surface-view').getByRole('textbox');
    const type = async (text: string) => { await editor.click(); await editor.press('Control+A'); await editor.press('Backspace'); await editor.pressSequentially(text); };
    const history = () => win.evaluate(async id => (window as any).api.agentSession.historyRange(id), ordinary.id);
    const waitTurn = async (before: number) => {
      await expect.poll(async () => { const h = await history(); return !h.busy && h.messages.filter((m: { role: string }) => m.role === 'assistant').length > before; }, { timeout: 30_000 }).toBe(true);
      expect(JSON.stringify((await history()).messages.at(-1))).not.toContain('error');
    };
    const send = async (text: string) => { const before = (await history()).messages.filter((m: { role: string }) => m.role === 'assistant').length;
      await type(text);
      if (text === '/skill:fixture-review') await expect(win.getByRole('option', { name: /fixture-review.*Alpha/ })).toBeVisible();
      // Sending a literal command must dismiss completion first: Enter in the open
      // menu intentionally selects a candidate rather than sending the text.
      await editor.press('Escape');
      await expect(win.locator('.chat-surface-view .agent-composer-menu')).toHaveCount(0);
      await expect(editor).toContainText(text); await editor.press('Enter'); await waitTurn(before); };
    const lastUser = () => JSON.stringify(requests.at(-1)!.messages.filter(message => message.role === 'user').at(-1));
    await send('/skill:fixture-review'); expect(lastUser()).toContain('请明确选择技能来源'); expect(lastUser()).not.toContain('BODY_FROM_');
    const shots = path.join(fixture, 'screenshots'); fs.mkdirSync(shots);
    for (const theme of ['dark', 'light']) {
      expect((await win.evaluate(async id => (window as any).api.themes.activate(id), theme)).ok).toBe(true);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      for (const width of [780, 390]) {
        await win.locator('.chat-surface-view').evaluate((node, width) => { (node as HTMLElement).style.flex = `0 0 ${width}px`; (node as HTMLElement).style.width = `${width}px`; }, width);
        await type('/skill:fixture-review');
        await expect(win.getByRole('option', { name: /fixture-review.*Alpha/ })).toBeVisible();
        await expect(win.getByRole('option', { name: /fixture-review.*Beta/ })).toBeVisible();
        await win.getByRole('listbox').screenshot({ path: path.join(shots, `${theme}-${width}.png`) });
        await editor.press('Escape');
      }
    }
    await type('/skill:fixture-review');
    const before = (await history()).messages.filter((m: { role: string }) => m.role === 'assistant').length;
    await win.getByRole('option', { name: /fixture-review.*Beta/ }).click();
    await expect(editor).toContainText('/skill:root:b/fixture-review'); await editor.press('Enter'); await waitTurn(before);
    expect(lastUser()).toContain('BODY_FROM_BETA_SKILL'); expect(lastUser()).not.toContain('BODY_FROM_ALPHA_SKILL');
    const system = JSON.stringify(requests.at(-1)!.messages.filter(message => message.role === 'system'));
    expect(system).toContain('root:a/fixture-review'); expect(system).toContain('root:b/fixture-review');
    const current = await win.evaluate(async wsId => (await (window as any).api.workspaces.list()).workspaces.find((workspace: { id: string }) => workspace.id === wsId), wsId);
    const changed = await win.evaluate(async ({ wsId, revision }) => (window as any).api.workspaces.update(wsId, { defaultRootId: 'b', expectedRootsRevision: revision }), { wsId, revision: current.rootsRevision });
    expect(changed.ok, changed.message).toBe(true);
    await send('Please use fixture-review'); expect(lastUser()).toContain('BODY_FROM_ALPHA_SKILL'); expect(lastUser()).not.toContain('BODY_FROM_BETA_SKILL');
    await type('/skill:fixture-review'); await expect(win.getByRole('option', { name: /fixture-review.*Beta/ })).toBeVisible();
    const updated = await win.evaluate(async wsId => (await (window as any).api.workspaces.list()).workspaces.find((workspace: { id: string }) => workspace.id === wsId), wsId);
    const removed = await win.evaluate(async ({ wsId, updated }) => (window as any).api.workspaces.update(wsId, { roots: updated.roots.filter((root: { id: string }) => root.id !== 'b'),
      defaultRootId: 'a', expectedRootsRevision: updated.rootsRevision }), { wsId, updated });
    expect(removed.ok, removed.message).toBe(true);
    await expect(win.getByRole('option', { name: /fixture-review.*Beta/ })).toHaveCount(0);
    await expect(win.getByRole('option', { name: /fixture-review.*Alpha/ })).toBeVisible();
    await send('/skill:root:b/fixture-review'); expect(lastUser()).toContain('技能来源已不可用'); expect(lastUser()).not.toContain('BODY_FROM_');
    console.log(`workspace skill screenshots: ${shots}`);
  } finally { await app.close().catch(() => {}); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
});
