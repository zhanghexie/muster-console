import { renderWithAppTips as render } from './helpers/app-tips';
/**
 * Git「显示已隐藏仓」三态跨重启：hydrate workspace.json git.hiddenView，
 * 点眼睛 / 右键「只显示隐藏的」即 patch。
 * 自查：去掉 persistHiddenView 的 patch，点击用例应转红。
 */
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { GitPanel } from '../../src/renderer/src/panels/GitPanel';
import { DETAIL_SELECT_DEBOUNCE_MS } from '../../src/renderer/src/panels/gitpanel/gitPanelPure';
import { currentApiMock } from './helpers/api-mock';
import { defaultWorkspaceFileConfig, type WorkspaceFileConfig } from '../../src/shared/metaAgent';
import type { GitRepoSummary } from '../../src/shared/types';

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];
const VISIBLE: GitRepoSummary = { path: 'E:/demo/a', name: 'a', dirty: false, branch: 'main' };
const HIDDEN: GitRepoSummary = { path: 'E:/demo/a/secret', name: 'secret', dirty: false, branch: 'dev' };
const listed = (repos: GitRepoSummary[]) => ({ workspaceId: 'ws-a', rootsRevision: 0, repos, issues: [], issueCount: 0 });

function seed(cfg: WorkspaceFileConfig): { patches: Partial<WorkspaceFileConfig>[] } {
  const mock = currentApiMock();
  mock.override('git.invokeScoped', (_scope: unknown, method: string, ...args: unknown[]) => mock.mockOf(`git.${method}`)(...args));
  const patches: Partial<WorkspaceFileConfig>[] = [];
  let current = structuredClone(cfg);
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () => Promise.resolve({ sessions: [], activeId: null }));
  mock.override('workspaceFile.get', () =>
    Promise.resolve({ workspaceId: 'ws-a', config: current })
  );
  mock.override('workspaceFile.patch', (partial: Partial<WorkspaceFileConfig>) => {
    patches.push(partial);
    current = {
      ...current,
      ...partial,
      git: { ...(current.git ?? {}), ...(partial.git ?? {}) }
    };
    return Promise.resolve({ ok: true, workspaceId: 'ws-a', config: current });
  });
  mock.override('git.listRepoLocations', () => Promise.resolve(listed([VISIBLE, HIDDEN])));
  mock.override('git.repoSummaries', (paths: string[]) => Promise.resolve(listed([VISIBLE, HIDDEN].filter(r => paths.includes(r.path)))));
  mock.override('git.status', () =>
    Promise.resolve({
      branch: 'main',
      tracking: null,
      ahead: 0,
      behind: 0,
      files: []
    })
  );
  return { patches };
}

function renderGit(revealAbs?: { path: string; nonce: number }): void {
  Element.prototype.scrollIntoView = () => {};
  render(
    <StoreProvider>
      <PanelHistoryProvider>
        <GitPanel active sideTab="git" onSideTab={() => {}} revealAbs={revealAbs} />
      </PanelHistoryProvider>
    </StoreProvider>
  );
}

it('仓库列表手动刷新才强制发现，扫描中禁用按钮；焦点和文件事件仅更新摘要', async () => {
  seed(defaultWorkspaceFileConfig());
  const mock = currentApiMock();
  renderGit();
  const refresh = await screen.findByRole('button', { name: '刷新仓库列表' });
  await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false));
  mock.mockOf('git.listRepoLocations').mockClear();
  fireEvent.focus(window);
  await waitFor(() => expect(mock.mockOf('git.repoSummaries')).toHaveBeenCalled());
  expect(mock.mockOf('git.listRepoLocations')).not.toHaveBeenCalled();
  mock.mockOf('git.listRepoLocations').mockClear();
  await act(async () => {
    mock.emit('fs:changed', { workspaceId: 'ws-a', relativePaths: ['secret/.git'] });
    await new Promise(resolve => setTimeout(resolve, 850));
  });
  await waitFor(() => expect(mock.mockOf('git.listRepoLocations')).toHaveBeenCalled());
  expect(mock.mockOf('git.listRepoLocations').mock.calls.every(([force]) => force === false)).toBe(true);
  mock.mockOf('git.listRepoLocations').mockClear();
  let finish!: (value: GitRepoSummary[]) => void;
  mock.override('git.listRepoLocations', () => new Promise(resolve => { finish = value => resolve(listed(value)); }));
  fireEvent.click(refresh);
  await waitFor(() => expect(mock.mockOf('git.listRepoLocations')).toHaveBeenCalledWith(true, 'ws-a', expect.any(Array)));
  expect(refresh.hasAttribute('disabled')).toBe(true);
  fireEvent.click(refresh);
  expect(mock.mockOf('git.listRepoLocations').mock.calls.length).toBe(1);
  await act(async () => { finish([VISIBLE, HIDDEN]); });
  await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false));
});

it('外置任务仓保留文件定位和状态刷新，仓库树只显示源仓', async () => {
  seed(defaultWorkspaceFileConfig());
  const mock = currentApiMock();
  const external = 'D:/AgentTrees/ws/repo/task';
  const nested = external + '/Plugins/B';
  mock.override('sessions.list', () => Promise.resolve({ activeId: 'task', sessions: [{
    id: 'task', type: 'terminal', name: 'Task', cwd: external, workspaceId: 'ws-a',
    worktreePath: external, worktreeBranch: 'ao/task', worktreeRepoSet: [{ path: 'Plugins/B', branch: 'ao/task' }]
  }] }));
  mock.override('git.listRepoLocations', (_force: boolean, _id: string, paths: string[] = []) => Promise.resolve(listed([
    VISIBLE,
    ...(paths.includes(external) ? [{ path: external, name: 'task', dirty: false, branch: 'ao/task', worktree: true }] : []),
    ...(paths.includes(nested) || paths.includes(nested + '/a.txt') ? [{ path: nested, name: 'B', dirty: true, branch: 'ao/task', worktree: true }] : [])
  ])));
  renderGit({ path: nested + '/a.txt', nonce: 1 });
  await waitFor(() => expect(mock.mockOf('git.listRepoLocations')).toHaveBeenCalledWith(expect.any(Boolean), 'ws-a', expect.arrayContaining([external, nested])));
  await waitFor(() => expect(mock.mockOf('git.status')).toHaveBeenCalledWith(nested));
  const tree = within(screen.getByRole('tree', { name: '仓库' }));
  expect(tree.getByTitle(VISIBLE.path)).toBeTruthy();
  expect(tree.queryByTitle(external)).toBeNull();
  expect(tree.queryByTitle(nested)).toBeNull();
  const before = mock.mockOf('git.status').mock.calls.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); });
  expect(mock.mockOf('git.status').mock.calls.length).toBeGreaterThan(before);
  fireEvent.blur(window);
  const blurred = mock.mockOf('git.status').mock.calls.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); });
  expect(mock.mockOf('git.status').mock.calls.length).toBe(blurred);
}, 10000);

function baseCfg(hiddenView: 'exclude' | 'include' | 'only'): WorkspaceFileConfig {
  const cfg = defaultWorkspaceFileConfig();
  return {
    ...cfg,
    git: {
      ...(cfg.git ?? {}),
      hiddenRepos: [HIDDEN.path],
      hiddenView
    }
  };
}

it('所有来源扫描失败时不展示无仓库/初始化引导，保留失败提示与重试入口', async () => {
  seed(defaultWorkspaceFileConfig());
  const mock = currentApiMock();
  mock.override('git.listRepoLocations', async () => ({ ...listed([]), issueCount: 1,
    issues: [{ workspaceId: 'ws-a', rootId: 'a', rootPath: WS[0].path, path: WS[0].path, code: 'ENOENT', message: 'offline' }] }));
  renderGit();
  expect(await screen.findByText('仓库扫描未完成（1 处）')).toBeTruthy();
  expect(screen.getByRole('button', { name: '重试扫描' })).toBeTruthy();
  expect(screen.queryByText('当前工作区没有 Git 仓库')).toBeNull();
  expect(screen.queryByRole('button', { name: '在工作区根目录初始化' })).toBeNull();
});

describe('Git hiddenView 持久化', () => {
  it('隐藏根仓后继续用同一层级展开子仓，目录点击和键盘操作都不切到根仓', async () => {
    const { patches } = seed({ ...defaultWorkspaceFileConfig(), git: { selectedRepo: HIDDEN.path } });
    const status = currentApiMock().mockOf('git.status');
    renderGit();
    const treeElement = await screen.findByRole('tree', { name: '仓库' });
    const tree = within(treeElement);
    const root = await tree.findByTitle(VISIBLE.path);
    expect((await tree.findByTitle(HIDDEN.path)).getAttribute('aria-level')).toBe('2');
    await waitFor(() => expect(status).toHaveBeenCalledWith(HIDDEN.path));
    status.mockClear();

    fireEvent.keyDown(treeElement, { key: 'Home' });
    fireEvent.click(within(root).getByRole('button', { name: '隐藏此仓库' }));
    const folder = tree.getByTitle(VISIBLE.path);
    expect(folder.classList.contains('is-dir')).toBe(true);
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(within(folder).queryByRole('button')).toBeNull();
    expect(tree.getByTitle(HIDDEN.path).getAttribute('aria-level')).toBe('2');
    expect(patches).toContainEqual({ git: { hiddenRepos: [VISIBLE.path] } });

    fireEvent.click(folder);
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(tree.queryByTitle(HIDDEN.path)).toBeNull();
    fireEvent.keyDown(folder, { key: 'Enter' });
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(tree.getByTitle(HIDDEN.path).getAttribute('aria-level')).toBe('2');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, DETAIL_SELECT_DEBOUNCE_MS)); });
    expect(status).not.toHaveBeenCalledWith(VISIBLE.path);

    fireEvent.click(screen.getByTitle(/^显示已隐藏的仓库/));
    const restored = tree.getByTitle(VISIBLE.path);
    expect(restored.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(restored).getByRole('button', { name: '显示此仓库' }));
    expect(patches).toContainEqual({ git: { hiddenRepos: [] } });
    fireEvent.click(restored);
    await waitFor(() => expect(status).toHaveBeenCalledWith(VISIBLE.path));
  });

  it('旧配置只隐藏 Worktree 时仍可退出隐藏仓库视图', async () => {
    const cfg = baseCfg('only');
    const legacy = { path: 'E:/demo/a/worktree', name: 'worktree', worktree: true };
    cfg.git!.hiddenRepos = [legacy.path];
    const { patches } = seed(cfg);
    currentApiMock().override('git.listRepoLocations', async () => listed([VISIBLE, legacy]));
    renderGit();
    await screen.findByText('没有已隐藏的仓库');
    fireEvent.click(screen.getByTitle(/只显示已隐藏的仓库/));
    expect(within(await screen.findByRole('tree', { name: '仓库' })).getByTitle(VISIBLE.path)).toBeTruthy();
    expect(patches).toContainEqual({ git: { hiddenView: 'exclude' } });
  });

  it('工作区偏好写入抛错时在窗口显示失败原因', async () => {
    seed(baseCfg('only'));
    const mock = currentApiMock();
    renderGit();
    const eye = await screen.findByTitle(/只显示已隐藏的仓库/);
    await waitFor(() => expect(screen.getByText('secret')).toBeTruthy());
    mock.override('workspaceFile.patch', async () => { throw new Error('disk full'); });
    fireEvent.click(eye);
    const warning = (await screen.findByText(/Git 偏好保存失败/)).closest('[role="status"]');
    expect(warning?.textContent).toContain('disk full');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('主进程拒绝已过期的工作区写入时不误报保存失败', async () => {
    seed(baseCfg('only'));
    const mock = currentApiMock();
    renderGit();
    const eye = await screen.findByTitle(/只显示已隐藏的仓库/);
    await waitFor(() => expect(screen.getByText('secret')).toBeTruthy());
    mock.override('workspaceFile.patch', async () => ({ ok: false, stale: true }));
    fireEvent.click(eye);
    await waitFor(() => expect(mock.mockOf('workspaceFile.patch')).toHaveBeenCalledWith(expect.objectContaining({ git: { hiddenView: 'exclude' } }), 'ws-a'));
    await act(async () => {});
    expect(screen.queryByText(/Git 偏好保存失败/)).toBeNull();
  });

  it('重载后旧的写入失败不向当前工作区误报', async () => {
    seed(baseCfg('only'));
    const mock = currentApiMock();
    renderGit();
    const eye = await screen.findByTitle(/只显示已隐藏的仓库/);
    await waitFor(() => expect(screen.getByText('secret')).toBeTruthy());
    let finish!: (value: unknown) => void;
    mock.override('workspaceFile.patch', (partial: Partial<WorkspaceFileConfig>) => partial.git?.hiddenView === 'exclude'
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ ok: true, workspaceId: 'ws-a', config: baseCfg('only') }));
    fireEvent.click(eye);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    let reload!: (value: unknown) => void;
    mock.override('workspaceFile.get', () => new Promise(resolve => { reload = resolve; }));
    await act(async () => { mock.emit('workspaces:changed', { workspaces: WS, activeWorkspaceId: 'ws-a' }); });
    await act(async () => { finish({ ok: false, stale: true }); });
    expect(screen.queryByText(/Git 偏好保存失败/)).toBeNull();
    await act(async () => { reload({ workspaceId: 'ws-a', config: baseCfg('only') }); });
  });

  it('hydrate only → 眼睛标题是只显示隐藏；点击写回 exclude', async () => {
    const { patches } = seed(baseCfg('only'));
    renderGit();

    const eye = await screen.findByTitle(/只显示已隐藏的仓库/);
    expect(eye.className).toContain('is-on');
    await waitFor(() => {
      expect(screen.getByText('secret')).toBeTruthy();
      expect(screen.queryByText(/^a$/)).toBeNull();
    });

    fireEvent.click(eye);
    await waitFor(() => {
      expect(patches.some((p) => p.git?.hiddenView === 'exclude')).toBe(true);
    });
  });

  it('右键菜单「只显示隐藏的」从 include 切到 only 并 patch', async () => {
    const { patches } = seed(baseCfg('include'));
    renderGit();

    const eye = await screen.findByTitle(/不显示已隐藏的仓库/);
    fireEvent.contextMenu(eye);
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: '只显示隐藏的' }));
    await waitFor(() => {
      expect(patches.some((p) => p.git?.hiddenView === 'only')).toBe(true);
    });
  });
});
