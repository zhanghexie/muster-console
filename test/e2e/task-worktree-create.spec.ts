import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('准备命令设置与多仓选择经过真实创建、Review、全组合入和归档', async () => {
  test.setTimeout(150_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'task-create-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  const emptyGitConfig = path.join(fixture, 'empty.gitconfig'); fs.writeFileSync(emptyGitConfig, '');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && !entry[0].startsWith('GIT_'))), GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1',
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `task-create-${process.pid}`, APPDATA: path.join(fixture, 'appdata') };
  fs.mkdirSync(env.APPDATA, { recursive: true });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8' }).trim();
  const sources = ['a', 'b'].map(id => ({ id, path: path.join(fixture, 'sources', id), label: '同名根' }));
  const reference = path.join(sources[0].path, 'refs/Reference');
  for (const source of sources) for (const directory of [source.path, path.join(source.path, 'Plugins/Same'), ...(source.id === 'a' ? [reference] : [])]) {
    fs.mkdirSync(directory, { recursive: true }); git(directory, 'init', '-b', 'main');
    git(directory, 'config', 'user.name', 'Fixture'); git(directory, 'config', 'user.email', 'fixture@test');
    git(directory, 'config', 'commit.gpgsign', 'false'); git(directory, 'config', 'core.hooksPath', path.join(fixture, 'hooks'));
    fs.writeFileSync(path.join(directory, '.gitignore'), '/Plugins/\n/refs/\n/.muster/\n/.agents/\n/AGENTS.md\n/CLAUDE.md\n');
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
  for (const runtime of registry.runtimes) runtime.enabled = runtime.id === 'codex-gui';
  registry.runtimes.push({ id: 'fixture-task', label: 'Local task', script: 'fixture-task.mjs', enabled: true, surface: 'pty', updatedAt: 0 });
  fs.writeFileSync(path.join(runtimeRoot, 'registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(runtimeRoot, 'scripts/fixture-task.mjs'), `import{randomUUID}from'node:crypto';
export async function allocate(){return{sessionId:randomUUID()};}
export function resolveLaunch(){return{command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(child)}]};}`);
  const screenshots = path.join(project, '.tmp/ui-captures/task-worktree-create'); fs.mkdirSync(screenshots, { recursive: true });
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu', '--in-process-gpu', '--force-device-scale-factor=1'], cwd: fixture, env });
  const diagnostics: string[] = []; app.process().stderr?.on('data', value => { diagnostics.push(String(value)); if (diagnostics.length > 60) diagnostics.shift(); });
  const win = await app.firstWindow(); win.on('pageerror', error => diagnostics.push(error.message));
  const geometry: unknown[] = [];
  const resize = async (width: number): Promise<void> => {
    // Production minimum is 1100px; lower it only on this owned test window.
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(300, 640); window.setContentSize(width, 1000);
    }, width);
    await expect.poll(() => win.evaluate(() => innerWidth)).toBe(width);
  };
  try {
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    const codexPreflight = await win.evaluate(() => (window as any).api.runtimes.preflight('codex-gui'));
    fs.writeFileSync(path.join(screenshots, 'codex-preflight.json'), JSON.stringify(codexPreflight, null, 2));
    // 顶栏工作区菜单已撤（2026-10-10）：编辑工作区走左下工作区栈头像右键
    await win.locator('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-ws-stack-item.is-active .agent-float-avatar').click({ button: 'right' });
    await win.locator('#ctx-item-workspace-edit').click();
    const settings = win.getByRole('dialog', { name: '编辑工作区' });
    await settings.getByRole('button', { name: '更多设置' }).click();
    await settings.getByRole('button', { name: '隔离准备命令' }).click();
    await settings.getByRole('combobox', { name: '自动隔离排除仓库' }).click();
    await win.getByRole('option', { name: `同名根 / refs/Reference · ${reference}`, exact: true }).click();
    await settings.getByRole('button', { name: '添加排除仓库' }).click();
    await settings.getByRole('button', { name: '为 工作区 添加命令' }).click();
    await settings.getByRole('textbox', { name: '工作区：命令 1' }).fill(command('workspace'));
    await settings.getByRole('combobox', { name: '准备命令目标仓库' }).click();
    await win.getByRole('combobox', { name: '准备命令目标仓库' }).getByRole('option', { name: `同名根 / Plugins/Same · ${path.join(sources[1].path, 'Plugins/Same')}`, exact: true }).click();
    await settings.getByRole('button', { name: '添加仓库配置' }).click();
    await settings.getByRole('button', { name: '为 同名根 / Plugins/Same 添加命令' }).click();
    await settings.getByRole('textbox', { name: '同名根 / Plugins/Same：命令 1' }).fill(command('b-nested'));
    await settings.getByRole('combobox', { name: '准备命令目标仓库' }).click();
    await win.getByRole('combobox', { name: '准备命令目标仓库' }).getByRole('option', { name: `同名根 / refs/Reference · ${reference}`, exact: true }).click();
    await settings.getByRole('button', { name: '添加仓库配置' }).click();
    await settings.getByRole('button', { name: '为 同名根 / refs/Reference 添加命令' }).click();
    await settings.getByRole('textbox', { name: '同名根 / refs/Reference：命令 1' }).fill(command('reference-must-not-run'));
    for (const theme of ['dark', 'light']) for (const width of [1280, 780, 390]) {
      await win.evaluate(async theme => (window as any).api.themes.activate(theme), theme);
      await resize(width);
      await settings.getByText('自动隔离排除', { exact: true }).scrollIntoViewIfNeeded();
      await settings.screenshot({ path: path.join(screenshots, `exclusions-${theme}-${width}.png`), animations: 'disabled' });
      await settings.getByRole('button', { name: '保存准备命令' }).scrollIntoViewIfNeeded();
      await win.mouse.move(5, 5);
      await settings.screenshot({ path: path.join(screenshots, `settings-${theme}-${width}.png`), animations: 'disabled' });
      const bounds = await settings.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      geometry.push({ kind: 'settings', theme, width, bounds });
    }
    await resize(1280);
    await settings.getByRole('button', { name: '保存准备命令' }).click(); await settings.getByText('准备命令已保存，创建隔离任务时执行。').waitFor();
    expect(fs.existsSync(trace)).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(sources[0].path, '.muster/workspace.json'), 'utf8'));
    expect(saved.git.worktreeRepoProvisionCommands).toEqual([
      { rootId: 'b', relativePath: 'Plugins/Same', commands: [command('b-nested')] },
      { rootId: 'a', relativePath: 'refs/Reference', commands: [command('reference-must-not-run')] }
    ]);
    expect(saved.git.worktreeIsolationExclusions).toEqual([{ rootId: 'a', relativePath: 'refs/Reference' }]);
    expect(fs.existsSync(path.join(sources[1].path, '.muster/workspace.json'))).toBe(false);
    await settings.getByRole('button', { name: '取消', exact: true }).click(); await settings.waitFor({ state: 'hidden' });
    await win.getByText('工作会话', { exact: true }).hover();
    await win.getByTitle(/新建任务（先填任务再拉起会话）/).click(); const taskDialog = win.getByRole('dialog', { name: '新建任务' });
    await taskDialog.getByRole('button', { name: '运行方式', exact: true }).click();
    await win.getByRole('option', { name: 'Local task', exact: true }).click();
    const isolation = taskDialog.getByRole('checkbox', { name: '隔离运行' }); await isolation.check();
    await taskDialog.getByRole('button', { name: /全部仓库|已选 .* 个仓库/ }).click();
    // Explicitly select both parents and nested repositories; Reference stays shared.
    for (const checkbox of await taskDialog.locator('.worktree-selection-row input').all()) await checkbox.uncheck();
    for (const source of sources) await taskDialog.locator('.worktree-selection-row').filter({ has: win.locator('.worktree-selection-path', { hasText: source.path }) }).first().locator('input').check();
    for (const source of sources) await taskDialog.locator('.worktree-selection-row').filter({ has: win.locator('.worktree-selection-path', { hasText: path.join(source.path, 'Plugins/Same') }) }).locator('input').check();
    await expect(taskDialog.getByRole('button', { name: '任务运行仓库' })).toHaveCount(0);
    for (const theme of ['dark', 'light']) for (const width of [1280, 780, 390]) {
      await win.evaluate(async theme => (window as any).api.themes.activate(theme), theme);
      await resize(width);
      await win.mouse.move(5, 5);
      await taskDialog.screenshot({ path: path.join(screenshots, `selection-${theme}-${width}.png`), animations: 'disabled' });
      const bounds = await taskDialog.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      geometry.push({ kind: 'selection', theme, width, bounds });
    }
    await resize(1280);
    await taskDialog.getByRole('button', { name: '新建空白' }).click(); await taskDialog.waitFor({ state: 'hidden', timeout: 45_000 });
    const session = (await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((row: any) => row.worktreeGroups);
    expect(session.worktreeGroups.groups).toHaveLength(2);
    const first = session.worktreeGroups.groups.find((group: any) => group.sourceRoot.rootId === 'a');
    expect(first.repos.map((repo: any) => repo.path)).toEqual(['Plugins/Same']);
    expect(fs.existsSync(path.join(first.path, 'refs/Reference/.git'))).toBe(false);
    expect(git(reference, 'branch', '--list', first.branch)).toBe('');
    expect(git(reference, 'worktree', 'list', '--porcelain')).not.toContain(first.path.replace(/\\/g, '/'));
    const second = session.worktreeGroups.groups.find((group: any) => group.sourceRoot.rootId === 'b');
    const nested = path.join(second.path, 'Plugins/Same'); const key = (value: string) => fs.realpathSync(value).replace(/\\/g, '/').toLowerCase();
    expect(key(session.cwd)).toBe(key(sources[1].path)); await expect.poll(() => fs.existsSync(launched), { timeout: 20_000 }).toBe(true);
    expect(key(JSON.parse(fs.readFileSync(launched, 'utf8')).cwd)).toBe(key(sources[1].path));
    const preparations = fs.readFileSync(trace, 'utf8').trim().split('\n').map(value => JSON.parse(value));
    expect(preparations.map(row => row.tag)).toEqual(['workspace', 'b-nested']); expect(key(preparations[1].cwd)).toBe(key(nested));
    expect(preparations.every(row => row.groups.length === 2 && key(row.controlRoot) === key(sources[0].path))).toBe(true);
    fs.writeFileSync(path.join(nested, 'same.txt'), 'created task second nested\n');
    await win.evaluate(async id => (window as any).api.sessions.select(id), session.id);
    await win.keyboard.press('Escape'); await win.bringToFront();
    const gitPane = win.locator('.side-tools-panel.is-active');
    if (!await gitPane.isVisible()) await win.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    await gitPane.getByRole('tablist', { name: '资源面板' }).getByRole('tab', { name: 'Git', exact: true }).click();
    const tree = gitPane.getByRole('tree', { name: '仓库' });
    await tree.getByTitle(sources[1].path, { exact: true }).click();
    await gitPane.locator('.right-git-location').getByRole('combobox', { name: '切换 Worktree' }).click();
    const nestedLabel = `${path.basename(sources[1].path)}/Plugins/Same · ${second.repos.find((repo: { path: string }) => repo.path === 'Plugins/Same').branch}`;
    await win.getByRole('option', { name: nestedLabel, exact: true }).click();
    await expect(tree).toBeVisible();
    await expect(tree.getByTitle(nested, { exact: true })).toHaveCount(0);
    await win.locator('.git-panel').getByRole('button', { name: '部分采纳', exact: true }).click();
    await expect(win.getByText('created task second nested', { exact: true })).toBeVisible();
    const members = session.worktreeGroups.groups.flatMap((group: any) => [
      { tree: group.path, source: group.source.mainRepo, tag: `${group.sourceRoot.rootId}-main` },
      { tree: path.join(group.path, 'Plugins/Same'), source: path.join(group.source.mainRepo, 'Plugins/Same'), tag: `${group.sourceRoot.rootId}-nested` }
    ]);
    for (const member of members) {
      fs.writeFileSync(path.join(member.tree, 'same.txt'), member.tag + '\n'); git(member.tree, 'add', '.'); git(member.tree, 'commit', '-m', 'task changes');
      expect(fs.readFileSync(path.join(member.source, 'same.txt'), 'utf8')).toBe('base\n');
    }
    await win.evaluate(async id => (window as any).api.sessions.setPhase(id, { value: 'needs_you' }), session.id);
    const reviewed = await win.evaluate(async id => (window as any).api.sessions.review({ sessionId: id, decision: 'passed' }), session.id);
    expect(reviewed.merged, reviewed.message).toBe(true);
    for (const member of members) expect(fs.readFileSync(path.join(member.source, 'same.txt'), 'utf8')).toBe(member.tag + '\n');
    await win.evaluate(async id => (window as any).api.sessions.setArchived(id, true), session.id);
    await expect.poll(async () => (await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((row: any) => row.id === session.id)?.worktreeGroups,
      { timeout: 30_000 }).toBeUndefined();
    for (const member of members) { expect(fs.existsSync(member.tree)).toBe(false); expect(git(member.source, 'worktree', 'list', '--porcelain')).not.toContain(member.tree.replace(/\\/g, '/')); }
    const workerPid = JSON.parse(fs.readFileSync(launched, 'utf8')).pid;
    await expect.poll(() => {
      try { process.kill(workerPid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    }).toBe(true);
    fs.writeFileSync(path.join(screenshots, 'geometry.json'), JSON.stringify(geometry, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(screenshots, 'failure.json'), JSON.stringify({ fixture, diagnostics, body: await win.locator('body').innerText().catch(String) }, null, 2));
    await win.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {}); throw error;
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
});
