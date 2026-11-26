import React, { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { WorkspaceRoot, GitRepoSummary, GitRepoListResult } from '../../src/shared/types';
import { defaultWorkspaceFileConfig } from '../../src/shared/metaAgent';
import { useGitRepoData } from '../../src/renderer/src/panels/gitpanel/useGitRepoData';
import { useRepoTree } from '../../src/renderer/src/panels/gitpanel/useRepoTree';
import { FolderRow, RepoRow } from '../../src/renderer/src/panels/gitpanel/GitRepoRows';
import { GitDiscoveryNotice } from '../../src/renderer/src/panels/gitpanel/GitDiscoveryNotice';
import { currentApiMock } from './helpers/api-mock';

const roots: WorkspaceRoot[] = [{ id: 'a', path: 'E:/A', label: 'Same' }, { id: 'b', path: 'D:/B', label: 'Same' }];
const b: GitRepoSummary = { path: 'D:/B', name: 'B', rootId: 'b', workspaceId: 'one', branch: 'main', dirty: false };
const noop = (): void => {};
const patch = vi.fn(async () => ({ ok: true, config: defaultWorkspaceFileConfig() }));
const errors = vi.fn();
const listed = (repos: GitRepoSummary[], workspaceId = 'one', rootsRevision = 0): GitRepoListResult =>
  ({ workspaceId, rootsRevision, repos, issues: [], issueCount: 0 });

it('状态未知显示失败路径并允许重试，不展示为干净仓', async () => {
  const api = currentApiMock();
  api.override('git.listRepoLocations', async () => listed([b]));
  api.override('git.repoSummaries', async () => ({ ...listed([]), issueCount: 1, issues: [{ workspaceId: 'one', rootId: 'b',
    rootPath: 'D:/B', path: 'D:/B', code: 'GIT_STATUS', message: 'git status: block timeout reached' }] }));
  render(<Harness />);
  await screen.findByText('git status: block timeout reached');
  expect(snapshot().paths).toEqual(['D:/B']);
  expect(snapshot().dirty).toEqual([null]);
  api.override('git.repoSummaries', async () => listed([b]));
  fireEvent.click(screen.getByRole('button', { name: '重试扫描' }));
  await waitFor(() => expect(snapshot().issues).toBe(0));
  expect(snapshot().dirty).toEqual([false]);
});
function Harness({ wsId = 'one', revision = 0, sources = roots, initial = null as string | null, active = true }: {
  wsId?: string; revision?: number; sources?: WorkspaceRoot[]; initial?: string | null; active?: boolean;
}): React.JSX.Element {
  const [selected, setSelected] = useState(initial);
  const saved = useRef(initial); const applied = useRef(true);
  const data = useGitRepoData({ active, workspaceId: wsId, workspacePath: sources[0].path, workspaceRoots: sources,
    rootsRevision: revision, defaultRootId: sources[0].id, selectedPath: selected, setSelectedPath: setSelected,
    savedRepoRef: saved, patch, setError: errors, clearSelectedRepo: noop, setDetailTab: noop,
    prefsAppliedRef: applied, setBranchPopOpen: noop, prefsReady: true });
  const tree = useRepoTree({ selectedPath: selected, setSelectedPath: setSelected, repos: data.repos,
    workspacePath: sources[0].path, workspaceRoots: sources, repoSort: 'name' });
  return <div><output data-testid="data">{JSON.stringify({ paths: data.repos.map(r => r.path), selected,
    status: data.status?.branch, branches: data.repos.map(r => r.branch), dirty: data.repos.map(r => r.dirty), diff: data.diffText, diffLoading: data.diffLoading, loading: data.listLoading, issues: data.discoveryIssueCount })}</output>
    <GitDiscoveryNotice key={`${wsId}:${revision}`} issues={data.discoveryIssues} count={data.discoveryIssueCount}
      roots={sources} busy={data.listLoading} retry={() => void data.refreshList(false, true)} />
    <button onClick={() => void data.refreshList(false, true)}>refresh</button>
    <button onClick={() => void data.loadDiff('D:/B', 'same.txt', false)}>diff</button>
    {tree.visibleItems.map(({ node, depth }) => node.kind !== 'repo'
      ? <FolderRow key={node.id} id={node.id} depth={depth} label={node.label} absPath={node.absPath ?? null}
        source={node.kind === 'source-root'} expandable={node.expandable} expanded={tree.expanded.has(node.id)} focused={false}
        getItemProps={tree.getItemProps} onRowClick={tree.onFolderRowClick} onPathDragStart={tree.onPathDragStart} />
      : <button key={node.id} aria-label={`${node.label} ${node.repo!.path}`} onClick={() => tree.commitSelectedPath(node.repo!.path)}>{node.label}</button>)}
  </div>;
}
const snapshot = () => JSON.parse(screen.getByTestId('data').textContent!);
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  errors.mockClear(); patch.mockClear();
  const api = currentApiMock();
  api.override('git.invokeScoped', (_scope: unknown, method: string, ...args: unknown[]) => api.mockOf(`git.${method}`)(...args));
  api.override('git.listRepoLocations', async () => listed([b]));
  api.override('git.status', async () => ({ branch: 'main', tracking: null, ahead: 0, behind: 0, files: [] }));
  api.override('git.repoSummaries', async (paths: string[]) => listed(paths.map(path => ({ ...b, path }))));
});
describe('Git 多根列表与来源', () => {
  it('源文件夹只显示名称，路径留作悬停提示，上下键切换同级选中行', () => {
    const sources = [{ id: 'control', path: 'E:/Projects/workbench/.tmp/long-validation-path/control', label: '验证控制目录' },
      { id: 'metaapp', path: 'D:/MetaApp', label: 'MetaApp' }];
    function SourceFolders(): React.JSX.Element {
      const [selected, setSelected] = useState<string | null>(null);
      const tree = useRepoTree({ selectedPath: selected, setSelectedPath: setSelected, repos: [],
        workspacePath: sources[0].path, workspaceRoots: sources, repoSort: 'name' });
      return <div data-testid="source-folders" className="git-repo-scroll" tabIndex={0} onKeyDown={tree.onRepoTreeKeyDown}>
        {tree.visibleItems.map(({ node, depth }) => <FolderRow key={node.id} id={node.id} depth={depth}
          label={node.label} absPath={node.absPath ?? null} source={node.kind === 'source-root'}
          expandable={node.expandable} expanded={tree.expanded.has(node.id)} focused={tree.focusedId === node.id}
          getItemProps={tree.getItemProps} onRowClick={tree.onFolderRowClick} onPathDragStart={tree.onPathDragStart} />)}
      </div>;
    }
    const view = render(<SourceFolders />);
    const first = screen.getByLabelText(`验证控制目录 ${sources[0].path}`);
    const second = screen.getByLabelText(`MetaApp ${sources[1].path}`);
    expect(first.textContent).toBe('验证控制目录');
    expect(second.textContent).toBe('MetaApp');
    expect(first.title).toBe(sources[0].path);
    expect(second.title).toBe(sources[1].path);
    expect(first.style.paddingLeft).toBe(second.style.paddingLeft);
    expect(view.container.querySelector('.git-source-path')).toBeNull();
    const list = screen.getByTestId('source-folders');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(first.classList.contains('is-active')).toBe(true);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(second.classList.contains('is-active')).toBe(true);
    expect(first.classList.contains('is-active')).toBe(false);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(first.classList.contains('is-active')).toBe(true);
    expect(second.classList.contains('is-active')).toBe(false);
  });
  it('未知摘要的真实仓库行显示省略号，成功摘要才显示分支和变更标记', () => {
    const props = { id: 'repo', depth: 0, name: 'P', path: 'D:/B/P', pinned: false, hidden: false,
      focused: false, expandable: false, expanded: false, getItemProps: () => ({ tabIndex: -1 as const }),
      onToggle: noop, onSelect: noop, onPathDragStart: noop, onTogglePin: noop, onToggleHidden: noop };
    const view = render(<RepoRow {...props} />);
    expect(view.container.querySelector('.git-repo-branch')?.textContent).toBe('…');
    expect(view.container.querySelector('.git-dirty-dot')).toBeNull();
    view.rerender(<RepoRow {...props} dirty branch="main" />);
    expect(view.container.querySelector('.git-repo-branch')?.textContent).toBe('main');
    const name = screen.getByText('P');
    expect(name.nextElementSibling).toBe(screen.getByRole('img', { name: '有未提交改动' }));
    expect(screen.getByRole('treeitem').querySelectorAll('.file-tree-folder')).toHaveLength(1);
  });
  it('手动刷新目录后重新读取保持选中的仓库状态', async () => {
    const api = currentApiMock();
    render(<Harness initial="D:/B" />);
    await waitFor(() => expect(snapshot().status).toBe('main'));
    api.override('git.status', async () => ({ branch: 'manual-new', files: [], ahead: 1, behind: 0 }));
    fireEvent.click(screen.getByText('refresh'));
    await waitFor(() => expect(snapshot().status).toBe('manual-new'));
    expect(snapshot().selected).toBe('D:/B');
  });
  it('目录先发布且可选仓，慢选中状态不阻塞其他仓，未知状态不显示为干净', async () => {
    const api = currentApiMock();
    const child = { path: 'D:/B/Plugins/P', name: 'P', rootId: 'b', workspaceId: 'one' };
    api.override('git.listRepoLocations', async () => listed([{ path: b.path, name: b.name, rootId: 'b', workspaceId: 'one' }, child]));
    let selected!: (value: unknown) => void;
    let background!: (value: GitRepoListResult) => void;
    api.override('git.status', () => new Promise(resolve => { selected = resolve; }));
    api.override('git.repoSummaries', () => new Promise(resolve => { background = resolve; }));
    render(<Harness initial="D:/B" />);
    await waitFor(() => expect(snapshot().paths).toEqual([b.path, child.path]));
    expect(snapshot().loading).toBe(false);
    expect(snapshot().dirty).toEqual([null, null]);
    await waitFor(() => expect(background).toBeTypeOf('function'));
    expect(api.mockOf('git.listReposDetailed')).not.toHaveBeenCalled();
    await act(async () => background(listed([{ ...child, branch: 'plugin', dirty: true }])));
    expect(snapshot().branches).toEqual([null, 'plugin']);
    expect(snapshot().status).toBeUndefined();
    await act(async () => selected({ branch: 'selected', files: [], ahead: 0, behind: 0 }));
    expect(snapshot().dirty).toEqual([false, true]);
  });
  it('手动刷新取代在途后台队列，旧摘要不能覆盖新列表', async () => {
    vi.useFakeTimers();
    try {
      const api = currentApiMock(); const child = { ...b, path: 'D:/B/child', name: 'Child' };
      const locations = [b, child].map(({ path, name, rootId, workspaceId }) => ({ path, name, rootId, workspaceId }));
      api.override('git.listRepoLocations', async () => listed(locations));
      const finish: Array<(value: GitRepoListResult) => void> = [];
      api.override('git.repoSummaries', () => new Promise(resolve => { finish.push(resolve); }));
      render(<Harness active initial="D:/B" />); await act(async () => {});
      expect(finish).toHaveLength(1);
      await act(async () => { fireEvent.click(screen.getByText('refresh')); });
      await act(async () => { finish[0](listed([{ ...child, branch: 'background-old' }])); });
      expect(snapshot().branches[1]).toBeNull();
      await act(async () => { finish[1](listed([{ ...child, branch: 'manual-new' }])); });
      expect(snapshot().branches[1]).toBe('manual-new');
      expect(api.mockOf('git.repoSummaries')).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('后台查询失败保留仓库目录，撤掉未知摘要并显示问题', async () => {
    const api = currentApiMock(); const child = { ...b, path: 'D:/B/child', name: 'Child', dirty: true };
    api.override('git.listRepoLocations', async () => listed([b, child]));
    api.override('git.repoSummaries', async () => ({ ...listed([]), issueCount: 1, issues: [{ workspaceId: 'one',
      rootId: 'b', rootPath: 'D:/B', path: child.path, code: 'GIT_STATUS', message: 'background status failed' }] }));
    render(<Harness active initial="D:/B" />);
    await waitFor(() => expect(snapshot().status).toBe('main'));
    fireEvent.focus(window);
    await screen.findByText('background status failed');
    expect(snapshot().paths).toEqual(['D:/B', child.path]);
    expect(snapshot().dirty[1]).toBeNull();
    expect(snapshot().issues).toBe(1); expect(snapshot().status).toBe('main');
  });
  it('隐藏面板不加载全仓；首次激活才加载，隐藏期间换根也不请求', async () => {
    const api = currentApiMock(); const view = render(<Harness active={false} initial="D:/B" />);
    await act(async () => {});
    expect(api.mockOf('git.listRepoLocations')).not.toHaveBeenCalled();
    expect(api.mockOf('git.status')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('diff'));
    expect(api.mockOf('git.diff')).not.toHaveBeenCalled();
    view.rerender(<Harness active initial="D:/B" />);
    await waitFor(() => expect(snapshot().status).toBe('main'));
    api.mockOf('git.listRepoLocations').mockClear(); api.mockOf('git.status').mockClear();
    view.rerender(<Harness active={false} revision={1} initial="D:/B" />);
    await act(async () => {});
    expect(api.mockOf('git.listRepoLocations')).not.toHaveBeenCalled();
    expect(api.mockOf('git.status')).not.toHaveBeenCalled();
  });
  it('聚焦先读当前仓，后台分批更新其他仓；隐藏后不再派发或接纳晚到摘要', async () => {
    vi.useFakeTimers();
    try {
      const api = currentApiMock();
      const others = [1, 2, 3].map(n => ({ ...b, path: `D:/B/child-${n}`, name: `child-${n}` }));
      api.override('git.listRepoLocations', async () => listed([b, ...others]));
      const view = render(<Harness active initial="D:/B" />); await act(async () => {});
      let status!: (value: unknown) => void; let batch!: (value: GitRepoListResult) => void;
      api.override('git.status', () => new Promise(resolve => { status = resolve; }));
      api.override('git.repoSummaries', () => new Promise(resolve => { batch = resolve; }));
      api.mockOf('git.listRepoLocations').mockClear();
      await act(async () => { fireEvent.focus(window); });
      expect(api.mockOf('git.status')).toHaveBeenCalledWith('D:/B');
      expect(api.mockOf('git.repoSummaries')).toHaveBeenCalledWith(others.slice(0, 2).map(r => r.path));
      await act(async () => { status({ branch: 'selected-new', files: [], ahead: 0, behind: 0 }); });
      expect(snapshot().status).toBe('selected-new'); expect(snapshot().loading).toBe(false);
      expect(api.mockOf('git.listRepoLocations')).not.toHaveBeenCalled();
      expect(api.mockOf('git.repoSummaries')).toHaveBeenCalledWith(others.slice(0, 2).map(r => r.path));
      await act(async () => { batch(listed(others.slice(0, 2).map(r => ({ ...r, branch: 'updated' })))); await vi.advanceTimersByTimeAsync(100); });
      expect(snapshot().branches.slice(1, 3)).toEqual(['updated', 'updated']);
      expect(api.mockOf('git.repoSummaries')).toHaveBeenCalledTimes(2);
      view.rerender(<Harness active={false} initial="D:/B" />);
      await act(async () => { batch(listed([{ ...others[2], branch: 'late' }])); await vi.advanceTimersByTimeAsync(100); });
      expect(snapshot().branches[3]).toBe('main');
      expect(api.mockOf('git.repoSummaries')).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('空路径监听信号按10秒冷却；明确.git信号仍能刷新', async () => {
    vi.useFakeTimers();
    try {
      const api = currentApiMock(); render(<Harness active />);
      await act(async () => {});
      api.mockOf('git.listRepoLocations').mockClear();
      const emit = async (relativePaths: string[]) => {
        await act(async () => { api.emit('fs:changed', { workspaceId: 'one', rootId: 'b', rootsRevision: 0, relativePaths });
          await vi.advanceTimersByTimeAsync(900); });
      };
      await emit(['']);
      expect(api.mockOf('git.listRepoLocations')).toHaveBeenCalledTimes(1);
      await emit(['']);
      expect(api.mockOf('git.listRepoLocations')).toHaveBeenCalledTimes(1);
      await emit(['', '.git/config']);
      expect(api.mockOf('git.listRepoLocations')).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      await emit(['']);
      expect(api.mockOf('git.listRepoLocations')).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('同名根以悬停路径区分；非 Git 默认根不任意选第二根，用户展开并选仓', async () => {
    const api = currentApiMock(); render(<Harness />);
    await waitFor(() => expect(snapshot().paths).toEqual(['D:/B']));
    expect(snapshot().selected).toBeNull();
    expect(api.mockOf('git.listRepoLocations')).toHaveBeenCalledWith(false, 'one', []);
    fireEvent.click(screen.getByLabelText('Same D:/B'));
    await waitFor(() => expect(snapshot().status).toBe('main'));
    expect(api.mockOf('git.status')).toHaveBeenCalledWith('D:/B');
    expect(api.mockOf('git.invokeScoped')).toHaveBeenCalledWith({ workspaceId: 'one', rootsRevision: 0 }, 'status', 'D:/B');
    fireEvent.click(screen.getByLabelText('Same D:/B'));
    expect(screen.queryByRole('button', { name: 'B' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(api.mockOf('git.listRepoLocations')).toHaveBeenLastCalledWith(true, 'one', ['D:/B']));
  });
  it('根版本变化丢弃旧列表，失败后结束 loading 并允许手动重试', async () => {
    const api = currentApiMock(); let finish!: (value: unknown) => void;
    api.override('git.listRepoLocations', () => new Promise(resolve => { finish = resolve; }));
    const view = render(<Harness />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const old = finish;
    api.override('git.listRepoLocations', async () => { throw new Error('offline'); });
    view.rerender(<Harness revision={1} sources={[roots[0]]} />);
    await waitFor(() => expect(snapshot().loading).toBe(false));
    await act(async () => old(listed([b])));
    expect(snapshot().paths).toEqual([]); expect(errors).toHaveBeenCalledWith('Error: offline');
    api.override('git.listRepoLocations', async () => listed([], 'one', 1));
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(api.mockOf('git.listRepoLocations')).toHaveBeenLastCalledWith(true, 'one', []));
  });
  it('切区/根变更立即隐藏旧详情与 diff，晚到结果不能放回', async () => {
    const api = currentApiMock(); let status!: (value: unknown) => void; let diff!: (value: unknown) => void;
    api.override('git.status', () => new Promise(resolve => { status = resolve; }));
    api.override('git.diff', () => new Promise(resolve => { diff = resolve; }));
    const view = render(<Harness initial="D:/B" />);
    await waitFor(() => expect(status).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'diff' }));
    const oldStatus = status;
    api.override('git.listRepoLocations', async () => listed([], 'two', 1));
    view.rerender(<Harness wsId="two" revision={1} sources={[roots[0]]} />);
    expect(snapshot().paths).toEqual([]); expect(snapshot().status).toBeUndefined(); expect(snapshot().diff).toBe('');
    await act(async () => { oldStatus({ branch: 'OLD', files: [] }); diff({ diff: 'OLD DIFF' }); });
    expect(snapshot().status).toBeUndefined(); expect(snapshot().diff).toBe('');
    await waitFor(() => expect(snapshot().loading).toBe(false));
  });
  it('文件事件按 rootId/版本定位第二根；第一根、旧版及无来源事件不刷该仓', async () => {
    vi.useFakeTimers();
    try {
      const api = currentApiMock(); render(<Harness initial="D:/B" active />);
      await act(async () => {});
      api.mockOf('git.status').mockClear();
      const emit = async (rootId?: string, rootsRevision = 0) => {
        await act(async () => { api.emit('fs:changed', { workspaceId: 'one', rootId, rootsRevision, relativePaths: ['same.txt'] });
          await vi.advanceTimersByTimeAsync(300); });
      };
      await emit('a'); await emit('b', 9); await emit(undefined);
      expect(api.mockOf('git.status')).not.toHaveBeenCalled();
      await emit('b'); expect(api.mockOf('git.status')).toHaveBeenCalledWith('D:/B');
    } finally { vi.useRealTimers(); }
  });
  it('卸载后慢列表失败不弹错误或写选仓偏好', async () => {
    const api = currentApiMock(); let reject!: (error: Error) => void;
    api.override('git.listRepoLocations', () => new Promise((_resolve, fail) => { reject = fail; }));
    const view = render(<Harness />); view.unmount();
    await act(async () => reject(new Error('late')));
    expect(errors).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
  });
  it('快速切仓使旧 status 失效，不能把旧仓的分支放到新仓', async () => {
    const api = currentApiMock(); let old!: (value: unknown) => void;
    api.override('git.listRepoLocations', async () => listed([{ ...b, path: 'E:/A', name: 'A', rootId: 'a' }, b]));
    api.override('git.status', (path: string) => path === 'E:/A' ? new Promise(resolve => { old = resolve; })
      : Promise.resolve({ branch: 'B-new', files: [] }));
    render(<Harness initial="E:/A" />);
    await waitFor(() => expect(old).toBeTypeOf('function'));
    fireEvent.click(screen.getByLabelText('Same D:/B'));
    await waitFor(() => expect(snapshot().status).toBe('B-new'));
    await act(async () => old({ branch: 'A-old', files: [] }));
    expect(snapshot().status).toBe('B-new');
  });
  it('部分目录失败仍展示可用仓，重试扫描恢复；按钮在途禁用', async () => {
    const api = currentApiMock();
    const partial = { ...listed([b]), issues: [{ workspaceId: 'one', rootId: 'a', rootPath: 'E:/A', path: 'E:/A/Content', code: 'EACCES', message: 'denied' }], issueCount: 1 };
    api.override('git.listRepoLocations', async () => partial);
    render(<Harness />);
    expect(await screen.findByText('仓库扫描未完成（1 处）')).toBeTruthy();
    expect(screen.getByText('E:/A/Content')).toBeTruthy();
    expect(screen.getByText('无法读取目录，请检查访问权限')).toBeTruthy();
    expect(snapshot().paths).toEqual(['D:/B']);
    let finish!: (value: GitRepoListResult) => void;
    api.override('git.listRepoLocations', () => new Promise(resolve => { finish = resolve; }));
    const retry = screen.getByRole('button', { name: '重试扫描' }); fireEvent.click(retry);
    await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(true));
    expect(api.mockOf('git.listRepoLocations')).toHaveBeenLastCalledWith(true, 'one', []);
    await act(async () => finish(listed([b])));
    await waitFor(() => expect(screen.queryByText('仓库扫描未完成（1 处）')).toBeNull());
    expect(snapshot().issues).toBe(0); expect(snapshot().paths).toEqual(['D:/B']);
  });
  it('根版本切换立即移除旧失败提示，晚到失败结果不恢复', async () => {
    const api = currentApiMock(); let finish!: (value: GitRepoListResult) => void;
    api.override('git.listRepoLocations', () => new Promise(resolve => { finish = resolve; }));
    const view = render(<Harness />);
    await waitFor(() => expect(finish).toBeTypeOf('function')); const old = finish;
    api.override('git.listRepoLocations', async () => listed([b], 'one', 1));
    view.rerender(<Harness revision={1} />);
    await act(async () => old({ ...listed([]), issueCount: 1, issues: [{ workspaceId: 'one', rootId: 'a', rootPath: 'OLD', path: 'OLD', message: 'old failure' }] }));
    await waitFor(() => expect(snapshot().loading).toBe(false));
    expect(screen.queryByText('OLD')).toBeNull(); expect(snapshot().issues).toBe(0);
  });
  it('列表失败撤销当前成员，晚到的 status/diff 不能恢复旧详情', async () => {
    const api = currentApiMock(); let status!: (value: unknown) => void; let diff!: (value: unknown) => void;
    api.override('git.status', () => new Promise(resolve => { status = resolve; }));
    api.override('git.diff', () => new Promise(resolve => { diff = resolve; }));
    render(<Harness initial="D:/B" />);
    await waitFor(() => expect(status).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'diff' }));
    api.override('git.listRepoLocations', async () => { throw new Error('failed list'); });
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(snapshot().paths).toEqual([]));
    expect(snapshot().diffLoading).toBe(false);
    await act(async () => { status({ branch: 'OLD', files: [] }); diff({ diff: 'OLD DIFF' }); });
    expect(snapshot().status).toBeUndefined(); expect(snapshot().diff).toBe('');
    api.override('git.listRepoLocations', async () => listed([b]));
    api.override('git.status', async () => ({ branch: 'RECOVERED', files: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(snapshot().status).toBe('RECOVERED'));
    expect(snapshot().diff).toBe(''); expect(snapshot().diffLoading).toBe(false);
  });
});
