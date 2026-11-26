import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('真实 Pi 跨组写入，回合中归档释放 SDK 和流连接，再逐组安全清理', async () => {
  test.setTimeout(150_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'task-gui-lifecycle-'));
  const userData = path.join(fixture, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  const configFile = path.join(fixture, 'gitconfig'); fs.writeFileSync(configFile, '');
  const recorder = path.join(fixture, 'record-dispose.cjs'), ready = path.join(fixture, 'recorder-ready');
  const entry = path.join(fixture, 'fixture-entry.cjs');
  const treeFile = path.join(fixture, 'owned-trees.json'), disposeFile = path.join(fixture, 'dispose.jsonl');
  const sdkUrl = pathToFileURL(fs.realpathSync(path.join(project, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'))).href;
  fs.writeFileSync(recorder, `if(process.versions.electron&&process.type==='browser'){
const fs=require('node:fs');
import(${JSON.stringify(sdkUrl)}).then(sdk=>{
 const original=sdk.AgentSession.prototype.dispose;
 sdk.AgentSession.prototype.dispose=function(...args){
  const trees=fs.existsSync(${JSON.stringify(treeFile)})?JSON.parse(fs.readFileSync(${JSON.stringify(treeFile)},'utf8')):[];
  fs.appendFileSync(${JSON.stringify(disposeFile)},JSON.stringify({cwd:this.sessionManager.getCwd(),at:Date.now(),treesExist:trees.map(tree=>fs.existsSync(tree))})+'\\n');
  return original.apply(this,args);
 };
 fs.writeFileSync(${JSON.stringify(ready)},'ready');
}).catch(error=>fs.writeFileSync(${JSON.stringify(ready)},String(error)));}
`);
  fs.writeFileSync(entry, `require('electron').app.setAppPath(${JSON.stringify(project)});
require(${JSON.stringify(path.join(project, 'out/main/index.js'))});
require(${JSON.stringify(recorder)});
`);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[name];
  Object.assign(env, { GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_NOSYSTEM: '1', MUSTER_SANDBOX: '1',
    MUSTER_INSTANCE_ID: `task-gui-${process.pid}`, MUSTER_WEB: '1', MUSTER_WEB_HOST: '127.0.0.1', MUSTER_WEB_PORT: '0' });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const roots = ['a', 'b'].map(id => ({ id, path: path.join(fixture, id) }));
  for (const root of roots) for (const relative of ['', 'Plugins/Same']) {
    const directory = path.join(root.path, relative); fs.mkdirSync(directory, { recursive: true });
    git(directory, 'init', '-q', '-b', 'main'); git(directory, 'config', 'user.name', 'Fixture');
    git(directory, 'config', 'user.email', 'fixture@example.invalid'); git(directory, 'config', 'commit.gpgsign', 'false');
    git(directory, 'config', 'core.hooksPath', path.join(fixture, 'no-hooks'));
    if (!relative) fs.writeFileSync(path.join(directory, '.gitignore'), 'Plugins/\n');
    fs.writeFileSync(path.join(directory, 'base.txt'), `${root.id}/${relative}\n`);
    git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'base');
  }
  const workspace = { id: 'gui-lifecycle', name: 'GUI lifecycle', path: roots[0].path, controlRoot: roots[0].path,
    roots, defaultRootId: 'a', rootsRevision: 0 };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: workspace.path,
    activeWorkspaceId: workspace.id, workspaces: [workspace], worktreeStorageRoot: path.join(fixture, 'managed'),
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  const sourceHeads = roots.flatMap(root => ['', 'Plugins/Same'].map(relative => ({ path: path.join(root.path, relative),
    head: git(path.join(root.path, relative), 'rev-parse', 'HEAD'),
    base: fs.readFileSync(path.join(root.path, relative, 'base.txt'), 'utf8') })));
  let held: http.ServerResponse | undefined; let heldClosedAt = 0; let requests = 0;
  const reply = (res: http.ServerResponse, tool?: { name: string; args: string }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
      id: 'gui-lifecycle', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }]
    })}\n\n`);
    if (tool) { chunk({ tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name: tool.name, arguments: tool.args } }] }); chunk({}, 'tool_calls'); }
    else { chunk({ content: 'Fixture completed.' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  };
  const model = http.createServer((req, res) => {
    let body = ''; req.on('data', part => { body += part; });
    req.on('end', () => {
      requests++; const last = JSON.parse(body).messages?.at(-1) ?? {};
      const text = typeof last.content === 'string' ? last.content : (last.content ?? []).map((part: { text?: string }) => part.text ?? '').join('');
      if (last.role === 'user' && text.includes('hold-gui-turn')) {
        held = res; res.on('close', () => { heldClosedAt = Date.now(); });
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); return;
      }
      const match = last.role === 'user' ? /(?:^|\n)tool:(\w+) (\{[^\n]*\})/.exec(text) : null;
      reply(res, match ? { name: match[1], args: match[2] } : undefined);
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const app = await _electron.launch({ executablePath: require('electron'), args: [entry, '--disable-gpu'], cwd: fixture, env });
  const diagnostics: string[] = []; app.process().stderr?.on('data', value => diagnostics.push(String(value)));
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await win.evaluate(async baseUrl => (window as any).api.config.update({ openai: { baseUrl, apiKey: 'fixture', model: 'mock' } }), `http://127.0.0.1:${port}/v1`);
    // Native startup recorder observes the real method, preserving its implementation.
    await expect.poll(() => fs.existsSync(ready), { timeout: 30_000 }).toBe(true);
    expect(fs.readFileSync(ready, 'utf8')).toBe('ready');
    const created = await win.evaluate(async request => (window as any).api.sessions.create(request), {
      name: 'GUI groups', runtime: 'pi', guiMode: 'auto', workspaceId: workspace.id, rootId: 'b', rootsRevision: 0,
      cwd: path.join(roots[1].path, 'Plugins/Same'), isolate: true,
      isolationGroups: roots.map(root => ({ rootId: root.id, relativePath: '' }))
    });
    const id = created.id;
    const row = () => win.evaluate(async id => (await (window as any).api.sessions.list()).sessions.find((item: any) => item.id === id), id);
    const initial = await row(); expect(initial.worktreeGroups.groups).toHaveLength(2);
    const a = initial.worktreeGroups.groups.find((group: any) => group.sourceRoot.rootId === 'a');
    const b = initial.worktreeGroups.groups.find((group: any) => group.sourceRoot.rootId === 'b');
    const members = initial.worktreeGroups.groups.flatMap((group: any) => [group.path, path.join(group.path, 'Plugins/Same')]);
    // Root-only isolation does not materialize ignored independent repositories.
    // Observe only manifest-owned trees during SDK release; keep all candidate
    // paths below for strict final cleanup, including the directory Pi writes.
    const ownedTrees = initial.worktreeGroups.groups.flatMap((group: any) => [group.path,
      ...group.repos.map((repo: { path: string }) => path.join(group.path, repo.path))]);
    expect(ownedTrees).toHaveLength(2);
    expect(ownedTrees.map((member: string) => fs.existsSync(member))).toEqual(ownedTrees.map(() => true));
    const initialMembersExist = members.map((member: string) => fs.existsSync(member));
    fs.writeFileSync(path.join(fixture, 'member-layout.json'), JSON.stringify({ members, initialMembersExist, worktreeGroups: initial.worktreeGroups }, null, 2));
    fs.writeFileSync(treeFile, JSON.stringify(ownedTrees));
    const history = () => win.evaluate(async id => (window as any).api.agentSession.historyRange(id), id);
    await expect.poll(async () => !!await history()).toBe(true);
    const write = async (file: string, content: string) => {
      const count = (await history()).messages.filter((message: any) => message.role === 'assistant').length;
      await win.evaluate(async ({ id, text }) => (window as any).api.agentSession.send(id, text), { id, text: `tool:write ${JSON.stringify({ path: file, content })}` });
      await expect.poll(async () => { const current = await history(); return !current.busy && current.messages.filter((message: any) => message.role === 'assistant').length > count; }, { timeout: 30_000 }).toBe(true);
    };
    // This root-only task does not clone the ignored independent repositories.
    // Write a visible root file so Git must retain B as dirty during the first archive.
    const aFile = path.join(a.path, 'gui-a.txt'), bFile = path.join(b.path, 'gui-b.txt');
    await write(aFile, 'GUI A\n'); await write(bFile, 'GUI B\n');
    expect(fs.readFileSync(aFile, 'utf8')).toBe('GUI A\n'); expect(fs.readFileSync(bFile, 'utf8')).toBe('GUI B\n');
    // The real bridge keeps repeat reads bounded while returning fresh metadata.
    await expect.poll(async () => (await history()).messages.every((message: any) => message.turnChanges?.state !== 'collecting'), { timeout: 30_000 }).toBe(true);
    const stableHistory = await history();
    expect(stableHistory.messages.length).toBeLessThanOrEqual(120);
    const repeated = await history();
    expect(repeated.messages.map((message: any) => message.id)).toEqual(stableHistory.messages.map((message: any) => message.id));
    expect(repeated.before).toBe(stableHistory.before);expect(repeated.total).toBe(stableHistory.total);
    expect(repeated.mode).toBe(stableHistory.mode);
    // Workspace initialization installs host instructions in its source control root.
    const sourceStates = sourceHeads.map(source => ({ ...source, status: git(source.path, 'status', '--porcelain'),
      index: fs.readFileSync(path.join(source.path, '.git/index')) }));
    for (const source of sourceStates) {
      expect(git(source.path, 'rev-parse', 'HEAD')).toBe(source.head);
      expect(fs.readFileSync(path.join(source.path, 'base.txt'), 'utf8')).toBe(source.base);
    }
    fs.unlinkSync(aFile); // Resolve only the known fixture edit so A is independently safe to remove.
    await win.evaluate(async id => (window as any).api.agentSession.send(id, 'hold-gui-turn'), id);
    await expect.poll(() => !!held).toBe(true); expect((await history()).busy).toBe(true);
    const changed = await history();
    expect(changed.total).toBeGreaterThan(stableHistory.total);
    expect(changed.messages.length).toBeLessThanOrEqual(120);
    expect(changed.busy).toBe(true);
    expect(ownedTrees.map((member: string) => fs.existsSync(member))).toEqual(ownedTrees.map(() => true));
    fs.writeFileSync(path.join(fixture, 'member-layout.json'), JSON.stringify({ members, initialMembersExist, beforeArchiveExist: members.map((member: string) => fs.existsSync(member)), worktreeGroups: (await row()).worktreeGroups }, null, 2));
    await win.evaluate(async id => (window as any).api.sessions.setArchived(id, true), id);
    await expect.poll(() => heldClosedAt > 0).toBe(true);
    await expect.poll(() => fs.existsSync(a.path), { timeout: 30_000 }).toBe(false);
    expect(fs.readFileSync(bFile, 'utf8')).toBe('GUI B\n'); expect((await row()).archived).toBe(true);
    const disposals = fs.readFileSync(disposeFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const key = (value: string) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
    const ownDisposals = disposals.filter((item: any) => key(item.cwd) === key(initial.cwd));
    expect(ownDisposals).toHaveLength(1); expect(ownDisposals[0].treesExist).toEqual(ownedTrees.map(() => true));
    expect((await history()).busy).toBe(false); expect((await history()).messages.length).toBeGreaterThan(0);
    const before = requests, beforeMessages = (await history()).messages.length;
    const refusal = await win.evaluate(async id => {
      try { return await (window as any).api.agentSession.send(id, 'must not reopen incomplete groups'); }
      catch (error) { return { ok: false, error: String(error) }; }
    }, id);
    expect(refusal.ok).toBe(false); expect(refusal.error).toBeTruthy(); expect(requests).toBe(before);
    expect((await history()).messages).toHaveLength(beforeMessages);
    for (const source of sourceHeads) expect(git(source.path, 'rev-parse', 'HEAD')).toBe(source.head);
    // Removing A's directory precedes the asynchronous cleanup's final ref checks.
    // The retained-tree result is published after its operation lease is released.
    await expect.poll(async () => (await row()).meta?.orphanWorktree, { timeout: 30_000 }).toBeTruthy();
    fs.unlinkSync(bFile);
    await win.evaluate(async id => (window as any).api.sessions.setArchived(id, true), id);
    await expect.poll(async () => (await row()).worktreeGroups, { timeout: 30_000 }).toBeUndefined();
    for (const member of members) expect(fs.existsSync(member)).toBe(false);
    for (const source of sourceStates) {
      expect(git(source.path, 'rev-parse', 'HEAD')).toBe(source.head);
      expect(git(source.path, 'branch', '--list', 'ao/*')).toBe('');
      expect(git(source.path, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
      expect(git(source.path, 'status', '--porcelain')).toBe(source.status);
      expect(fs.readFileSync(path.join(source.path, '.git/index'))).toEqual(source.index);
      expect(fs.readFileSync(path.join(source.path, 'base.txt'), 'utf8')).toBe(source.base);
    }
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify({ disposals: ownDisposals, heldClosedAt, members, diagnostics }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(fixture, 'failure.json'), JSON.stringify({ error: String(error), diagnostics, requests,
      heldClosedAt, recorderReady: fs.existsSync(ready) ? fs.readFileSync(ready, 'utf8') : null,
      disposals: fs.existsSync(disposeFile) ? fs.readFileSync(disposeFile, 'utf8') : '' }, null, 2));
    throw error;
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {}); await app.close().catch(() => {});
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  }
});
