/**
 * ④ 列表/侧栏折叠开关统一为面板折叠图标（IconPanelToggle，2026-10-07 报单④；
 * 取代 10-06 的裸 chevron ▸/▾）。断言：文件/仓库/浏览器标签栏三处 + 顶栏右侧栏
 * 按钮均渲染同源 svg.icon-panel-toggle（data-placement/data-open 两形态）、
 * aria-expanded 随开合翻转、点击切换（files-panel-body.tree-collapsed /
 * toggleRepoList / toggleTabbar）。
 */
import React, { forwardRef, useImperativeHandle } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock } from './helpers/api-mock';
import type { WorkspaceInfo } from '../../src/shared/types';
import { defaultWorkspaceFileConfig } from '../../src/shared/metaAgent';

const state = vi.hoisted(() => ({
  activeWorkspaceId: 'ws',
  workspaces: [] as WorkspaceInfo[],
  flashTip: vi.fn(), pushRight: vi.fn(), flush: vi.fn(async () => {}), patch: vi.fn(async () => ({}))
}));
vi.mock('../../src/renderer/src/store', () => ({
  useWorkspaceStore: () => ({ activeWorkspaceId: state.activeWorkspaceId, workspaces: state.workspaces }),
  useUiStore: () => ({ flashTip: state.flashTip, openCommandPalette: vi.fn() })
}));
vi.mock('../../src/renderer/src/hooks/useWorkspaceFile', () => ({ useWorkspaceFile: () => ({ cfg: {}, ready: true, patch: state.patch }) }));
vi.mock('../../src/renderer/src/panelHistory', () => ({ useHistoryWsId: () => 'ws', usePanelHistory: () => ({ pushRight: state.pushRight }) }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useKeybinding: () => {}, useChordLabel: () => '', useOverlayDismiss: () => {} }));
vi.mock('../../src/renderer/src/components/FileEditor', () => ({
  FileEditor: forwardRef((_props: unknown, ref) => {
    useImperativeHandle(ref, () => ({ flush: state.flush, focusFindBar: vi.fn() }));
    return <div data-testid="editor" />;
  })
}));
import { FilesPanel } from '../../src/renderer/src/panels/FilesPanel';
import { GitPanelHeader } from '../../src/renderer/src/panels/gitpanel/GitPanelHeader';
import { RightWorkspaceToolbar } from '../../src/renderer/src/components/RightWorkspaceToolbar';

beforeEach(() => {
  state.activeWorkspaceId = 'ws';
  state.workspaces = [{ id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0, defaultRootId: 'a', controlRoot: 'E:/A', rootsRevision: 0,
    roots: [{ id: 'a', path: 'E:/A', label: '工程 A' }] }];
  state.flashTip.mockClear(); state.pushRight.mockClear(); state.flush.mockReset(); state.flush.mockResolvedValue(undefined);
  Element.prototype.scrollIntoView = vi.fn();
  const api = createApiMock();
  window.api = api.api;
  api.override('fs.listTreeDirRef', async () => ({ entries: [] }));
  api.override('fs.statRef', async () => ({ ok: true, isDirectory: false, isFile: true }));
  api.override('fs.resolveRef', async () => ({ ok: false, error: 'no' }));
});

describe('文件列表开关面板图标', () => {
  it('图标按钮承载开合状态：展开 ▾（aria-expanded=true），点击收起翻转', async () => {
    render(<FilesPanel active sideTab="files" onSideTab={vi.fn()} />);
    const btn = await waitFor(() => {
      const el = screen.getByTitle('关闭文件列表');
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    expect(btn.className).toContain('is-icon');
    expect(btn.className).toContain('is-open');
    const icon = btn.querySelector('svg.icon-panel-toggle')!;
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('data-placement')).toBe('top');
    expect(icon.getAttribute('data-open')).toBe('true');
    expect(btn.textContent).toBe(''); // 纯图标，不再渲染文字
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.files-panel-body.tree-collapsed')).toBeNull();

    fireEvent.click(btn);
    await waitFor(() => {
      expect(document.querySelector('.files-panel-body.tree-collapsed')).toBeTruthy();
    });
    expect(btn.className).not.toContain('is-open');
    expect(btn.querySelector('svg.icon-panel-toggle')?.getAttribute('data-open')).toBe('false');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('title')).toBe('打开文件列表');
    expect(btn.getAttribute('aria-label')).toBe('打开文件列表');
  });
});

describe('仓库列表开关面板图标', () => {
  const headerProps = (over: Partial<Parameters<typeof GitPanelHeader>[0]> = {}) => ({
    activeSessionWorktree: null,
    commitSelectedPath: vi.fn(),
    followSessionRepo: false,
    toggleFollowSessionRepo: vi.fn(),
    repoListOpen: true,
    selectedRepoName: null,
    selectedPath: null,
    repoQuickOpen: false,
    setRepoQuickOpen: vi.fn(),
    repoQuickRef: { current: null },
    displayedRepos: [],
    setSelectedPath: vi.fn(),
    setRepoListOpen: vi.fn(),
    patch: vi.fn(async () => ({ ok: true, config: defaultWorkspaceFileConfig() })),
    listLoading: false,
    busy: false,
    refreshList: vi.fn(),
    toggleRepoList: vi.fn(),
    showNoRepoState: false,
    showNotGitState: false,
    ...over
  });

  it('图标按钮 + aria-expanded，点击走 toggleRepoList', () => {
    const toggle = vi.fn();
    render(<GitPanelHeader {...headerProps({ toggleRepoList: toggle })} />);
    const btn = screen.getByTitle('隐藏仓库列表') as HTMLButtonElement;
    expect(btn.className).toContain('is-icon');
    expect(btn.className).toContain('is-open');
    const icon = btn.querySelector('svg.icon-panel-toggle')!;
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('data-placement')).toBe('top');
    expect(icon.getAttribute('data-open')).toBe('true');
    expect(btn.textContent).toBe('');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('收起态无 is-open（chevron 旋成 ▸）；无仓库时禁用', () => {
    render(<GitPanelHeader {...headerProps({ repoListOpen: false, showNoRepoState: true })} />);
    const btn = screen.getByTitle('打开仓库列表') as HTMLButtonElement;
    expect(btn.className).not.toContain('is-open');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.disabled).toBe(true);
  });
});

describe('右侧工具条资源面板开关图标', () => {
  const toolbarProps = (over: Partial<Parameters<typeof RightWorkspaceToolbar>[0]> = {}) => ({
    tabs: [],
    current: undefined,
    panel: 'files' as const,
    collapsed: false,
    backDepth: 0,
    forwardDepth: 0,
    onHistory: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onAction: vi.fn(),
    onMove: vi.fn(),
    onResource: vi.fn(),
    onCollapse: vi.fn(),
    ...over
  });

  // 右缘竖条里的收起按钮用 side 朝向（即 top 图标顺时针 90°：分隔线在右、
  // 展开 › 指右=向右缘收、收起 ‹ 指左=向左展开），与顶栏右栏开关同源同向。
  it('placement=side，open/aria-expanded 随折叠态翻转，点击走 onCollapse', () => {
    const collapse = vi.fn();
    const { rerender } = render(<RightWorkspaceToolbar {...toolbarProps({ onCollapse: collapse })} />);
    const btn = screen.getByTitle('收起资源面板') as HTMLButtonElement;
    const icon = btn.querySelector('svg.icon-panel-toggle')!;
    expect(icon.getAttribute('data-placement')).toBe('side');
    expect(icon.getAttribute('data-open')).toBe('true');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn);
    expect(collapse).toHaveBeenCalledTimes(1);

    rerender(<RightWorkspaceToolbar {...toolbarProps({ collapsed: true })} />);
    const folded = screen.getByTitle('展开资源面板') as HTMLButtonElement;
    const foldedIcon = folded.querySelector('svg.icon-panel-toggle')!;
    expect(foldedIcon.getAttribute('data-placement')).toBe('side');
    expect(foldedIcon.getAttribute('data-open')).toBe('false');
    expect(folded.getAttribute('aria-expanded')).toBe('false');
  });
});
