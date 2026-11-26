/**
 * Git 仓库列表多选交互：
 * - 修饰键点击只改选区（不切仓、不展开）；普通点击保持选中仓库行为
 * - 行右键：多选=批量隐藏/固定所选；单选=与行内按钮同义的菜单
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitRepoSummary } from '../../src/shared/types';
import { RepoListPane } from '../../src/renderer/src/panels/gitpanel/RepoListPane';
import { useRepoTree, type GitRepoTreeApi } from '../../src/renderer/src/panels/gitpanel/useRepoTree';

const REPOS: GitRepoSummary[] = [
  { path: 'E:/A/r1', name: 'r1' },
  { path: 'E:/A/r2', name: 'r2' }
];

function makeRepoTree(): GitRepoTreeApi {
  return {
    visibleItems: REPOS.map((repo) => ({
      node: {
        id: `repo:${repo.path}`,
        parentId: null,
        kind: 'repo' as const,
        label: repo.name,
        expandable: false,
        children: [],
        repo
      },
      depth: 0
    })),
    expanded: new Set<string>(),
    focusedId: null,
    setFocusedId: vi.fn(),
    treeRows: [],
    chainById: new Map(),
    visibleNodes: [],
    onToggleExpand: vi.fn(),
    onFolderRowClick: vi.fn(),
    onSelectRepo: vi.fn(),
    commitSelectedPath: vi.fn(),
    scheduleSelectedPath: vi.fn(),
    onRepoTreeKeyDown: vi.fn(),
    onNavSelect: vi.fn(),
    getItemProps: () => ({ tabIndex: -1 as const }),
    onPathDragStart: vi.fn()
  };
}

let hideRepos: ReturnType<typeof vi.fn>;
let setReposPinned: ReturnType<typeof vi.fn>;
let toggleHidden: ReturnType<typeof vi.fn>;
let onSelectRepo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  hideRepos = vi.fn();
  setReposPinned = vi.fn();
  toggleHidden = vi.fn();
  onSelectRepo = vi.fn();
});

function pane(repoTree: GitRepoTreeApi, repos = REPOS): React.JSX.Element {
  return (
    <RepoListPane
      repoTree={repoTree}
      repos={repos}
      displayedRepos={repos}
      reposAfterHidden={repos}
      searchOpen={false}
      searchInputRef={{ current: null }}
      onSearchQuery={() => {}}
      closeSearch={() => {}}
      setSearchOpen={() => {}}
      searchQuery=""
      busy={false}
      listLoading={false}
      refreshRepos={() => {}}
      hiddenCount={0}
      hiddenView="exclude"
      persistHiddenView={() => {}}
      setHideBtnMenu={() => {}}
      sortMenuRef={{ current: null }}
      sortMenuOpen={false}
      setSortMenuOpen={() => {}}
      repoSort="name"
      changeSort={() => {}}
      pinnedKeys={new Set<string>()}
      hiddenKeys={new Set<string>()}
      togglePin={vi.fn()}
      toggleHidden={toggleHidden}
      hideRepos={hideRepos}
      setReposPinned={setReposPinned}
      pathKey={(p: string) => p.toLowerCase()}
    />
  );
}

const renderPane = () => render(pane({ ...makeRepoTree(), onSelectRepo }));

it('同一根仓行可打开 Git 并展开，方向键保持真实层级与折叠状态', async () => {
  const root = { path: 'E:/A', name: 'A' };
  const nested = { path: 'E:/A/Plugins/Nested', name: 'Nested' };
  const task = { path: 'E:/A/linked', name: 'linked', worktree: true };
  function Tree({ repos }: { repos: GitRepoSummary[] }): React.JSX.Element {
    const [selected, setSelected] = React.useState<string | null>(nested.path);
    const tree = useRepoTree({ selectedPath: selected, setSelectedPath: setSelected, repos, workspacePath: root.path, repoSort: 'name' });
    return <><output data-testid="selected-repo">{selected}</output>{pane(tree, repos)}</>;
  }
  const repos = [root, nested, task];
  const view = render(<Tree repos={repos} />);
  const rootRow = screen.getByTitle(root.path);
  const child = screen.getByTitle(nested.path);
  const plugin = screen.getByTitle('E:/A/Plugins');
  expect([rootRow, plugin, child].map(row => row.getAttribute('aria-level'))).toEqual(['1', '2', '3']);
  expect(screen.queryByTitle(task.path)).toBeNull();
  const tree = screen.getByRole('tree', { name: '仓库' });
  fireEvent.keyDown(tree, { key: 'Home' });
  fireEvent.keyDown(tree, { key: 'ArrowLeft' });
  expect(rootRow.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByTitle(nested.path)).toBeNull();
  view.rerender(<Tree repos={[{ ...root, dirty: true }, nested, task]} />);
  expect(rootRow.getAttribute('aria-expanded')).toBe('false');
  fireEvent.keyDown(tree, { key: 'Enter' });
  expect(screen.getByTestId('selected-repo').textContent).toBe(root.path);
  expect(rootRow.getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(tree, { key: 'F10', shiftKey: true });
  fireEvent.click(await screen.findByText('隐藏此仓库'));
  expect(toggleHidden).toHaveBeenCalledWith(root.path);
});

describe('Git 仓库列表多选', () => {
  it('Ctrl+点击切换选区且不切仓；普通点击保持选中行为', async () => {
    renderPane();
    const r1 = await screen.findByTitle('E:/A/r1');
    const r2 = await screen.findByTitle('E:/A/r2');

    fireEvent.click(r1, { ctrlKey: true });
    fireEvent.click(r2, { ctrlKey: true });
    expect(r1.className).toContain('is-multiselected');
    expect(r2.className).toContain('is-multiselected');
    expect(onSelectRepo).not.toHaveBeenCalled();

    fireEvent.click(r1);
    expect(onSelectRepo).toHaveBeenCalledWith('repo:E:/A/r1', 'E:/A/r1');
    expect(r1.className).not.toContain('is-multiselected');
  });

  it('多选右键 → 隐藏所选（批量一次调用）', async () => {
    renderPane();
    fireEvent.click(await screen.findByTitle('E:/A/r1'), { ctrlKey: true });
    fireEvent.click(await screen.findByTitle('E:/A/r2'), { ctrlKey: true });

    fireEvent.contextMenu(screen.getByTitle('E:/A/r1'));
    fireEvent.click(await screen.findByText('隐藏所选（2 个）'));
    expect(hideRepos).toHaveBeenCalledTimes(1);
    expect(hideRepos).toHaveBeenCalledWith(['E:/A/r1', 'E:/A/r2'], true);
  });

  it('多选右键 → 固定所选', async () => {
    renderPane();
    fireEvent.click(await screen.findByTitle('E:/A/r1'), { ctrlKey: true });
    fireEvent.click(await screen.findByTitle('E:/A/r2'), { ctrlKey: true });

    fireEvent.contextMenu(screen.getByTitle('E:/A/r1'));
    fireEvent.click(await screen.findByText('固定所选（2 个）'));
    expect(setReposPinned).toHaveBeenCalledWith(['E:/A/r1', 'E:/A/r2'], true);
  });

  it('单行右键（无选区）→ 隐藏此仓库（与行内按钮同义）', async () => {
    renderPane();
    fireEvent.contextMenu(await screen.findByTitle('E:/A/r1'));
    fireEvent.click(await screen.findByText('隐藏此仓库'));
    expect(toggleHidden).toHaveBeenCalledWith('E:/A/r1');
  });
});
