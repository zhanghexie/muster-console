/**
 * GitPanel 仓库树交互层（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，行为保持）：
 * 展开/聚焦 state、树构建与扁平化、选中自动展开祖先、方向键导航、防抖选中、HTML5 拖拽。
 * 原面板文件内的对应片段原样迁出；chainById 只随树结构变化（若随 flatten 走，
 * 每次 expand/collapse 都换新引用，「选中仓自动展开祖先」effect 会重跑，把用户刚收起的祖先又展开）。
 */
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { GitRepoSummary, WorkspaceRoot } from '../../../../shared/types';
import { setPathDragData } from '../../../../shared/fileDropPaths';
import {
  buildChainById,
  buildGitRepoTree,
  flattenGitRepoTree
} from '../../../../shared/gitRepoTree';
import { pathKey } from '../../../../shared/pathKey';
import { useTreeKeyboardNav } from '../../hooks/useTreeKeyboardNav';
import { DETAIL_SELECT_DEBOUNCE_MS, type RepoSort } from './gitPanelPure';

type GitRepoTreeNode = ReturnType<typeof buildGitRepoTree>[number];

export type GitRepoTreeApi = {
  expanded: Set<string>;
  focusedId: string | null;
  setFocusedId: React.Dispatch<React.SetStateAction<string | null>>;
  visibleItems: { node: GitRepoTreeNode; depth: number }[];
  treeRows: ReturnType<typeof flattenGitRepoTree>['rows'];
  chainById: Map<string, string[]>;
  visibleNodes: GitRepoTreeNode[];
  onToggleExpand: (id: string) => void;
  onFolderRowClick: (id: string) => void;
  onSelectRepo: (id: string, repoPath: string) => void;
  commitSelectedPath: (repoPath: string) => void;
  scheduleSelectedPath: (repoPath: string) => void;
  onRepoTreeKeyDown: (e: React.KeyboardEvent) => void;
  /** 键盘导航选中（聚焦 + 防抖切仓）；多选 Shift+方向键扩展也走它移动焦点 */
  onNavSelect: (id: string) => void;
  getItemProps: (id: string) => { tabIndex: 0 | -1; ref?: (el: HTMLElement | null) => void };
  onPathDragStart: (e: React.DragEvent, absPaths: string[]) => void;
};

export function useRepoTree({
  selectedPath,
  setSelectedPath,
  repos,
  hiddenRepoKeys,
  workspacePath,
  workspaceRoots,
  repoSort
}: {
  selectedPath: string | null;
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>;
  repos: GitRepoSummary[];
  hiddenRepoKeys?: ReadonlySet<string>;
  workspacePath: string;
  workspaceRoots?: readonly WorkspaceRoot[];
  repoSort: RepoSort;
}): GitRepoTreeApi {
  const treeRoots = useMemo(
    () =>
      buildGitRepoTree({
        repos,
        hiddenRepoKeys,
        workspacePath: workspacePath ?? '',
        workspaceRoots,
        repoSort,
        pathKey
      }),
    [repos, hiddenRepoKeys, workspacePath, workspaceRoots, repoSort]
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const selectedId = selectedPath ? `repo:${pathKey(selectedPath)}` : null;
  const previousSelection = useRef<{ id: string | null; chain?: string[] }>({ id: null });

  // chainById 只随树结构变化：若随 flatten 走，每次 expand/collapse 都换新引用，
  // 下方「选中仓自动展开祖先」effect 会重跑，把用户刚收起的祖先又展开（收不动）
  const { items: visibleItems, rows: treeRows } = useMemo(
    () => flattenGitRepoTree(treeRoots, expanded),
    [treeRoots, expanded]
  );
  const chainById = useMemo(() => buildChainById(treeRoots), [treeRoots]);
  const visibleNodes = useMemo(() => visibleItems.map((x) => x.node), [visibleItems]);
  const selectedChain = selectedId ? chainById.get(selectedId) : undefined;

  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { id: selectedId, chain: selectedChain };
    if (previous.id !== selectedId || (!previous.chain && selectedChain)) {
      setFocusedId(selectedChain ? selectedId : null);
    }
    // 摘要或排序更新可能重建节点。祖先路径相同时保留用户折叠状态。
    if (!selectedChain || (previous.chain?.length === selectedChain.length
      && selectedChain.every((id, index) => id === previous.chain?.[index]))) return;
    const ancestors = selectedChain.slice(0, -1);
    setExpanded(prev => ancestors.every(id => prev.has(id)) ? prev : new Set([...prev, ...ancestors]));
  }, [selectedId, selectedChain]);

  const onToggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 目录行点击：聚焦 + 折叠/展开 */
  const onFolderRowClick = useCallback(
    (id: string) => {
      setFocusedId(id);
      onToggleExpand(id);
    },
    [onToggleExpand]
  );

  const pendingSelection = useRef<{ path: string; timer: number } | null>(null);
  const cancelPendingSelection = useCallback(() => {
    if (!pendingSelection.current) return;
    window.clearTimeout(pendingSelection.current.timer);
    pendingSelection.current = null;
  }, []);

  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    if (pending && hiddenRepoKeys?.has(pathKey(pending.path))) cancelPendingSelection();
  }, [hiddenRepoKeys, cancelPendingSelection]);

  const commitSelectedPath = useCallback((repoPath: string) => {
    cancelPendingSelection();
    setSelectedPath(repoPath);
  }, [cancelPendingSelection, setSelectedPath]);

  /** 仓库行点击：聚焦 + 立即切选中（只 setState，持久化与刷新交给 effect） */
  const onSelectRepo = useCallback(
    (id: string, repoPath: string) => {
      setFocusedId(id);
      commitSelectedPath(repoPath);
    },
    [commitSelectedPath]
  );

  const scheduleSelectedPath = useCallback((repoPath: string) => {
    cancelPendingSelection();
    const timer = window.setTimeout(() => {
      pendingSelection.current = null;
      startTransition(() => setSelectedPath(repoPath));
    }, DETAIL_SELECT_DEBOUNCE_MS);
    pendingSelection.current = { path: repoPath, timer };
  }, [cancelPendingSelection, setSelectedPath]);

  useEffect(() => cancelPendingSelection, [cancelPendingSelection]);

  const onNavSelect = useCallback(
    (id: string) => {
      setFocusedId(id);
      const node = visibleNodes.find((n) => n.id === id);
      if (node?.kind === 'repo' && node.repo) {
        scheduleSelectedPath(node.repo.path);
      }
    },
    [visibleNodes, scheduleSelectedPath]
  );

  const { onTreeKeyDown, getItemProps } = useTreeKeyboardNav({
    rows: treeRows,
    selectedId: focusedId,
    onSelect: onNavSelect,
    onToggleExpand
  });

  const onPathDragStart = useCallback((e: React.DragEvent, absPaths: string[]) => {
    const list = absPaths.map((p) => p?.trim()).filter(Boolean);
    if (list.length === 0) {
      e.preventDefault();
      return;
    }
    setPathDragData(e.dataTransfer, list);
    try {
      window.api.shell.startPathDrag?.(list);
    } catch {
      /* HTML5 MIME 仍可用 */
    }
  }, []);

  const onRepoTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
      if (focusedId != null) {
        const node = visibleNodes.find((n) => n.id === focusedId);
        if (node) {
          e.preventDefault();
          if (node.kind === 'repo' && node.repo) {
            commitSelectedPath(node.repo.path);
            // 带子仓的仓库行：Enter 与点击一致，选中之外同时展开/收起
            if (node.expandable) onToggleExpand(node.id);
          } else if (node.expandable) {
            onToggleExpand(node.id);
          }
          return;
        }
      }
      }
      onTreeKeyDown(e);
    },
    [onTreeKeyDown, focusedId, visibleNodes, onToggleExpand, commitSelectedPath]
  );

  return {
    expanded,
    focusedId,
    setFocusedId,
    visibleItems,
    treeRows,
    chainById,
    visibleNodes,
    onToggleExpand,
    onFolderRowClick,
    onSelectRepo,
    commitSelectedPath,
    scheduleSelectedPath,
    onRepoTreeKeyDown,
    onNavSelect,
    getItemProps,
    onPathDragStart
  };
}
