import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathKey } from '../../src/shared/pathKey';

test('Git 安全交互：真实分区丢弃、慢推送回执、远端更新与失败保留', async ({}, info) => {
  test.setTimeout(100_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = info.outputDir, root = path.join(fixture, 'workspace');
  const userData = path.join(fixture, '.dev-sandbox/userData'), remote = path.join(fixture, 'remote.git');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(remote, { recursive: true });
  const gitConfig = path.join(fixture, 'empty.gitconfig'); fs.writeFileSync(gitConfig, '');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[0].startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `git-safety-${process.pid}` };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(remote, 'init', '--bare', '-q', '-b', 'main'); git(fixture, 'clone', '-q', remote, root);
  const identity = (cwd: string) => { git(cwd, 'config', 'user.name', 'Git UI'); git(cwd, 'config', 'user.email', 'git-ui@example.invalid'); };
  identity(root); fs.writeFileSync(path.join(root, 'same.txt'), 'base\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base'); git(root, 'push', '-qu', 'origin', 'main');
  const peer = path.join(fixture, 'peer'); git(fixture, 'clone', '-q', remote, peer); identity(peer);
  const nested = path.join(root, 'packages/toolbox');
  fs.mkdirSync(nested, { recursive: true }); git(nested, 'init', '-q', '-b', 'main');
  const worktree = path.join(root, 'checkouts', 'linked topic');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(root, 'worktree', 'add', '-qb', 'topic', worktree);
  fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n/packages/\n/checkouts/\n');
  fs.writeFileSync(path.join(root, 'same.txt'), 'staged\n'); git(root, 'add', '.'); fs.writeFileSync(path.join(root, 'same.txt'), 'working\n');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'git-safety',
    workspaces: [{ id: 'git-safety', name: 'Git 安全交互', path: root, accentOff: true }],
    mcp: { enabled: false, servers: [] }, webAccess: { enabled: false } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  const output = path.join(project, '.tmp/ui-captures/git-safety'); fs.mkdirSync(output, { recursive: true });
  try {
    const win = await app.firstWindow(); const errors: string[] = [];
    win.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 920));
    await win.locator('.app-shell').waitFor({ timeout: 40_000 }); await win.keyboard.press('Escape');
    await expect(win.locator('.left-panel').getByRole('combobox', { name: '切换 Worktree', includeHidden: true })).toHaveCount(0);
    await win.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    const pane = win.locator('.right-workspace');
    await pane.getByRole('tablist', { name: '资源面板' }).getByRole('tab', { name: 'Git', exact: true }).click();
    const tree = pane.getByRole('tree', { name: '仓库' });
    const rootRow = tree.getByRole('treeitem', { name: /^workspace\b/ });
    await expect(rootRow).toHaveAttribute('aria-level', '1');
    await rootRow.click();
    const directoryRow = tree.getByText('packages', { exact: true });
    await directoryRow.click();
    const leaf = tree.getByText('toolbox', { exact: true });
    await expect(leaf.locator('..')).toHaveClass('git-repo-label');
    const levels = await tree.getByRole('treeitem').evaluateAll(rows => rows.map(row => ({
      level: row.getAttribute('aria-level'), icon: row.querySelector('.file-tree-folder')!.getBoundingClientRect().left
    })));
    expect(levels.map(row => row.level)).toEqual(['1', '2', '3']);
    expect(levels[1].icon - levels[0].icon).toBeGreaterThanOrEqual(8);
    expect(levels[2].icon - levels[1].icon).toBe(levels[1].icon - levels[0].icon);
    await expect(tree.getByTitle(worktree, { exact: true })).toHaveCount(0);
    const detail = pane.locator('.right-content-page.is-shown .git-detail');
    await expect(detail.locator('.git-sync-strip')).toHaveCount(0);
    const toolbar = pane.getByRole('toolbar', { name: '当前内容工具', exact: true });
    const fetch = toolbar.getByRole('button', { name: 'Fetch', exact: true });
    const pull = toolbar.getByRole('button', { name: 'Pull', exact: true });
    const push = toolbar.getByRole('button', { name: 'Push', exact: true });
    const remoteDetails = toolbar.getByRole('button', { name: 'Git 操作详情', exact: true });
    const details = win.getByRole('dialog', { name: 'Git 操作详情', exact: true });
    await expect(remoteDetails).toBeInViewport();
    await expect(pull).toHaveAccessibleDescription(/待拉 0/);
    await expect(push).toHaveAccessibleDescription(/待推 0/);
    await expect(pull.getByText('0', { exact: true })).toBeInViewport();
    await expect(push.getByText('0', { exact: true })).toBeInViewport();
    const location = pane.locator('.right-git-location');
    const branchTrigger = location.locator('button.git-branch-name-btn');
    const prIcon = toolbar.getByRole('button', { name: 'PR', exact: true }).locator('svg');
    const picker = location.getByRole('combobox', { name: '切换 Worktree' });
    const selectedTab = pane.getByRole('tablist', { name: '内容标签页' }).getByRole('tab', { selected: true });
    const assertSelectedCheckout = (checkout: string) => expect.poll(async () =>
      pathKey((await selectedTab.getAttribute('title')) ?? '')).toBe(pathKey(checkout));
    const assertCheckoutControlsFit = (theme: string) => test.step(`分支和 Worktree 使用同款触发器（${theme}）`, async () => {
      await win.mouse.move(1, 1);
      await expect(picker).toBeInViewport();
      await expect(branchTrigger).toHaveCount(1);
      await expect(branchTrigger).toBeEnabled();
      await expect(branchTrigger).toHaveAccessibleName('切换分支 · main');
      await expect(branchTrigger.locator('.git-branch-name')).toHaveText('main');
      const branchIcon = branchTrigger.locator('.git-branch-icon');
      await expect(branchIcon).toBeInViewport({ ratio: 1 });
      await expect(prIcon).toBeInViewport({ ratio: 1 });
      expect(await prIcon.innerHTML()).not.toBe(await branchIcon.innerHTML());
      await expect(picker).toBeEnabled();
      await expect(location).not.toContainText(root);
      await expect(location).not.toContainText('origin/main');
      const controls = await location.evaluate(element => {
        const branch = element.querySelector('.git-branch-name-btn')!;
        const picker = branch.nextElementSibling!;
        const branchBox = branch.getBoundingClientRect(), pickerBox = picker.getBoundingClientRect();
        const appearance = (control: Element, label: string) => {
          const shell = getComputedStyle(control);
          const text = getComputedStyle(control.querySelector(label)!);
          const arrow = control.querySelector('.c-select-caret');
          return { height: shell.height, padding: shell.padding, border: shell.border, radius: shell.borderRadius,
            background: shell.backgroundColor, color: text.color, fontSize: text.fontSize, fontWeight: text.fontWeight,
            caret: arrow?.outerHTML };
        };
        return {
          geometry: { adjacent: picker.matches('.git-worktree-picker'), sameRow: Math.abs(branchBox.top - pickerBox.top) < 3,
            fits: branchBox.right <= pickerBox.left && pickerBox.right <= element.getBoundingClientRect().right + 1 },
          branch: appearance(branch, '.git-branch-name'),
          worktree: appearance(picker, '.c-select-value')
        };
      });
      expect(controls.geometry).toEqual({ adjacent: true, sameRow: true, fits: true });
      expect(controls.branch.caret).toBeTruthy();
      expect(controls.worktree).toEqual(controls.branch);
    });
    await assertCheckoutControlsFit('深色');
    await expect(picker.locator('.c-select-value')).toBeVisible();
    await test.step('当前分支按钮打开分支选择，完整检出路径仍可查', async () => {
      await branchTrigger.press('Enter');
      await expect(branchTrigger).toHaveAttribute('aria-expanded', 'true');
      const branches = win.locator('.git-branch-pop');
      const currentBranch = branches.locator('.git-branch-item.is-current');
      await expect(currentBranch.getByText('main', { exact: true })).toBeVisible();
      await expect(currentBranch.getByText('当前', { exact: true })).toBeVisible();
      await win.keyboard.press('Escape');
      await expect(branchTrigger).toHaveAttribute('aria-expanded', 'false');
      await expect(branches).toBeHidden();
      await assertSelectedCheckout(root);
      await remoteDetails.click();
      await expect.poll(async () => pathKey((await details.locator('.confirm-detail').textContent() ?? '').split('\n')[0])).toBe(pathKey(root));
      await expect(details).toContainText('origin/main');
      await details.getByRole('button', { name: '关闭', exact: true }).last().click();
      await expect(details).toBeHidden();
    });
    const capture = async (name: string, { fullWindow = false, keepPointer = false } = {}) => {
      if (!keepPointer) await win.mouse.move(1, 1);
      await expect(pane).toBeInViewport({ ratio: 0.99 });
      const rect = (await pane.boundingBox())!;
      const pixels = await app.evaluate(async ({ BrowserWindow }, { rect, fullWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage(fullWindow ? undefined : { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })).toPNG().toString('base64'), { rect, fullWindow });
      fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(pixels, 'base64'));
    };
    const assertDividerWeight = (horizontalName: string, verticalName: string, screenshot: string) =>
      test.step(`横竖分割线粗细一致（${horizontalName}）`, async () => {
        const horizontal = detail.getByRole('separator', { name: horizontalName });
        const vertical = detail.getByRole('separator', { name: verticalName });
        const line = horizontal.locator('.split-pane-handle-line');
        await rootRow.hover();
        await horizontal.press('ArrowDown');
        await expect(horizontal).toBeFocused();
        await expect(line).toHaveCSS('height', '1px');
        await win.keyboard.press('Tab');
        await vertical.hover();
        await expect(vertical.locator('.split-pane-handle-line')).toHaveCSS('width', '3px');
        await horizontal.hover();
        await expect(line).toHaveCSS('height', '3px');
        await capture(screenshot, { keepPointer: true });
        const box = (await horizontal.boundingBox())!;
        await win.mouse.down();
        try {
          await win.mouse.move(box.x + box.width / 2, box.y + 24);
          await expect(horizontal).toHaveClass(/\bis-hot\b/);
          await expect(line).toHaveCSS('height', '3px');
        } finally { await win.mouse.up(); }
        await expect(horizontal).not.toHaveClass(/\bis-hot\b/);
        await rootRow.hover();
        await expect(line).toHaveCSS('height', '1px');
      });
    const commit = detail.getByRole('button', { name: 'Commit', exact: true });
    await expect(commit).toBeDisabled();
    const disabledColor = await commit.evaluate(element => getComputedStyle(element).backgroundColor);
    const dotAfterName = await rootRow.evaluate(row => row.querySelector('.file-tree-name')!.nextElementSibling?.classList.contains('git-dirty-dot'));
    expect(dotAfterName).toBe(true);
    await capture('dark-idle');
    await assertDividerWeight('拖动调整未暂存与已暂存高度', '拖动调整变更列表与 Diff 宽度', 'dark-work-divider');
    const switchScreen = async () => {
      await win.locator('.chrome-right-toggle').focus();
      await win.keyboard.press('Control+Shift+\\');
    };
    await test.step('虚拟屏切回时保留 Diff，直到后台读取返回', async () => {
      await detail.locator('.git-changes-section').first().getByText('same.txt', { exact: true }).click();
      const preview = detail.locator('.git-diff-view');
      await expect(preview).toContainText('working');
      await preview.evaluate(element => { (element as HTMLElement).dataset.testWarmPreview = 'retained'; });
      await app.evaluate(({ ipcMain }) => {
        const ipc = ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> };
        const channel = 'git:invokeScoped';
        const original = ipc._invokeHandlers.get(channel)!;
        const gate = { requests: 0, release: () => {} };
        const pending = new Promise<void>(resolve => {
          gate.release = () => {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, original);
            resolve();
          };
        });
        Object.assign(globalThis, { gitResumeGate: gate });
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args: unknown[]) => {
          if (args[1] === 'diff') { gate.requests++; await pending; }
          return original(event, ...args);
        });
      });
      try {
        await switchScreen();
        await expect(win.locator('.main-view')).toHaveClass(/\bh-terminal\b/);
        await expect(preview).toHaveAttribute('data-test-warm-preview', 'retained');
        fs.writeFileSync(path.join(root, 'same.txt'), 'working after return\n');
        await switchScreen();
        await expect(win.locator('.main-view')).toHaveClass(/\bh-git\b/);
        await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { gitResumeGate: { requests: number } }).gitResumeGate.requests)).toBeGreaterThan(0);
        await expect(preview).toHaveAttribute('data-test-warm-preview', 'retained');
        await expect(preview).not.toContainText('working after return');
        await capture('dark-git-resumed');
      } finally {
        await app.evaluate(() => (globalThis as typeof globalThis & { gitResumeGate: { release: () => void } }).gitResumeGate.release());
      }
      await expect(preview).toContainText('working after return');
    });
    await detail.locator('.git-changes-section').first().getByText('same.txt', { exact: true }).click({ button: 'right' });
    await win.getByText('丢弃未暂存改动', { exact: true }).click();
    const dialog = win.getByRole('dialog', { name: '丢弃未暂存改动' });
    await expect(dialog).toContainText('保留已暂存内容'); await expect(dialog).toContainText('same.txt');
    await dialog.getByRole('button', { name: '丢弃', exact: true }).click();
    await expect.poll(() => fs.readFileSync(path.join(root, 'same.txt'), 'utf8')).toBe('staged\n');
    expect(git(root, 'diff', '--cached')).toContain('+staged');
    await expect(dialog).toBeHidden();
    const message = detail.getByRole('textbox', { name: '提交说明…' });
    await expect(message).toBeEditable();
    await message.fill('local');
    await expect(commit).toBeEnabled();
    await expect.poll(() => commit.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(disabledColor);
    await commit.click();
    await expect.poll(() => git(root, 'log', '-1', '--format=%s')).toBe('local');
    await test.step('切屏保留历史提交和选中文件的 Diff', async () => {
      await pane.getByRole('button', { name: '历史', exact: true }).click();
      await detail.locator('.git-hist-rows').getByText('local', { exact: true }).click();
      const preview = detail.locator('.git-hist-detail-body .git-diff-view');
      await expect(preview).toContainText('staged');
      await assertDividerWeight('拖动调整历史与变更高度', '拖动调整文件列表与 Diff 宽度', 'dark-history-divider');
      await preview.evaluate(element => { (element as HTMLElement).dataset.testHistoryPreview = 'retained'; });
      await switchScreen();
      await expect(win.locator('.main-view')).toHaveClass(/\bh-terminal\b/);
      await expect(preview).toHaveAttribute('data-test-history-preview', 'retained');
      await switchScreen();
      await expect(win.locator('.main-view')).toHaveClass(/\bh-git\b/);
      await expect(preview).toHaveAttribute('data-test-history-preview', 'retained');
      await pane.getByRole('button', { name: '工作区', exact: true }).click();
    });
    fs.writeFileSync(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nsleep 2\n', { mode: 0o755 });
    await expect(push).toHaveAccessibleDescription(/待推 1/);
    await expect(push.getByText('1', { exact: true })).toBeInViewport();
    await capture('dark-ahead');
    await push.click();
    await expect(remoteDetails).toHaveAccessibleDescription(/正在推送/);
    await capture('dark-pushing');
    await expect(remoteDetails).toHaveAccessibleDescription(/推送成功/);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'));
    git(peer, 'pull', '--ff-only'); fs.writeFileSync(path.join(peer, 'remote.txt'), 'remote\n'); git(peer, 'add', '.'); git(peer, 'commit', '-qm', 'remote change'); git(peer, 'push', '-q');
    await fetch.click();
    await expect(pull).toHaveAccessibleDescription(/待拉 1/);
    await expect(pull.getByText('1', { exact: true })).toBeInViewport();
    await expect(remoteDetails).toHaveAccessibleDescription(/刚刚检查/);
    await capture('dark-remote-update');
    await win.evaluate(async () => window.api.themes.activate('light'));
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    await assertCheckoutControlsFit('浅色');
    await capture('light-remote-update');
    const resourceSplit = pane.getByRole('separator', { name: '调整资源面板宽度' });
    await resourceSplit.focus(); await win.keyboard.press('End');
    await assertCheckoutControlsFit('浅色窄栏');
    await expect(picker.locator('.c-select-trigger-icon')).toBeInViewport({ ratio: 1 });
    await expect(picker.locator('.c-select-value')).toBeHidden();
    for (const action of [pull, push, remoteDetails]) {
      await expect(action.locator('svg')).toBeInViewport({ ratio: 1 });
    }
    await expect.poll(() => location.locator('.git-branch-name').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await capture('light-narrow');
    await assertDividerWeight('拖动调整未暂存与已暂存高度', '拖动调整变更列表与 Diff 宽度', 'light-narrow-work-divider');
    await remoteDetails.focus();
    await expect(remoteDetails).toBeFocused();
    await expect(remoteDetails.locator('svg')).toBeInViewport({ ratio: 1 });
    await expect(pull.getByText('1', { exact: true })).toBeInViewport({ ratio: 1 });
    await capture('light-narrow-sync-controls');
    git(root, 'pull', '--ff-only');
    fs.writeFileSync(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\necho FIXTURE_PUSH_REJECTED >&2\nexit 1\n');
    fs.writeFileSync(path.join(root, 'second.txt'), 'second\n'); git(root, 'add', 'second.txt'); git(root, 'commit', '-qm', 'second');
    await push.click();
    await expect(remoteDetails).toHaveAccessibleDescription(/推送失败/);
    await expect(remoteDetails).toHaveAttribute('data-tone', 'danger');
    await pane.getByRole('button', { name: '刷新本地状态', exact: true }).click();
    await expect(remoteDetails).toHaveAccessibleDescription(/推送失败/);
    await remoteDetails.click();
    await expect(details).toContainText('待推 1');
    await expect(details).toContainText('推送失败');
    await expect(details).toContainText('FIXTURE_PUSH_REJECTED');
    await expect(details).toHaveCSS('opacity', '1');
    await capture('light-failed-details', { fullWindow: true });
    await details.getByRole('button', { name: '关闭', exact: true }).last().click();
    await expect(details).toBeHidden();
    await picker.focus();
    await picker.press('ArrowDown');
    const topic = win.getByRole('option', { name: 'linked topic · topic', exact: true });
    await expect(topic).toBeVisible();
    await win.screenshot({ path: path.join(output, 'light-worktree-toolbar.png'), animations: 'disabled' });
    await topic.click();
    await assertSelectedCheckout(worktree);
    await expect(pane.locator('.git-branch-name')).toHaveText('topic');
    await expect(remoteDetails).toHaveAccessibleDescription(/未设置上游/);
    await expect(pull.getByText(/^\d+$/)).toHaveCount(0);
    await expect(push.getByText(/^\d+$/)).toHaveCount(0);
    await capture('light-no-upstream');
    await picker.click();
    await win.getByRole('option', { name: '主检出 · workspace', exact: true }).click();
    await assertSelectedCheckout(root);

    const nestedRow = tree.getByRole('treeitem', { name: /^toolbox\b/ });
    await nestedRow.click();
    await assertSelectedCheckout(nested);
    await rootRow.click({ button: 'right' });
    await win.getByRole('menuitemcheckbox', { name: '隐藏此仓库' }).click();
    await expect(rootRow).toHaveClass(/\bis-dir\b/);
    await expect(rootRow).toHaveAttribute('aria-expanded', 'true');
    await expect(nestedRow).toHaveAttribute('aria-level', '3');
    await rootRow.click();
    await expect(rootRow).toHaveAttribute('aria-expanded', 'false');
    await expect(nestedRow).toHaveCount(0);
    await rootRow.press('Enter');
    await expect(nestedRow).toHaveAttribute('aria-level', '3');
    await assertSelectedCheckout(nested);
    await capture('light-hidden-parent');

    await win.evaluate(async () => window.api.themes.activate('dark'));
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
    await resourceSplit.press('Home');
    await expect.poll(() => tree.evaluate(element => element.clientWidth)).toBeLessThanOrEqual(180);
    await capture('dark-hidden-parent-narrow');

    await pane.getByTitle(/^显示已隐藏的仓库/).click();
    await expect(rootRow).toHaveClass(/\bis-hidden-repo\b/);
    await rootRow.click({ button: 'right' });
    await win.getByRole('menuitemcheckbox', { name: '显示此仓库' }).click();
    await expect(rootRow).not.toHaveClass(/\bis-hidden-repo\b/);
    await rootRow.click();
    await assertSelectedCheckout(root);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
