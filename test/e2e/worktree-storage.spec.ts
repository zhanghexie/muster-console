import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('首次在设置中打开默认 worktree 目录会创建并定位它', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const fixture = info.outputDir;
  const userData = path.join(fixture, '.dev-sandbox/userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', mcp: { enabled: false, servers: [] }, webAccess: { enabled: false }
  }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `default-worktrees-${process.pid}` };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  // Keep all three platforms' default worktree roots inside the fixture.
  if (process.platform === 'win32') env.LOCALAPPDATA = fixture;
  else if (process.platform === 'darwin') env.HOME = fixture;
  else env.XDG_DATA_HOME = fixture;

  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  try {
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      Object.assign(globalThis, { __openedWorktreeFolders: opened });
      shell.openPath = async target => { opened.push(target); return ''; };
    });
    const win = await app.firstWindow();
    await win.getByRole('button', { name: '设置', exact: true }).click();
    const input = win.getByRole('textbox', { name: 'worktree 存储目录' });
    const root = await input.inputValue();
    const dataRoot = process.platform === 'darwin' ? path.join(fixture, 'Library', 'Application Support') : fixture;
    expect(root).toBe(path.join(dataRoot, 'muster-console', 'worktrees'));
    expect(fs.existsSync(root)).toBe(false);

    const field = win.locator('[data-settings-item="worktree-storage"]');
    await field.getByRole('button', { name: '打开worktree 存储目录的位置' }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { __openedWorktreeFolders: string[] }).__openedWorktreeFolders)).toEqual([root]);
    expect(fs.statSync(root).isDirectory()).toBe(true);
    await expect(field.getByRole('alert')).toHaveCount(0);
    await field.screenshot({ path: info.outputPath('default-worktree-open.png') });
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});

// A separate cwd gives devSandbox its own directory, without resetting a running developer app.
test('外置存储与多根仓库列表经过真实 IPC 创建、定位并清理 worktree', async ({ page }) => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'worktree-e2e-'));
  const gitConfig = path.join(fixture, 'empty.gitconfig'); fs.writeFileSync(gitConfig, '');
  const userData = path.join(fixture, '.dev-sandbox/userData');
  const workspace = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: workspace }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  const runtimeRoot = path.join(userData, 'agent-runtimes');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const builtinRoot = path.join(project, 'src/main/runtime/builtins');
  fs.cpSync(path.join(builtinRoot, 'scripts'), path.join(runtimeRoot, 'scripts'), { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(builtinRoot, 'registry.json'), 'utf8'));
  registry.runtimes.push({ id: 'fixture-shell', label: 'Local fixture', script: 'fixture-shell.mjs', enabled: true, surface: 'pty', updatedAt: 0 });
  fs.writeFileSync(path.join(runtimeRoot, 'registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(runtimeRoot, 'scripts/fixture-shell.mjs'),
    `import { randomUUID } from 'node:crypto';\nexport async function allocate() { return { sessionId: randomUUID() }; }\n` +
    `export function resolveLaunch() { return { command: ${JSON.stringify(process.execPath)}, args: ['-e', "require('node:fs').writeFileSync('service-runtime-cwd.txt', process.cwd());"] }; }\n`);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[0].startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `worktree-${process.pid}`,
    MUSTER_WEB: '1', MUSTER_WEB_PORT: '0', MUSTER_WEB_HOST: '127.0.0.1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.MUSTER_NO_SANDBOX;
  delete env.MUSTER_DEVTOOLS_PORT;
  let app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    const storage = path.join(fixture, 'managed-worktrees');
    // 全局看板按钮复用 chrome-settings 类，按可访问名精确定位设置按钮
    await win.getByRole('button', { name: '设置', exact: true }).click();
    const input = win.getByRole('textbox', { name: 'worktree 存储目录' });
    await input.fill(storage);
    await win.getByRole('button', { name: /^保存/ }).click();
    await expect.poll(async () => (await win.evaluate(() => (window as any).api.config.get())).worktreeStorageRoot).toBe(storage);
    const ws = await win.evaluate(() => (window as any).api.workspaces.list());
    const repo = ws.workspaces.find((w: { id: string }) => w.id === 'demo-frontend').path;
    const built = await win.evaluate(async ({ repo }) => (window as any).api.git.worktreeAdd(repo, {
      dirName: 'external-task', newBranch: 'ao/storage-e2e', baseRef: 'main'
    }), { repo });
    expect(built.ok, built.message).toBe(true);
    expect(built.path.startsWith(storage + path.sep)).toBe(true);
    expect(built.source.mainRepo).toBe(repo);
    const list = await win.evaluate(async (p) => (window as any).api.git.listRepos(true, [p]), built.path);
    expect(list.find((r: { path: string }) => r.path === built.path)?.worktree).toBe(true);
    const locations = await win.evaluate(async p => (window as any).api.git.listRepoLocations(false, undefined, [p]), built.path);
    expect(locations.repos.find((r: { path: string }) => r.path === built.path)?.worktree).toBe(true);
    const status = await win.evaluate(async (p) => (window as any).api.git.status(p), built.path);
    expect(status.files).toEqual([]);
    const change = path.join(built.path, 'worktree-storage-check.txt');
    fs.writeFileSync(change, 'external worktree diff\n');
    const preview = await win.evaluate(async (p) => (window as any).api.git.adoptPreview(p), built.path);
    expect(preview.ok, preview.message).toBe(true);
    fs.unlinkSync(change);
    const removed = await win.evaluate(async (p) => (window as any).api.git.worktreeRemove(p), built.path);
    expect(removed.ok, removed.message).toBe(true);
    expect(fs.existsSync(built.path)).toBe(false);
    execFileSync('git', ['-C', repo, 'branch', '-d', 'ao/storage-e2e'], { windowsHide: true });

    // Default root is deliberately not a repository. The second source root must
    // still appear, and the panel must not silently select it on first load.
    // The third root models a source folder going offline later in this test.
    const nonGit = path.join(fixture, 'non-git-default'); fs.mkdirSync(nonGit);
    const unavailable = path.join(fixture, 'offline-source-root'); fs.mkdirSync(unavailable);
    const multi = await win.evaluate(async ({ nonGit, repo, unavailable }) => (window as any).api.workspaces.open({ name: '多根 Git',
      roots: [{ id: 'a', path: nonGit, label: '同名根' }, { id: 'b', path: repo, label: '同名根' }, { id: 'c', path: unavailable, label: '离线根' }],
      defaultRootId: 'a', controlRootId: 'a' }), { nonGit, repo, unavailable });
    expect(multi.ok, multi.message).toBe(true);
    const memberList = await win.evaluate(async (id) => (window as any).api.git.listRepos(false, [], id), multi.activeWorkspaceId);
    expect(memberList.find((r: { path: string }) => r.path === repo)?.rootId).toBe('b');
    const gateway = await win.evaluate(() => (window as any).api.webAccess.status());
    await page.goto(`http://127.0.0.1:${gateway.port}/?token=${encodeURIComponent(gateway.token)}`);
    await page.waitForFunction(() => Boolean((window as any).api));
    const webList = await page.evaluate(async (id) => (window as any).api.git.listRepos(false, [], id), multi.activeWorkspaceId);
    expect(webList.find((r: { path: string }) => r.path === repo)?.workspaceId).toBe(multi.activeWorkspaceId);
    const scope = { workspaceId: multi.activeWorkspaceId, rootsRevision: multi.workspaces.find((w: { id: string }) => w.id === multi.activeWorkspaceId).rootsRevision };
    const webStatus = await page.evaluate(async ({ scope, repo }) => (window as any).api.git.invokeScoped(scope, 'status', repo), { scope, repo });
    expect(webStatus.branch).toBe('main');

    // The visible refresh button must update the same topology snapshot that normal
    // list reads reuse. External init is intentionally invisible until manual refresh.
    const nested = path.join(repo, 'Plugins', 'ManualRefreshRepo');
    fs.appendFileSync(path.join(repo, '.gitignore'), '\nPlugins/\n');
    fs.mkdirSync(nested, { recursive: true });
    const runGit = (...args: string[]) => execFileSync('git', ['-C', nested, ...args], { windowsHide: true });
    runGit('init', '-q', '-b', 'main');
    runGit('config', 'user.name', 'E2E fixture');
    runGit('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(nested, 'a.txt'), 'fixture\n');
    runGit('add', '.');
    runGit('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const beforeRefresh = await win.evaluate(() => (window as any).api.git.listRepos(false));
    expect(beforeRefresh.some((r: { path: string }) => r.path === nested)).toBe(false);
    await win.keyboard.press('Escape');
    await win.bringToFront();
    // Ctrl+Backslash 已绑定 center.split，右侧栏改走右上角开关（恢复 Git 驻留）
    if (!(await win.locator('.side-tools-panel.is-active').isVisible().catch(() => false))) {
      await win.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    }
    await win.locator('.side-tools-panel.is-active').waitFor({ timeout: 15_000 });
    await win.locator('.side-tools-panel.is-active').getByRole('tab', { name: 'Git', exact: true }).first().click();
    const openList = win.getByRole('button', { name: '打开仓库列表', exact: true });
    if (await openList.isVisible().catch(() => false)) await openList.click();
    await expect(win.getByLabel(`同名根 ${nonGit}`, { exact: true })).toBeVisible();
    const source = win.getByLabel(`同名根 ${repo}`, { exact: true });
    await expect(source).toBeVisible();
    await source.click();
    await expect(win.locator('.git-branch-name').first()).toHaveText('main');
    const refresh = win.getByRole('button', { name: '刷新仓库列表', exact: true });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(refresh).toBeEnabled();
    const afterRefresh = await win.evaluate(() => (window as any).api.git.listRepos(false));
    expect(afterRefresh.some((r: { path: string }) => r.path === nested)).toBe(true);
    const refreshedLocations = await win.evaluate(() => (window as any).api.git.listRepoLocations(false));
    expect(refreshedLocations.repos.some((r: { path: string }) => r.path === nested)).toBe(true);
    // SplitPane permits a 140px repository pane. All toolbar controls remain
    // reachable at that actual minimum instead of overflowing after adding refresh.
    await win.locator('.git-repo-list').evaluate(element => {
      (element.closest('.split-pane-primary') as HTMLElement).style.cssText = 'width:140px;min-width:140px;max-width:140px;flex:0 0 140px';
      (element as HTMLElement).style.cssText = 'width:100%;min-width:0;flex:1';
    });
    const narrow = await win.locator('.git-repo-toolbar').evaluate(element => {
      const outer = element.getBoundingClientRect();
      return { overflow: element.scrollWidth > element.clientWidth,
        buttonsFit: [...element.querySelectorAll('button')].every(button => {
          const r = button.getBoundingClientRect();
          return r.left >= outer.left && r.right <= outer.right;
        }) };
    });
    expect(narrow).toEqual({ overflow: false, buttonsFit: true });
    const shots = path.join(project, '.tmp/ui-captures/workspace-git-roots'); fs.mkdirSync(shots, { recursive: true });
    for (const theme of ['dark', 'light']) {
      expect((await win.evaluate(async id => (window as any).api.themes.activate(id), theme)).ok).toBe(true);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      for (const width of [320, 140]) {
        await win.locator('.git-repo-list').evaluate(async (element, width) => {
          (element.closest('.split-pane-primary') as HTMLElement).style.cssText = `width:${width}px;min-width:${width}px;max-width:${width}px;flex:0 0 ${width}px`;
          (element as HTMLElement).style.cssText = 'width:100%;min-width:0;flex:1';
          element.querySelector('.git-repo-scroll')!.scrollTop = 0;
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }, width);
        await expect(source).toBeVisible();
        expect(await win.locator('.git-repo-scroll').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await expect(win.locator('.git-source-path')).toHaveCount(0);
        await win.mouse.move(0, 0);
        await expect(win.locator('.app-tooltip:visible')).toHaveCount(0);
        await win.locator('.git-repo-list').screenshot({ path: path.join(shots, `${theme}-${width}.png`) });
      }
    }
    // An unavailable registered scope must be visible without suppressing healthy
    // repositories. Removing the third source root's directory models a disk going
    // offline; the next forced rediscovery reports it without failing the rest.
    fs.rmSync(unavailable, { recursive: true, force: true });
    await refresh.click();
    const notice = win.locator('.git-discovery-notice');
    await expect(notice).toContainText('目录不存在或暂时离线');
    await expect(notice).toContainText(unavailable);
    await expect(win.locator('.git-branch-name').first()).toHaveText('main');
    const partial = await page.evaluate(async id => (window as any).api.git.listReposDetailed(false, [], id), multi.activeWorkspaceId);
    expect(partial.issueCount).toBe(1);
    expect(partial.repos.some((r: { path: string }) => r.path === repo)).toBe(true);
    expect(partial.issues[0].code).toBe('ENOENT');
    // Both native preload and Web transport expose the topology-only selector.
    const directoryChoices = await win.evaluate(async id => (window as any).api.git.listRepoLocations(false, id), multi.activeWorkspaceId);
    const webDirectoryChoices = await page.evaluate(async id => (window as any).api.git.listRepoLocations(false, id), multi.activeWorkspaceId);
    expect(webDirectoryChoices).toEqual(directoryChoices);
    expect(directoryChoices.workspaceId).toBe(multi.activeWorkspaceId);
    expect(directoryChoices.issueCount).toBe(1);
    expect(directoryChoices.repos.map((r: { path: string }) => r.path).sort()).toEqual(partial.repos.map((r: { path: string }) => r.path).sort());
    expect(directoryChoices.repos.every((r: object) => !('dirty' in r) && !('branch' in r))).toBe(true);
    const summaryScope = { workspaceId: directoryChoices.workspaceId, rootsRevision: directoryChoices.rootsRevision };
    const smallSummary = await win.evaluate(async ({ scope, repo }) => (window as any).api.git.invokeScoped(scope, 'repoSummaries', [repo]), { scope: summaryScope, repo });
    const webSmallSummary = await page.evaluate(async ({ scope, repo }) => (window as any).api.git.invokeScoped(scope, 'repoSummaries', [repo]), { scope: summaryScope, repo });
    expect(smallSummary.repos).toHaveLength(1); expect(smallSummary.repos[0].path).toBe(repo);
    expect(webSmallSummary.repos[0].path).toBe(repo); expect(webSmallSummary.repos[0].branch).toBe(smallSummary.repos[0].branch);
    for (const theme of ['dark', 'light']) {
      await win.evaluate(async id => (window as any).api.themes.activate(id), theme);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await notice.locator('p').first().click();
      await win.mouse.move(0, 0);
      await expect(win.locator('.app-tooltip:visible')).toHaveCount(0);
      await notice.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      // 右侧统一多标签下资源树与仓库内容各挂一个 .git-panel，按内容圈定截图目标
      await win.locator('.git-panel').filter({ has: win.locator('.git-discovery-notice') }).screenshot({ path: path.join(shots, `${theme}-failure.png`) });
      await notice.evaluate(element => { (element as HTMLElement).style.maxWidth = '390px'; });
      expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await notice.screenshot({ path: path.join(shots, `${theme}-failure-390.png`) });
      await notice.evaluate(element => { (element as HTMLElement).style.maxWidth = ''; });
    }
    fs.mkdirSync(unavailable);
    execFileSync('git', ['-C', unavailable, 'init', '-q', '-b', 'main'], { windowsHide: true });
    const retry = notice.getByRole('button', { name: '重试扫描' }); await retry.click();
    await expect(notice).toHaveCount(0);
    const recovered = await page.evaluate(async id => (window as any).api.git.listReposDetailed(false, [], id), multi.activeWorkspaceId);
    expect(recovered.issueCount).toBe(0);
    expect(recovered.repos.some((r: { path: string }) => r.path === unavailable)).toBe(true);

    // Actual panel staging/commit crosses the scoped IPC, with its status refresh.
    fs.writeFileSync(path.join(repo, 'scoped-write-check.txt'), 'scoped UI write\n');
    await win.locator('.git-panel').filter({ has: win.getByRole('button', { name: 'Stage All', exact: true }) })
      .getByRole('button', { name: 'Stage All', exact: true }).click();
    await expect(win.locator('.git-changes-section').filter({ hasText: 'Staged' })).toContainText('scoped-write-check.txt');
    await win.locator('.git-commit-input').fill('scoped UI commit');
    await win.locator('.git-commit-bar').getByRole('button', { name: 'Commit', exact: true }).click();
    await expect.poll(() => execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s'], { windowsHide: true, encoding: 'utf8' }).trim()).toBe('scoped UI commit');

    // This source-root repo belongs only to the multi workspace, even after caching.
    const externalStatus = await page.evaluate(async ({ scope, unavailable }) => (window as any).api.git.invokeScoped(scope, 'status', unavailable), { scope, unavailable });
    expect(externalStatus.branch).toBe('main');
    const wrongScope = { workspaceId: 'demo-frontend', rootsRevision: ws.workspaces.find((w: { id: string }) => w.id === 'demo-frontend').rootsRevision };
    const wrongWrite = await page.evaluate(async ({ wrongScope, unavailable }) => {
      try { await (window as any).api.git.invokeScoped(wrongScope, 'checkout', unavailable, { name: 'wrong-scope', create: true }); return ''; }
      catch (error) { return String(error); }
    }, { wrongScope, unavailable });
    expect(wrongWrite).toMatch(/未知仓库|Unknown repository/);
    expect(execFileSync('git', ['-C', unavailable, 'branch', '--list', 'wrong-scope'], { windowsHide: true, encoding: 'utf8' }).trim()).toBe('');

    // Create on the second root through actual IPC; default changes do not move it.
    const second = await win.evaluate(async ({ workspaceId, revision }) => (window as any).api.sessions.create({
      workspaceId, rootId: 'b', rootsRevision: revision, runtime: 'pi', force: true, name: '第二根会话'
    }), { workspaceId: multi.activeWorkspaceId, revision: scope.rootsRevision });
    expect(second.cwd).toBe(repo);
    expect(second.sourceRoot.rootId).toBe('b');
    await expect.poll(async () => (await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((s: { id: string }) => s.id === second.id)?.status).toBe('running');
    const changed = await win.evaluate(async ({ id, revision }) => (window as any).api.workspaces.update(id, { defaultRootId: 'b', expectedRootsRevision: revision }), { id: multi.activeWorkspaceId, revision: scope.rootsRevision });
    expect(changed.ok, changed.message).toBe(true);
    const current = await win.evaluate(async () => (window as any).api.config.get());
    const revised = current.workspaces.find((w: { id: string }) => w.id === multi.activeWorkspaceId).rootsRevision;
    const ordinary = await win.evaluate(async workspaceId => (window as any).api.sessions.create({ workspaceId, runtime: 'pi', force: true }), multi.activeWorkspaceId);
    expect(ordinary.cwd).toBe(repo); expect(ordinary.sourceRoot.rootId).toBe('b');
    const invalid = await page.evaluate(async workspaceId => {
      try { await (window as any).api.sessions.create({ workspaceId, rootId: 'gone', runtime: 'pi', force: true }); return ''; }
      catch (error) { return String(error); }
    }, multi.activeWorkspaceId);
    expect(invalid).toContain('source folder not found');
    const taskTree = await win.evaluate(async ({ workspaceId, revision }) => (window as any).api.sessions.create({
      workspaceId, rootId: 'b', rootsRevision: revision, isolate: true, runtime: 'pi', force: true, name: '第二根隔离会话'
    }), { workspaceId: multi.activeWorkspaceId, revision: revised });
    expect(taskTree.worktreePath.startsWith(storage + path.sep)).toBe(true);
    expect(taskTree.sourceRoot.path).toBe(repo);
    expect(taskTree.sourceRoot.cwd).toBe(repo);
    expect(taskTree.worktreeSource.mainRepo).toBe(repo);
    await expect.poll(async () => (await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((s: { id: string }) => s.id === taskTree.id)?.status).toBe('running');
    const sameTree = await win.evaluate(async source => (window as any).api.sessions.create({
      workspaceId: source.workspaceId, cwd: source.cwd, runtime: 'pi', force: true, name: '隔离目录续会话'
    }), taskTree);
    expect(sameTree.sourceRoot.rootId).toBe('b');
    expect(sameTree.worktreePath).toBeUndefined();
    await expect.poll(async () => (await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((s: { id: string }) => s.id === sameTree.id)?.status).toBe('running');
    expect((await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((s: { id: string }) => s.id === second.id).cwd).toBe(repo);
    const backToFirst = await win.evaluate(async ({ id, revision }) => (window as any).api.workspaces.update(id, { defaultRootId: 'a', expectedRootsRevision: revision }), { id: multi.activeWorkspaceId, revision: revised });
    expect(backToFirst.ok, backToFirst.message).toBe(true);
    // Actual desktop task dialog selects the source for an empty GUI session.
    await win.bringToFront();
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await win.keyboard.press('Control+Shift+N');
    const taskDialog = win.getByRole('dialog', { name: '新建任务' });
    await taskDialog.getByRole('combobox', { name: '运行位置', exact: true }).click();
    await win.getByRole('option', { name: repo, exact: true }).click();
    const pi = (await win.evaluate(() => (window as any).api.runtimes.list())).find((r: { id: string }) => r.id === 'pi');
    await taskDialog.getByRole('button', { name: '运行方式', exact: true }).click();
    await win.getByRole('option', { name: `${pi.label}（GUI）`, exact: true }).click();
    await taskDialog.getByRole('textbox', { name: /会话名称/ }).fill('选目录窗口创建');
    await taskDialog.getByRole('button', { name: '新建空白', exact: true }).click();
    await expect(taskDialog).toHaveCount(0);
    const uiSession = (await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((s: { name: string }) => s.name === '选目录窗口创建');
    expect(uiSession.workspaceId).toBe(multi.activeWorkspaceId);
    expect(uiSession.sourceRoot.rootId).toBe('b'); expect(uiSession.cwd).toBe(repo);
    const staleCheck = await page.evaluate(async ({ id, revision }) => {
      try { await (window as any).api.sessions.precheck(id, 'b', revision); return ''; }
      catch (error) { return String(error); }
    }, { id: multi.activeWorkspaceId, revision: revised });
    expect(staleCheck).toContain('changed');
    // Mobile uses the viewed workspace even if another client switches the active one.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => sessionStorage.setItem('muster.mobile.force', '1'));
    await page.reload();
    await page.locator('.ma-ws-card').filter({ hasText: '多根 Git' }).click();
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: '新建会话' });
    await sheet.getByRole('combobox', { name: '运行位置', exact: true }).click();
    await page.getByRole('option', { name: repo, exact: true }).click();
    const beforeMobile = (await page.evaluate(() => (window as any).api.sessions.list())).sessions.map((s: { id: string }) => s.id);
    await win.evaluate(() => (window as any).api.workspaces.switch('demo-frontend'));
    await sheet.getByRole('button', { name: pi.label, exact: true }).click();
    await expect(sheet).toHaveCount(0);
    const mobileSession = (await page.evaluate(() => (window as any).api.sessions.list())).sessions.find((s: { id: string }) => !beforeMobile.includes(s.id));
    expect(mobileSession.workspaceId).toBe(multi.activeWorkspaceId);
    expect(mobileSession.sourceRoot.rootId).toBe('b'); expect(mobileSession.cwd).toBe(repo);
    // The actual service editor retargets a saved definition, not the active default.
    await win.evaluate(id => (window as any).api.workspaces.switch(id), multi.activeWorkspaceId);
    const service = await win.evaluate(async id => (window as any).api.services.create({
      name: '定时源根验收', workspaceId: id, rootId: 'a', runtime: 'fixture-shell', prompt: 'source fixture',
      schedule: { kind: 'daily', time: '09:00' }, enabled: false
    }), multi.activeWorkspaceId);
    const projection = (await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((s: { serviceId?: string }) => s.serviceId === service.id);
    await win.evaluate(id => (window as any).api.sessions.select(id), projection.id);
    const editor = win.locator('.service-view');
    await editor.getByRole('button', { name: '编辑', exact: true }).click();
    await editor.getByRole('combobox', { name: '运行位置', exact: true }).click();
    await win.getByRole('option', { name: repo, exact: true }).click();
    await editor.getByRole('button', { name: '保存（保持停用）', exact: true }).click();
    await expect(editor.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
    const savedService = await win.evaluate(id => (window as any).api.services.get(id), service.id);
    expect(savedService.sourceRoot.rootId).toBe('b');
    await win.evaluate(async id => {
      const cfg = await (window as any).api.config.get(); const ws = cfg.workspaces.find((w: { id: string }) => w.id === id);
      await (window as any).api.workspaces.update(id, { defaultRootId: 'a', expectedRootsRevision: ws.rootsRevision });
      await (window as any).api.workspaces.switch('demo-frontend');
    }, multi.activeWorkspaceId);
    await page.evaluate(id => (window as any).api.services.runNow(id), service.id);
    const serviceRuns = await page.evaluate(id => (window as any).api.services.runs(id), service.id);
    expect(serviceRuns.runs[0].status).toBe('ok');
    const serviceSession = (await win.evaluate(() => (window as any).api.sessions.list())).sessions.find((s: { id: string }) => s.id === serviceRuns.runs[0].sessionId);
    expect(serviceSession.workspaceId).toBe(multi.activeWorkspaceId); expect(serviceSession.sourceRoot.rootId).toBe('b'); expect(serviceSession.cwd).toBe(repo);
    await expect.poll(() => fs.existsSync(path.join(repo, 'service-runtime-cwd.txt')) ? fs.readFileSync(path.join(repo, 'service-runtime-cwd.txt'), 'utf8') : '').toBe(repo);
    const persistedFile = path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'sessions.json');
    await expect.poll(() => JSON.parse(fs.readFileSync(persistedFile, 'utf8')).find((s: { id: string }) => s.id === sameTree.id)?.sourceRoot?.rootId).toBe('b');
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
    app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
    const restoredWindow = await app.firstWindow();
    await restoredWindow.waitForFunction(() => Boolean((window as any).api));
    const restored = await restoredWindow.evaluate(() => (window as any).api.sessions.list());
    expect((await restoredWindow.evaluate(id => (window as any).api.services.get(id), service.id)).sourceRoot.rootId).toBe('b');
    expect(restored.sessions.find((s: { serviceId?: string }) => s.serviceId === service.id).sourceRoot.rootId).toBe('b');
    const restoredTask = restored.sessions.find((s: { id: string }) => s.id === taskTree.id);
    expect(restoredTask.sourceRoot.rootId).toBe('b'); expect(restoredTask.cwd).toBe(taskTree.cwd);
    expect(restored.sessions.find((s: { id: string }) => s.id === second.id).cwd).toBe(repo);
    await restoredWindow.evaluate(async id => (window as any).api.sessions.select(id), sameTree.id);
    await expect.poll(async () => (await restoredWindow.evaluate(() => (window as any).api.sessions.list())).sessions.find((s: { id: string }) => s.id === sameTree.id)?.status).toBe('running');
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
