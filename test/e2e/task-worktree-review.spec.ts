import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathKey } from '../../src/shared/pathKey';

// Restored task fixture: actual Git/IPC/UI, no mocked repository operations.
test('恢复多组任务后可审阅第二组及同名嵌套仓并只采纳到所选来源', async () => {
  test.setTimeout(120_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'task-review-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  const emptyConfig = path.join(fixture, 'empty.gitconfig'); fs.writeFileSync(emptyConfig, '');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && !entry[0].startsWith('GIT_'))), GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `task-review-${process.pid}` };
  // Windows CLI configuration belongs to the fixture as well as Electron userData.
  env.APPDATA = path.join(fixture, 'isolated-appdata'); fs.mkdirSync(env.APPDATA, { recursive: true });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  const branch = 'ao/task-review';
  function makeRepo(main: string, tree: string): void {
    fs.mkdirSync(main, { recursive: true }); git(main, ['init', '-b', 'main']);
    git(main, ['config', 'user.name', 'Fixture']); git(main, ['config', 'user.email', 'fixture@test']);
    git(main, ['config', 'commit.gpgsign', 'false']); git(main, ['config', 'core.hooksPath', path.join(fixture, 'owned-hooks')]);
    fs.writeFileSync(path.join(main, '.gitignore'), '/Plugins/\n/.muster/\n/.agents/\n/AGENTS.md\n/CLAUDE.md\n');
    fs.writeFileSync(path.join(main, 'same.txt'), 'base\n'); git(main, ['add', '.']); git(main, ['commit', '-m', 'base']);
    fs.mkdirSync(path.dirname(tree), { recursive: true }); git(main, ['worktree', 'add', '-b', branch, tree]);
  }
  const groups = ['a', 'b'].map(id => {
    const main = path.join(fixture, 'sources', id), tree = path.join(fixture, 'managed tasks', id);
    makeRepo(main, tree); makeRepo(path.join(main, 'Plugins/Same'), path.join(tree, 'Plugins/Same'));
    return { id, path: tree, branch, baseBranch: 'main', sourceRoot: { rootId: id, path: main, cwd: main,
      physicalPath: pathKey(fs.realpathSync(main)) },
      source: { mainRepo: main, commonDir: path.join(main, '.git') }, repos: [{ path: 'Plugins/Same', branch, baseBranch: 'main' }] };
  });
  const workspace = { id: 'review', name: '多组审阅', path: groups[0].source.mainRepo, controlRoot: groups[0].source.mainRepo,
    roots: groups.map(group => ({ id: group.id, path: group.source.mainRepo, label: '同名根' })), defaultRootId: 'a', rootsRevision: 0, openedAt: 0 };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: workspace.path, workspaces: [workspace],
    activeWorkspaceId: workspace.id, mcp: { enabled: false, servers: [] }, openai: { baseUrl: '', apiKey: '', model: '' } }));
  const session = { id: 'restored-task', type: 'terminal', name: '多组任务', runtime: 'pi', createdAt: Date.now(), workspaceId: workspace.id,
    cwd: path.join(groups[1].path, 'Plugins/Same'), sourceRoot: groups[1].sourceRoot,
    worktreePath: groups[0].path, worktreeBranch: branch, worktreeSource: groups[0].source, worktreeRepoSet: groups[0].repos,
    worktreeGroups: { version: 1, primaryGroupId: 'a', groups } };
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([session]));
  const selectedTree = path.join(groups[1].path, 'Plugins/Same'), source = path.join(groups[1].source.mainRepo, 'Plugins/Same');
  fs.writeFileSync(path.join(selectedTree, 'same.txt'), 'second nested task\n');
  const workerIndex = git(selectedTree, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
  const indexBefore = fs.readFileSync(workerIndex), sourceHead = git(source, ['rev-parse', 'HEAD']);
  const screenshots = path.join(project, '.tmp/ui-captures/task-worktree-review'); fs.mkdirSync(screenshots, { recursive: true });
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  const diagnostics: string[] = [];
  app.process().stderr?.on('data', chunk => { diagnostics.push(String(chunk)); if (diagnostics.length > 60) diagnostics.shift(); });
  const win = await app.firstWindow();
  win.on('pageerror', error => diagnostics.push(error.message));
  try {
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    const restored = await win.evaluate(() => (window as any).api.sessions.list());
    expect(restored.sessions.find((item: { id: string }) => item.id === session.id).worktreeGroups.groups).toHaveLength(2);
    await win.evaluate(id => (window as any).api.sessions.select(id), session.id);
    await win.keyboard.press('Escape'); await win.bringToFront();
    const right = win.locator('.side-tools-panel.is-active');
    if (!await right.isVisible()) await win.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    await right.getByRole('tablist', { name: '资源面板' }).getByRole('tab', { name: 'Git', exact: true }).click();
    const tree = right.getByRole('tree', { name: '仓库' });
    await tree.getByTitle(groups[0].source.mainRepo, { exact: true }).click();
    const location = right.locator('.right-git-location');
    const picker = location.getByRole('combobox', { name: '切换 Worktree' });
    const desired = `b/Plugins/Same · ${branch}`;
    await expect(location.locator('.git-branch-name-btn')).toBeEnabled();
    await picker.click();
    await win.mouse.move(5, 90);
    await expect(win.getByRole('option', { name: `a/Plugins/Same · ${branch}`, exact: true })).toBeVisible();
    await expect(win.getByRole('option', { name: desired, exact: true })).toBeVisible();
    await win.screenshot({ path: path.join(screenshots, 'worktree-toolbar.png'), animations: 'disabled' });
    await win.getByRole('option', { name: desired, exact: true }).click();
    const detail = right.locator('.right-content-page.is-shown .git-detail');
    const selectedTab = right.getByRole('tablist', { name: '内容标签页' }).getByRole('tab', { selected: true });
    await expect.poll(async () => pathKey((await selectedTab.getAttribute('title')) ?? '')).toBe(pathKey(selectedTree));
    await expect(location.locator('.git-branch-name')).toHaveText(branch);
    await expect(tree).toBeVisible();
    await expect(tree.getByRole('treeitem', { selected: true })).toHaveCount(0);
    for (const group of groups) await expect(tree.getByTitle(group.path, { exact: true })).toHaveCount(0);
    await expect(tree.getByTitle(selectedTree, { exact: true })).toHaveCount(0);
    const listed = await win.evaluate(async ({ groups, id }) => (window as any).api.git.listRepos(false,
      groups.flatMap(group => [group.path, group.path + '/Plugins/Same']), id), { groups, id: workspace.id });
    for (const group of groups) for (const member of [group.path, path.join(group.path, 'Plugins/Same')])
      expect(listed.some((row: { path: string }) => row.path.toLowerCase().replace(/\\/g, '/') === member.toLowerCase().replace(/\\/g, '/'))).toBe(true);
    await detail.getByRole('button', { name: '部分采纳', exact: true }).click();
    await expect(win.getByText('second nested task', { exact: true })).toBeVisible();
    for (const theme of ['dark', 'light']) {
      await win.evaluate(async theme => (window as any).api.themes.activate(theme), theme);
      for (const width of [1280, 780]) {
        await app.evaluate(({ BrowserWindow }, width) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.setMinimumSize(390, 640);
          window.setSize(width, 900);
        }, width);
        await expect.poll(() => win.evaluate(() => innerWidth)).toBe(width);
        if (width <= 820) {
          await expect(win.locator('html')).toHaveClass(/is-narrow/);
          if (!await win.locator('.git-page').evaluate(element => element.classList.contains('is-drawer-open')))
            await win.getByTitle('唤出文件与 Git 面板', { exact: true }).click();
        }
        await expect.poll(async () => {
          const bounds = await right.boundingBox();
          const height = await win.evaluate(() => innerHeight);
          return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= height + 1);
        }).toBe(true);
        await expect(picker).toBeInViewport();
        if (width <= 820) {
          const hunk = win.locator('.adopt-hunk-check input[type="checkbox"]').first();
          await expect.poll(() => hunk.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
          })).toBe(true);
        }
        const nameWidths = await tree.locator('.file-tree-name').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().width));
        expect(nameWidths.length).toBeGreaterThan(0);
        expect(Math.min(...nameWidths)).toBeGreaterThan(24);
        await win.mouse.move(5, 5);
        await right.screenshot({ path: path.join(screenshots, `${theme}-${width}.png`), animations: 'disabled' });
      }
    }
    const hunk = win.locator('.adopt-hunk-check input[type="checkbox"]').first();
    await hunk.check();
    await win.getByRole('button', { name: '采纳 1 个 hunk', exact: true }).click();
    await win.getByRole('dialog', { name: '采纳到主仓' }).getByRole('button', { name: '采纳', exact: true }).click();
    await expect.poll(() => git(source, ['diff', '--cached'])).toContain('second nested task');
    expect(git(source, ['rev-parse', 'HEAD'])).toBe(sourceHead); expect(fs.readFileSync(workerIndex)).toEqual(indexBefore);
    for (const group of groups) expect(git(group.source.mainRepo, ['status', '--porcelain'])).toBe('');
    expect(git(path.join(groups[0].source.mainRepo, 'Plugins/Same'), ['status', '--porcelain'])).toBe('');
  } catch (error) {
    fs.writeFileSync(path.join(screenshots, 'failure.json'), JSON.stringify({ fixture, diagnostics,
      hitTest: await win.evaluate(() => {
        const element = document.querySelector('.adopt-hunk-check input');
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const ancestry = (node: Element | null) => {
          const result = [];
          for (; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            result.push({ className: node.className, zIndex: style.zIndex, transform: style.transform, willChange: style.willChange,
              opacity: style.opacity, position: style.position, contain: style.contain });
          }
          return result;
        };
        return { rect: rect.toJSON(), expected: ancestry(element), actual: ancestry(hit) };
      }).catch(String),
      panel: await win.locator('.side-tools-panel').innerText().catch(() => ''),
      html: await win.locator('.side-tools-panel').innerHTML().catch(() => ''),
      selected: await win.evaluate(async ({ repo, id }) => {
        try { return await (window as any).api.git.status(repo, id); } catch (error) { return String(error); }
      }, { repo: selectedTree, id: workspace.id }).catch(String) }, null, 2));
    await win.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {});
  }
});
