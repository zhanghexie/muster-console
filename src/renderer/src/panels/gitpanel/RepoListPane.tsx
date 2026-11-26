import { BrandLoading } from '../../components/BrandLoader';
/**
 * GitPanel 仓库列表（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，原样迁出）：
 * 工具栏（搜索/添加/隐藏眼/排序菜单）与仓库树。无 memo：重渲时机与原整面板渲染保持一致。
 * 多选（Ctrl/⌘ 点选、Shift 范围）+ 行右键菜单（单项=与行内按钮同义；多选=批量隐藏/置顶）。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitRepoSummary } from '../../../../shared/types';
import { cycleHiddenViewExcludeInclude, type HiddenView } from '../../../../shared/workspaceUiPersist';
import { IconEye, IconRefresh, IconSort } from '../../components/icons';
import { type ContextMenuPoint, ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { GitRepoSearchInput } from '../GitRepoSearchInput';
import { useListSelection } from '../../hooks/useListSelection';
import { FolderRow, RepoRow } from './GitRepoRows';
import { sortLabel, type RepoSort } from './gitPanelPure';
import type { GitRepoTreeApi } from './useRepoTree';

export function RepoListPane({
  repoTree,
  repos,
  onOpenWorktreeDetails,
  discoveryIncomplete = false,
  displayedRepos,
  reposAfterHidden,
  searchOpen,
  searchInputRef,
  onSearchQuery,
  closeSearch,
  setSearchOpen,
  searchQuery,
  busy,
  listLoading,
  refreshRepos,
  hiddenCount,
  hiddenView,
  persistHiddenView,
  setHideBtnMenu,
  sortMenuRef,
  sortMenuOpen,
  setSortMenuOpen,
  repoSort,
  changeSort,
  pinnedKeys,
  hiddenKeys,
  togglePin,
  toggleHidden,
  hideRepos,
  setReposPinned,
  pathKey
}: {
  repoTree: GitRepoTreeApi;
  repos: GitRepoSummary[];
  onOpenWorktreeDetails?: () => void;
  discoveryIncomplete?: boolean;
  displayedRepos: GitRepoSummary[];
  reposAfterHidden: GitRepoSummary[];
  searchOpen: boolean;
  searchInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onSearchQuery: (q: string) => void;
  closeSearch: () => void;
  setSearchOpen: (open: boolean) => void;
  searchQuery: string;
  busy: boolean;
  listLoading: boolean;
  refreshRepos: () => void;
  hiddenCount: number;
  hiddenView: HiddenView;
  persistHiddenView: (next: HiddenView) => void;
  setHideBtnMenu: React.Dispatch<React.SetStateAction<ContextMenuPoint | null>>;
  sortMenuRef: React.MutableRefObject<HTMLDivElement | null>;
  sortMenuOpen: boolean;
  setSortMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  repoSort: RepoSort;
  changeSort: (sort: RepoSort) => void;
  pinnedKeys: Set<string>;
  hiddenKeys: Set<string>;
  togglePin: (repoPath: string) => void;
  toggleHidden: (repoPath: string) => void;
  hideRepos: (repoPaths: string[], hide: boolean) => void;
  setReposPinned: (repoPaths: string[], pinned: boolean) => void;
  pathKey: (p: string) => string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const {
    visibleItems,
    expanded,
    focusedId,
    getItemProps,
    onRepoTreeKeyDown,
    onNavSelect,
    onFolderRowClick,
    onPathDragStart,
    onSelectRepo,
    onToggleExpand
  } = repoTree;
  const showTree = displayedRepos.length > 0 && visibleItems.length > 0;

  // 多选：目录行参与范围序，批量动作只统计仓库行
  const selectionOrderedIds = useMemo(() => visibleItems.map((x) => x.node.id), [visibleItems]);
  const selection = useListSelection({ orderedIds: selectionOrderedIds });

  /** 行点击修饰键分流：返回 true = 已作为选区操作消费（不切仓、不折叠） */
  const handleModifierClick = useCallback(
    (id: string, e: React.MouseEvent): boolean => selection.click(id, e) !== 'plain',
    [selection.click]
  );

  const itemById = useMemo(() => {
    const map = new Map(visibleItems.map((x) => [x.node.id, x]));
    return map;
  }, [visibleItems]);

  /** 拖动选区内行 = 拖所有选中仓库路径（按可见行序）；否则只拖该行 */
  const handlePathDragStart = useCallback(
    (e: React.DragEvent, absPaths: string[]) => {
      const abs = absPaths[0] ?? '';
      const dragMulti = visibleItems.some(({ node }) => {
        const p = node.kind === 'repo' && node.repo ? node.repo.path : node.absPath;
        return p === abs && selection.isSelected(node.id) && selection.selectedIds.size > 1;
      });
      if (!dragMulti) {
        onPathDragStart(e, absPaths);
        return;
      }
      const paths: string[] = [];
      for (const { node } of visibleItems) {
        if (!selection.isSelected(node.id)) continue;
        const p = node.kind === 'repo' && node.repo ? node.repo.path : node.absPath;
        if (p) paths.push(p);
      }
      onPathDragStart(e, paths.length > 0 ? paths : absPaths);
    },
    [visibleItems, selection, onPathDragStart]
  );

  /** 行右键：落在多选区内 → 菜单作用于整选区（仅仓库行计入动作）；否则塌缩为该行 */
  const [ctx, setCtx] = useState<ContextMenuPoint & { repoPaths: string[] } | null>(null);
  const openRepoCtx = useCallback(
    (id: string, point: ContextMenuPoint) => {
      const node = itemById.get(id)?.node;
      if (!node || node.kind !== 'repo' || !node.repo) return;
      const aggregate = selection.isSelected(id) && selection.selectedIds.size > 1;
      const repoPaths = aggregate
        ? visibleItems
            .filter(({ node: n }) => n.kind === 'repo' && n.repo && selection.isSelected(n.id))
            .map(({ node: n }) => n.repo!.path)
        : [node.repo.path];
      setCtx({ ...point, repoPaths });
    },
    [itemById, selection, visibleItems]
  );

  const ctxItems = useMemo((): ContextMenuItem[] => {
    if (!ctx) return [];
    const items: ContextMenuItem[] = [];
    if (ctx.repoPaths.length === 1) {
      const path = ctx.repoPaths[0]!;
      items.push({ id: 'reveal', label: t('在资源管理器中打开') });
      items.push({
        id: 'pin',
        label: pinnedKeys.has(pathKey(path)) ? t('取消置顶') : t('置顶')
      });
      items.push({
        id: 'hide',
        label: hiddenKeys.has(pathKey(path)) ? t('显示此仓库') : t('隐藏此仓库')
      });
      return items;
    }
    const n = ctx.repoPaths.length;
    const allPinned = ctx.repoPaths.every((p) => pinnedKeys.has(pathKey(p)));
    const anyPinned = ctx.repoPaths.some((p) => pinnedKeys.has(pathKey(p)));
    if (!allPinned) items.push({ id: 'pin-multi', label: t('固定所选（{{n}} 个）', { n }) });
    if (anyPinned) items.push({ id: 'unpin-multi', label: t('取消固定所选（{{n}} 个）', { n }) });
    items.push({ id: 'hide-multi', label: t('隐藏所选（{{n}} 个）', { n }) });
    return items;
  }, [ctx, pinnedKeys, hiddenKeys, pathKey, t]);

  const onCtxSelect = useCallback(
    (id: string) => {
      if (!ctx) return;
      if (id === 'reveal' && ctx.repoPaths.length === 1) {
        void window.api.shell.revealPath(ctx.repoPaths[0]!);
      } else if (id === 'pin' && ctx.repoPaths.length === 1) {
        togglePin(ctx.repoPaths[0]!);
      } else if (id === 'hide' && ctx.repoPaths.length === 1) {
        toggleHidden(ctx.repoPaths[0]!);
      } else if (id === 'pin-multi') {
        setReposPinned(ctx.repoPaths, true);
      } else if (id === 'unpin-multi') {
        setReposPinned(ctx.repoPaths, false);
      } else if (id === 'hide-multi') {
        hideRepos(ctx.repoPaths, true);
        selection.clear();
      }
      setCtx(null);
    },
    [ctx, togglePin, toggleHidden, setReposPinned, hideRepos, selection]
  );

  const handleRepoTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (focusedId && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
        const row = e.currentTarget.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]');
        if (row) {
          e.preventDefault();
          const rect = row.getBoundingClientRect();
          openRepoCtx(focusedId, { x: rect.left, y: rect.bottom, anchor: row });
        }
        return;
      }
      // 多选键（Ctrl+A / Esc / Shift+↑↓）优先；Shift+↑↓ 同时移焦点并扩选区
      if (selection.handleKeyDown(e, { currentId: focusedId, onMoveFocus: onNavSelect })) return;
      onRepoTreeKeyDown(e);
    },
    [selection, focusedId, onNavSelect, onRepoTreeKeyDown, openRepoCtx]
  );

  return (
    <div className="git-repo-list">
      <div className="git-repo-toolbar">
        {searchOpen ? (
          <GitRepoSearchInput
            inputRef={searchInputRef}
            onQueryChange={onSearchQuery}
            onClose={closeSearch}
            matchCount={displayedRepos.length}
            matchTotal={reposAfterHidden.length}
          />
        ) : (
          <>
            <span className="git-col-title git-repo-toolbar-label">{t('仓库')}</span>
            <div className="git-repo-toolbar-actions">
              <button
                type="button"
                className="git-btn ghost tiny"
                aria-label={t('刷新仓库列表')}
                title={t('重新发现仓库及嵌套仓；新增、删除或修复仓库后刷新')}
                disabled={busy || listLoading}
                onClick={refreshRepos}
              >
                {listLoading ? <BrandLoading size={18} /> : <IconRefresh />}
              </button>
              <button
                type="button"
                className="git-btn ghost tiny"
                aria-label={t('搜索')}
                onClick={() => setSearchOpen(true)}
              >
                ⌕
              </button>
              {hiddenCount > 0 || hiddenView !== 'exclude' ? (
                <button
                  type="button"
                  className={`git-btn ghost tiny${hiddenView !== 'exclude' ? ' is-on' : ''}`}
                  title={
                    hiddenView === 'only'
                      ? t('只显示已隐藏的仓库（右键更多）')
                      : hiddenView === 'include'
                        ? t('不显示已隐藏的仓库（右键更多）')
                        : t('显示已隐藏的仓库（{{n}}，右键更多）', { n: hiddenCount })
                  }
                  onClick={() => persistHiddenView(cycleHiddenViewExcludeInclude(hiddenView))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setHideBtnMenu({ x: e.clientX, y: e.clientY, anchor: e.currentTarget });
                  }}
                >
                  <IconEye />
                  {hiddenCount > 1 ? (
                    <span className="git-toolbar-count">{hiddenCount}</span>
                  ) : null}
                </button>
              ) : null}
              <div className="git-sort-wrap" ref={sortMenuRef}>
                <button
                  type="button"
                  className={`git-btn ghost tiny${sortMenuOpen ? ' is-on' : ''}`}
                  title={t('排序：{{label}}', { label: sortLabel(repoSort, t) })}
            onClick={() => setSortMenuOpen((v) => !v)}
          >
            <IconSort />
          </button>
                {sortMenuOpen ? (
                  <div className="git-sort-menu">
                    {(
                      [
                        ['name', t('名称')],
                        ['recent', t('最近修改')],
                        ['dirty', t('未提交变动')]
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        className={`git-sort-option${repoSort === key ? ' is-active' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => changeSort(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
      <div
        className="git-repo-scroll"
        tabIndex={showTree ? 0 : undefined}
        role={showTree ? 'tree' : undefined}
        aria-label={showTree ? t('仓库') : undefined}
        aria-multiselectable={showTree ? true : undefined}
        onKeyDown={handleRepoTreeKeyDown}
      >
        {repos.length === 0 ? (
          <div className="empty-hint">
            {!listLoading && onOpenWorktreeDetails ? (
              <button type="button" className="git-btn tiny" onClick={onOpenWorktreeDetails}>{t('打开 Git 详情')}</button>
            ) : listLoading ? t('扫描中…') : discoveryIncomplete ? t('仓库扫描未完成') : t('workspace 下未找到仓库')}
          </div>
        ) : displayedRepos.length === 0 ? (
          <div className="empty-hint">
            {hiddenView === 'only' && hiddenCount === 0 ? t('没有已隐藏的仓库') : hiddenCount > 0 && !searchQuery.trim()
              ? t('已隐藏 {{n}} 个仓库，点上方眼睛图标可显示', { n: hiddenCount })
              : t('无匹配仓库')}
          </div>
        ) : (
          visibleItems.map(({ node, depth }) => {
            if (node.kind !== 'repo' || !node.repo) {
              return (
                <FolderRow
                  key={node.id}
                  id={node.id}
                  depth={depth}
                  label={node.kind === 'external-root' ? t(node.label ?? '') : node.label}
                  source={node.sourceRoot}
                  absPath={node.kind === 'folder' || node.kind === 'source-root' ? (node.absPath ?? null) : null}
                  expandable={node.expandable}
                  expanded={expanded.has(node.id)}
                  focused={focusedId === node.id}
                  getItemProps={getItemProps}
                  onRowClick={onFolderRowClick}
                  onModifierClick={handleModifierClick}
                  isMultiselected={selection.isSelected}
                  onPathDragStart={handlePathDragStart}
                />
              );
            }

            const r = node.repo;
            return (
              <RepoRow
                key={node.id}
                id={node.id}
                depth={depth}
                name={node.label}
                path={r.path}
                branch={r.branch}
                ahead={r.ahead}
                behind={r.behind}
                dirty={r.dirty}
                source={node.sourceRoot}
                pinned={pinnedKeys.has(pathKey(r.path))}
                hidden={hiddenKeys.has(pathKey(r.path))}
                focused={focusedId === node.id}
                expandable={node.expandable}
                expanded={expanded.has(node.id)}
                getItemProps={getItemProps}
                onToggle={onToggleExpand}
                onSelect={onSelectRepo}
                onPathDragStart={handlePathDragStart}
                onTogglePin={togglePin}
                onToggleHidden={toggleHidden}
                onModifierClick={handleModifierClick}
                isMultiselected={selection.isSelected}
                onContextMenu={openRepoCtx}
              />
            );
          })
        )}
      </div>
      {ctx ? (
        <ContextMenu x={ctx.x} y={ctx.y} anchor={ctx.anchor} items={ctxItems} onSelect={onCtxSelect} onClose={() => setCtx(null)} />
      ) : null}
    </div>
  );
}
