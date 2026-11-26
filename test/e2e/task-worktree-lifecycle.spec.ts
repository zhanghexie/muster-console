import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('真实多组创建失败保留资源，重启续作移交与部分归档可恢复', async () => {
  test.setTimeout(240_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'task-lifecycle-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  const emptyGitConfig = path.join(fixture, 'empty.gitconfig'); fs.writeFileSync(emptyGitConfig, '');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && !entry[0].startsWith('GIT_'))), GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1',
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `task-lifecycle-${process.pid}`, APPDATA: path.join(fixture, 'appdata') };
  fs.mkdirSync(env.APPDATA, { recursive: true });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8' }).trim();
  const sources = ['a', 'b'].map(id => ({ id, path: path.join(fixture, 'sources', id), label: '同名根' }));
  for (const source of sources) for (const directory of [source.path, path.join(source.path, 'Plugins/Same')]) {
    fs.mkdirSync(directory, { recursive: true }); git(directory, 'init', '-b', 'main');
    git(directory, 'config', 'user.name', 'Fixture'); git(directory, 'config', 'user.email', 'fixture@test');
    git(directory, 'config', 'commit.gpgsign', 'false'); git(directory, 'config', 'core.hooksPath', path.join(fixture, 'hooks'));
    fs.writeFileSync(path.join(directory, '.gitignore'), '/Plugins/\n/.muster/\n/.agents/\n/AGENTS.md\n/CLAUDE.md\n');
    fs.writeFileSync(path.join(directory, 'same.txt'), 'base\n'); git(directory, 'add', '.'); git(directory, 'commit', '-m', 'base');
  }
  const workspace = { id: 'create', name: '多组创建', path: sources[1].path, controlRoot: sources[0].path,
    roots: sources, defaultRootId: 'b', rootsRevision: 0, openedAt: 0 };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: workspace.path, workspaces: [workspace],
    activeWorkspaceId: workspace.id, defaultRuntime: 'fixture-task', worktreeStorageRoot: path.join(fixture, 'managed tasks'),
    mcp: { enabled: false, servers: [] }, openai: { baseUrl: '', apiKey: '', model: '' } }));
  const trace = path.join(fixture, 'preparation.ndjson'), prepare = path.join(fixture, 'prepare.cjs'), launched = path.join(fixture, 'launched.json');
  fs.writeFileSync(prepare, `const fs=require('node:fs'),path=require('node:path');
const groups=JSON.parse(process.env.MUSTER_WORKTREE_GROUPS_JSON);
for(const group of groups) for(const relative of ['','Plugins/Same']) if(!fs.existsSync(path.join(group.worktreePath,relative,'.git'))) throw Error('incomplete task');
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({tag:process.argv[2],cwd:process.cwd(),groups,controlRoot:process.env.MUSTER_WORKSPACE_CONTROL_ROOT})+'\\n');`);
  const command = (tag: string) => `"${process.execPath}" "${prepare}" ${tag}`;
  const child = path.join(fixture, 'worker.cjs');
  fs.writeFileSync(child, `require('node:fs').writeFileSync(${JSON.stringify(launched)},JSON.stringify({cwd:process.cwd(),pid:process.pid}));process.stdin.resume();setInterval(()=>{},1000);`);
  const runtimeRoot = path.join(userData, 'agent-runtimes'); fs.mkdirSync(path.join(runtimeRoot, 'scripts'), { recursive: true });
  const builtin = path.join(project, 'src/main/runtime/builtins');
  fs.cpSync(path.join(builtin, 'scripts'), path.join(runtimeRoot, 'scripts'), { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(builtin, 'registry.json'), 'utf8'));
  for (const runtime of registry.runtimes) runtime.enabled = false;
  registry.runtimes.push({ id: 'fixture-task', label: 'Local task', script: 'fixture-task.mjs', enabled: true, surface: 'pty', updatedAt: 0 });
  fs.writeFileSync(path.join(runtimeRoot, 'registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(runtimeRoot, 'scripts/fixture-task.mjs'), `import{randomUUID}from'node:crypto';
export async function allocate(){return{sessionId:randomUUID()};}
export function resolveLaunch(){return{command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(child)}]};}`);
  const diagnostics: string[] = [], pids = new Set<number>();
  const artifacts = path.join(fixture, 'artifacts'); fs.mkdirSync(artifacts);
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let win!: Awaited<ReturnType<NonNullable<typeof app>['firstWindow']>>;
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
    app.process().stderr?.on('data', value => diagnostics.push(String(value)));
    win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
  };
  const stop = async () => {
    if (!app) return;
    // app.quit runs the production flush/PTY shutdown handlers; app.exit bypasses them.
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close(); app = undefined;
  };
  const key = (value: string) => fs.realpathSync(value).replace(/\\/g, '/').toLowerCase();
  const dead = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
  };
  const row = (id: string) => win.evaluate(async id => (await (window as any).api.sessions.list()).sessions.find((item: any) => item.id === id), id);
  const request = { name: '生命周期任务', runtime: 'fixture-task', workspaceId: workspace.id, rootId: 'b', rootsRevision: 0,
    cwd: path.join(sources[1].path, 'Plugins/Same'), isolate: true,
    isolationGroups: sources.map(source => ({ rootId: source.id, relativePath: '' })) };
  try {
    await launch();
    // Real Git post-checkout failure happens after the second group's checkout exists.
    // That failed creation has no verified ownership, so preserve it and report its location.
    const hooks = path.join(fixture, 'failing-hooks'); fs.mkdirSync(hooks);
    const marker = path.join(fixture, 'checkout-failed');
    fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\nprintf failed > '${marker.replace(/\\/g, '/')}'\nexit 1\n`);
    git(sources[1].path, 'config', 'core.hooksPath', hooks);
    const beforeRows = (await win.evaluate(() => (window as any).api.sessions.list())).sessions.map((item: any) => item.id);
    const failed = await win.evaluate(async request => {
      try { await (window as any).api.sessions.create(request); return ''; }
      catch (error) { return String(error); }
    }, request);
    expect(failed).toContain('隔离 worktree 创建失败'); expect(fs.existsSync(marker)).toBe(true);
    expect((await win.evaluate(() => (window as any).api.sessions.list())).sessions.map((item: any) => item.id)).toEqual(beforeRows);
    expect(fs.existsSync(launched)).toBe(false);
    for (const directory of [sources[0].path, path.join(sources[0].path, 'Plugins/Same'), path.join(sources[1].path, 'Plugins/Same')]) {
      expect(git(directory, 'branch', '--list', 'ao/*')).toBe('');
      expect(git(directory, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    }
    const residual = git(sources[1].path, 'worktree', 'list', '--porcelain').split('\n').find(line => line.startsWith('worktree ') && !line.endsWith(sources[1].path.replace(/\\/g, '/')))!;
    expect(residual).toBeTruthy(); const residualPath = residual.slice(9);
    expect(fs.existsSync(residualPath)).toBe(true); expect(failed.replace(/\\/g, '/').toLowerCase()).toContain(residualPath.replace(/\\/g, '/').toLowerCase());
    const residualBranch = git(residualPath, 'branch', '--show-current');
    // Explicit teardown of this known clean fixture resource only; production leaves it for the user.
    fs.unlinkSync(path.join(hooks, 'post-checkout'));
    git(sources[1].path, 'worktree', 'remove', residualPath); git(sources[1].path, 'branch', '-d', residualBranch);

    const created = await win.evaluate(async request => (window as any).api.sessions.create(request), request);
    expect(created.worktreeGroups.groups).toHaveLength(2);
    await expect.poll(() => fs.existsSync(launched)).toBe(true);
    const firstWorker = JSON.parse(fs.readFileSync(launched, 'utf8')); pids.add(firstWorker.pid);
    expect(key(firstWorker.cwd)).toBe(key(created.cwd));
    const state = created.worktreeGroups;
    const second = state.groups.find((group: any) => group.sourceRoot.rootId === 'b');
    const nested = path.join(second.path, 'Plugins/Same');
    fs.writeFileSync(path.join(nested, 'same.txt'), 'uncommitted second nested work\n');
    const heads = sources.flatMap(source => [source.path, path.join(source.path, 'Plugins/Same')]).map(source => ({ source, head: git(source, 'rev-parse', 'HEAD') }));
    await stop(); await expect.poll(() => dead(firstWorker.pid)).toBe(true);
    await launch();
    await expect.poll(async () => Boolean((await row(created.id))?.interruptSnapshot)).toBe(true);
    expect((await row(created.id)).worktreeGroups).toEqual(state);
    expect(fs.readFileSync(path.join(nested, 'same.txt'), 'utf8')).toBe('uncommitted second nested work\n');
    const continued = await win.evaluate(async id => (window as any).api.sessions.resumeInterrupted(id), created.id);
    expect(continued.session.worktreeGroups).toEqual(state);
    expect(key(continued.session.cwd)).toBe(key(nested));
    expect((await row(created.id)).worktreeGroups).toBeUndefined();
    expect((await row(created.id)).interruptSnapshot).toBeUndefined();
    await expect.poll(() => JSON.parse(fs.readFileSync(launched, 'utf8')).pid).not.toBe(firstWorker.pid);
    const nextWorker = JSON.parse(fs.readFileSync(launched, 'utf8')); pids.add(nextWorker.pid);
    expect(key(nextWorker.cwd)).toBe(key(nested));
    await win.evaluate(async id => (window as any).api.sessions.setArchived(id, true), created.id);
    for (const group of state.groups) expect(fs.existsSync(group.path)).toBe(true);

    const reviewed = await win.evaluate(async id => {
      try { await (window as any).api.sessions.review({ sessionId: id, decision: 'passed' }); return ''; }
      catch (error) { return String(error); }
    }, continued.session.id);
    expect(reviewed).toContain('b/Plugins/Same'); expect(reviewed).toContain('未提交');
    for (const source of heads) expect(git(source.source, 'rev-parse', 'HEAD')).toBe(source.head);
    await win.evaluate(async id => (window as any).api.sessions.setArchived(id, true), continued.session.id);
    await expect.poll(async () => (await row(continued.session.id))?.meta?.orphanWorktree, { timeout: 30_000 }).toBe('dirty');
    await expect.poll(() => dead(nextWorker.pid)).toBe(true);
    const first = state.groups.find((group: any) => group.sourceRoot.rootId === 'a');
    expect(fs.existsSync(first.path)).toBe(false);
    expect(fs.existsSync(second.path)).toBe(true);
    expect(fs.readFileSync(path.join(nested, 'same.txt'), 'utf8')).toBe('uncommitted second nested work\n');
    const retained = (await row(continued.session.id)).worktreeGroups;
    expect(retained.groups.find((group: any) => group.id === first.id).cleanup).toHaveLength(2);
    expect(retained.groups.find((group: any) => group.id === first.id).cleanup.every((item: any) => item.treeRemoved && item.branchRemoved)).toBe(true);
    expect(retained.groups.find((group: any) => group.id === second.id).cleanup.some((item: any) => item.status === 'retained')).toBe(true);
    await stop(); await launch();
    expect((await row(continued.session.id)).worktreeGroups).toEqual(retained);
    const respawned = await win.evaluate(async id => {
      try { await (window as any).api.sessions.respawn(id); return ''; }
      catch (error) { return String(error); }
    }, continued.session.id);
    expect(respawned).not.toBe(''); expect(dead(nextWorker.pid)).toBe(true);
    expect(fs.readFileSync(path.join(nested, 'same.txt'), 'utf8')).toBe('uncommitted second nested work\n');
    // Resolve only the fixture's unsaved edit, then retry the public archive path.
    fs.writeFileSync(path.join(nested, 'same.txt'), 'base\n');
    await win.evaluate(async id => (window as any).api.sessions.setArchived(id, true), continued.session.id);
    await expect.poll(async () => (await row(continued.session.id))?.worktreeGroups, { timeout: 30_000 }).toBeUndefined();
    for (const group of state.groups) expect(fs.existsSync(group.path)).toBe(false);
    for (const source of heads) {
      expect(git(source.source, 'rev-parse', 'HEAD')).toBe(source.head);
      expect(git(source.source, 'branch', '--list', 'ao/*')).toBe('');
      expect(git(source.source, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
      expect(fs.readFileSync(path.join(source.source, 'same.txt'), 'utf8')).toBe('base\n');
    }
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ fixture, createdId: created.id,
      continuedId: continued.session.id, failed, state, retained, pids: [...pids], respawned,
      shutdownDiagnostics: diagnostics.filter(value => value.includes('AttachConsole')) }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(artifacts, 'failure.json'), JSON.stringify({ fixture, diagnostics, error: String(error),
      sessions: app ? await win.evaluate(() => (window as any).api.sessions.list()).catch(String) : null }, null, 2));
    if (app) await win.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await stop().catch(() => {});
    for (const pid of pids) await expect.poll(() => dead(pid), { message: `fixture worker ${pid} must exit through production shutdown` }).toBe(true);
  }
});
