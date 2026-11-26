import { ErrorTip } from './ErrorTip';
import { BrandLoading } from './BrandLoader';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FsChangedPayload, FsDirEntry } from '../../../shared/types';
import { sourceRootsFor } from '../../../shared/workspaceRoots';
import type { TreeNavRow } from '../../../shared/listTreeKeyboardNav';
import { setPathDragData } from '../../../shared/fileDropPaths';
import { removeCoveredPaths } from '../../../shared/listSelection';
import { useTreeKeyboardNav } from '../hooks/useTreeKeyboardNav';
import { useListSelection } from '../hooks/useListSelection';
import { joinUnderRoot } from '../../../shared/workspaceRelPath';
import { useWorkspaceStore } from '../store';
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from './ContextMenu';
import { AppConfirmDialog } from './AppConfirmDialog';
import { IconExternalLink, IconFolder, IconFolderOpen, IconRefresh } from './icons';

function sortEntries(entries: FsDirEntry[]): FsDirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function parentRel(rel: string): string {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

/** 变更路径影响到的、需要重载的目录（含自身若是目录条目的父链） */
function dirsToReload(relativePaths: string[], expanded: Set<string>): string[] {
  const out = new Set<string>();
  for (const raw of relativePaths) {
    const rel = raw.replace(/\\/g, '/');
    if (!rel) {
      out.add('');
      continue;
    }
    let cur = parentRel(rel);
    for (;;) {
      if (expanded.has(cur)) out.add(cur);
      if (!cur) break;
      cur = parentRel(cur);
    }
    // 目录自身若已展开也重载（其下可能变更）
    if (expanded.has(rel)) out.add(rel);
  }
  return [...out];
}

function buildVisibleRows(
  expanded: Set<string>,
  childrenMap: Map<string, FsDirEntry[]>
): TreeNavRow[] {
  const rows: TreeNavRow[] = [
    {
      id: '',
      parentId: null,
      expandable: true,
      expanded: expanded.has('')
    }
  ];

  const visitChildren = (dirRel: string): void => {
    if (!expanded.has(dirRel)) return;
    const children = childrenMap.get(dirRel);
    if (!children) return;
    for (const entry of children) {
      if (entry.isDirectory) {
        rows.push({
          id: entry.relativePath,
          parentId: dirRel,
          expandable: true,
          expanded: expanded.has(entry.relativePath)
        });
        visitChildren(entry.relativePath);
      } else {
        rows.push({
          id: entry.relativePath,
          parentId: dirRel,
          expandable: false,
          expanded: false
        });
      }
    }
  };

  visitChildren('');
  return rows;
}

/** 右键目标：单行为 1 项；右键落在多选区内时为整选区（祖先目录吸收子路径） */
type CtxTarget = ContextMenuPoint & {
  items: { relativePath: string; isDirectory: boolean; linked?: boolean }[];
};

type PendingDelete = {
  items: { relativePath: string; isDirectory: boolean }[];
};

/** 批量删除确认框的路径预览：最多列 5 条，超出折叠为计数 */
function deletePreview(
  paths: string[],
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const MAX = 5;
  const shown = paths.slice(0, MAX).join('\n');
  if (paths.length <= MAX) return shown;
  return `${shown}\n…${t('等 {{n}} 项', { n: paths.length })}`;
}

export function FileTree({
  workspaceId,
  rootId,
  rootLabel,
  showRootPath,
  showHeader = true,
  refreshNonce = 0,
  onLoadingChange,
  onRegisterNav,
  onBoundary,
  onClaimFocus,
  active = true,
  onOpenFile,
  onKeepFile,
  selectedPath,
  onDeleted,
  reveal
}: {
  workspaceId: string;
  /** 指定源根；旧单根组件调用可省略。 */
  rootId?: string;
  showRootPath?: boolean;
  rootLabel?: string;
  /** 为假时不画根标题/路径/本树刷新（右侧文件列表改由标题栏统一刷新） */
  showHeader?: boolean;
  /** 父级递增时刷新这一棵树，不在挂载时触发 */
  refreshNonce?: number;
  onLoadingChange?: (rootId: string, loading: boolean) => void;
  /** 多根合成一条列表时登记：邻树用 focusEdge 把键盘焦点接过来，clear 去掉本树高亮 */
  onRegisterNav?: (rootId: string, api: { focusEdge: (edge: 'start' | 'end') => void; clear: () => void } | null) => void;
  /** 已在第一行再按上、或最后一行再按下时调用；返回 true 表示邻树已接过焦点 */
  onBoundary?: (direction: 'up' | 'down') => boolean;
  /** 本树得到键盘高亮时，请父级清掉其他源根的高亮 */
  onClaimFocus?: (rootId: string) => void;
  /** 面板是否可见；不可见时挂卸 fs:changed 订阅，避免隐藏的树持续跑 loadDir IPC + setState */
  active?: boolean;
  onOpenFile: (relativePath: string, externalPath?: string) => void;
  onKeepFile?: (relativePath: string, externalPath?: string) => void;
  selectedPath?: string | null;
  /** 删除成功后回调（相对路径；目录删除时为该目录路径） */
  onDeleted?: (relativePath: string) => void;
  /** 定位到该路径：展开祖先链、聚焦并滚动到该行（nonce 变化可重复触发；文件与目录皆可） */
  reveal?: { path: string; isDir: boolean; nonce: number } | null;
}): React.JSX.Element {
  const { workspaces } = useWorkspaceStore();
  const { t } = useTranslation();
  const workspacePath = useMemo(
    () => {
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return '';
      try { return rootId === undefined ? workspace.path : sourceRootsFor(workspace).find((r) => r.id === rootId)?.path ?? ''; }
      catch { return ''; }
    },
    [workspaces, workspaceId, rootId]
  );
  const revision = workspaces.find((w) => w.id === workspaceId)?.rootsRevision ?? 0;

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [childrenMap, setChildrenMap] = useState<Map<string, FsDirEntry[]>>(() => new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [dirErrors, setDirErrors] = useState<Map<string, string>>(() => new Map());
  const [rootError, setRootError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const watchRequestRef = useRef(0);
  const [ctx, setCtx] = useState<CtxTarget | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  /** 定位请求的落点：祖先链懒加载完成、目标行出现后滚动到可见并清除 */
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scopeIdentity = JSON.stringify([workspaceId, rootId, revision, refreshKey]);
  const scopeEpochRef = useRef({ identity: scopeIdentity, version: 0 });
  if (scopeEpochRef.current.identity !== scopeIdentity) {
    scopeEpochRef.current = { identity: scopeIdentity, version: scopeEpochRef.current.version + 1 };
  }
  const scope = JSON.stringify([scopeIdentity, scopeEpochRef.current.version]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const requestsRef = useRef(new Map<string, string>());

  const loadDir = useCallback(
    async (dirRel: string): Promise<void> => {
      if (requestsRef.current.get(dirRel) === scope) return;
      requestsRef.current.set(dirRel, scope);
      const current = (): boolean => scopeRef.current === scope && requestsRef.current.get(dirRel) === scope;
      setLoadingDirs((prev) => new Set(prev).add(dirRel));
      setDirErrors((prev) => {
        const next = new Map(prev);
        next.delete(dirRel);
        return next;
      });
      try {
        const res = rootId === undefined
          ? await window.api.fs.listTreeDir(workspaceId, dirRel || undefined)
          : await window.api.fs.listTreeDirRef({ workspaceId, rootId, relativePath: dirRel });
        if (!current()) return;
        if (dirRel === '') setWatchError(res.watchError ?? null);
        if (res.error) {
          setDirErrors((prev) => new Map(prev).set(dirRel, res.error!));
          if (dirRel === '') setRootError(res.error);
          return;
        }
        if (dirRel === '') setRootError(null);
        setChildrenMap((prev) => {
          const next = new Map(prev);
          next.set(dirRel, sortEntries(res.entries));
          return next;
        });
      } catch (err) {
        if (!current()) return;
        const msg = err instanceof Error ? err.message : String(err);
        setDirErrors((prev) => new Map(prev).set(dirRel, msg));
        if (dirRel === '') setRootError(msg);
      } finally {
        if (!current()) return;
        requestsRef.current.delete(dirRel);
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirRel);
          return next;
        });
      }
    },
    [workspaceId, rootId, scope]
  );

  // 工作区变更或手动刷新：重置并加载根
  useEffect(() => {
    scopeRef.current = scope;
    setExpanded(new Set(['']));
    setChildrenMap(new Map());
    setDirErrors(new Map());
    setRootError(null);
    setLoadingDirs(new Set());
    setFocusedPath(null);
    setPendingReveal(null);
    setCtx(null);
    setPendingDelete(null);
    requestsRef.current.clear();
    void loadDir('');
  }, [scope, loadDir]);

  useEffect(() => () => { scopeRef.current = ''; }, []);

  useEffect(() => {
    watchRequestRef.current += 1;
    setWatchError(null);
    return () => { watchRequestRef.current += 1; };
  }, [workspaceId, rootId, revision]);

  // 展开目录时懒加载
  useEffect(() => {
    for (const dir of expanded) {
      if (childrenMap.has(dir) || loadingDirs.has(dir) || dirErrors.has(dir)) continue;
      void loadDir(dir);
    }
  }, [expanded, childrenMap, loadingDirs, dirErrors, loadDir]);

  // 外部打开文件后同步树高亮
  useEffect(() => {
    if (selectedPath === undefined) return;
    if (selectedPath != null && rootId) onClaimFocus?.(rootId);
    setFocusedPath(selectedPath);
  }, [selectedPath, onClaimFocus, rootId]);

  // 隐藏期间不订阅事件；重新显示时补读展开目录，也带回根级监听状态。
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (active && !wasActiveRef.current) for (const dir of expanded) void loadDir(dir);
    wasActiveRef.current = active;
  }, [active, expanded, loadDir]);

  // 外部定位：展开祖先链并聚焦（子级由懒加载 effect 补齐）；文件只展开祖先、不把自身当目录
  useEffect(() => {
    if (!reveal?.path) return;
    const rel = reveal.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const segments = rel.split('/').filter(Boolean);
    // 目录定位到自身为止；文件定位到父目录为止（自身进 expanded 会触发对文件的 listDir）
    const dirSegments = reveal.isDir ? segments : segments.slice(0, -1);
    if (rootId) onClaimFocus?.(rootId);
    setFocusedPath(rel);
    setPendingReveal(rel);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add('');
      let cur = '';
      for (const part of dirSegments) {
        cur = cur ? `${cur}/${part}` : part;
        next.add(cur);
      }
      return next;
    });
  }, [reveal, onClaimFocus, rootId]);

  // 磁盘变更 → 增量刷新已展开目录（按面板可见性挂卸：Git 页可见时隐藏的文件树不消费事件流）
  useEffect(() => {
    if (!active) return;
    return window.api.on('fs:changed', (payload: FsChangedPayload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      if (payload.rootsRevision !== undefined && payload.rootsRevision !== revision) return;
      const eventRoot = payload.rootId ?? workspaces.find((w) => w.id === workspaceId)?.defaultRootId;
      if (rootId !== undefined && eventRoot !== undefined && eventRoot !== rootId) return;
      if (payload.error) { setWatchError(payload.error); return; }
      setWatchError(null);
      const dirs = dirsToReload(payload.relativePaths ?? [], expanded);
      for (const dir of dirs) {
        void loadDir(dir);
      }
    });
  }, [active, workspaceId, rootId, revision, workspaces, expanded, loadDir]);

  const toggleDir = useCallback((rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    if (rootId === undefined) return;
    const request = ++watchRequestRef.current;
    void window.api.fs.refreshWatch(workspaceId, rootId).then(res => {
      if (watchRequestRef.current === request) setWatchError(res?.ok ? null : res?.error ?? null);
    }).catch(err => {
      if (watchRequestRef.current === request) setWatchError(err instanceof Error ? err.message : String(err));
    });
  }, [workspaceId, rootId]);

  const seenRefreshNonce = useRef(refreshNonce);
  useEffect(() => {
    if (seenRefreshNonce.current === refreshNonce) return;
    seenRefreshNonce.current = refreshNonce;
    refresh();
  }, [refreshNonce, refresh]);

  useEffect(() => {
    onLoadingChange?.(rootId ?? '', loadingDirs.size > 0);
  }, [loadingDirs.size, onLoadingChange, rootId]);

  useEffect(() => () => { onLoadingChange?.(rootId ?? '', false); }, [onLoadingChange, rootId]);

  // Callback dependency arrays below read these values during render, so they
  // must be initialized before drag/context callbacks are constructed.
  const visibleRows = useMemo(
    () => buildVisibleRows(expanded, childrenMap),
    [expanded, childrenMap]
  );
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;
  useEffect(() => {
    if (!rootId || !onRegisterNav) return;
    onRegisterNav(rootId, {
      focusEdge(edge) {
        const rows = visibleRowsRef.current;
        if (!rows.length) return;
        setFocusedPath(edge === 'start' ? rows[0].id : rows[rows.length - 1].id);
        scrollRef.current?.focus({ preventScroll: true });
      },
      clear() { setFocusedPath(null); }
    });
    return () => onRegisterNav(rootId, null);
  }, [rootId, onRegisterNav]);
  const rowById = useMemo(() => {
    const map = new Map<string, TreeNavRow>();
    for (const row of visibleRows) map.set(row.id, row);
    return map;
  }, [visibleRows]);
  const entriesByPath = useMemo(() => {
    const map = new Map<string, FsDirEntry>();
    for (const entries of childrenMap.values()) for (const entry of entries) map.set(entry.relativePath, entry);
    return map;
  }, [childrenMap]);
  const selectionOrderedIds = useMemo(
    () => visibleRows.map((r) => r.id).filter((id) => id !== ''),
    [visibleRows]
  );
  const selection = useListSelection({ orderedIds: selectionOrderedIds });

  const beginPathDrag = useCallback(
    (e: React.DragEvent, relativePath: string) => {
      if (!workspacePath) {
        e.preventDefault();
        return;
      }
      // 拖动选区内行 = 拖整选区（按可见行序）；拖选区外行 = 只拖该行
      const multi = selection.selectedIds.size > 1 && selection.isSelected(relativePath);
      const rels = multi
        ? selectionOrderedIds.filter((id) => selection.selectedIds.has(id))
        : [relativePath];
      const abs = rels.map((rel) => joinUnderRoot(workspacePath, rel));
      setPathDragData(e.dataTransfer, abs);
      try {
        window.api.shell.startPathDrag?.(abs);
      } catch {
        // HTML5 MIME 仍可用
      }
    },
    [workspacePath, selection, selectionOrderedIds]
  );

  const openCtx = useCallback(
    (e: React.MouseEvent, entry: FsDirEntry | { relativePath: string; isDirectory: boolean }) => {
      e.preventDefault();
      e.stopPropagation();
      // 右键在多选区内 → 菜单作用于整选区；否则塌缩为该行（现状单行语义）
      const aggregate = selection.isSelected(entry.relativePath) && selection.selectedIds.size > 1;
      let items: CtxTarget['items'];
      if (aggregate) {
        const isDirOf = new Map(visibleRows.map((r) => [r.id, r.expandable]));
        const containsLink = [...selection.selectedIds].some((rel) => {
          const info = entriesByPath.get(rel);
          return info?.isSymbolicLink || info?.viaSymbolicLink;
        });
        items = removeCoveredPaths([...selection.selectedIds]).map((rel) => ({
          relativePath: rel,
          isDirectory: isDirOf.get(rel) ?? false,
          linked: containsLink
        }));
      } else {
        const info = entriesByPath.get(entry.relativePath);
        items = [{ relativePath: entry.relativePath, isDirectory: entry.isDirectory,
          linked: Boolean(info?.isSymbolicLink || info?.viaSymbolicLink) }];
      }
      setCtx({ x: e.clientX, y: e.clientY, anchor: e.currentTarget, items });
    },
    [selection, visibleRows, entriesByPath]
  );

  const onCtxSelect = useCallback(
    async (id: string) => {
      if (!ctx) return;
      if (id === 'reveal') {
        if (!workspacePath || ctx.items.length !== 1) {
          setCtx(null);
          return;
        }
        const abs = joinUnderRoot(workspacePath, ctx.items[0]!.relativePath);
        await window.api.shell.revealPath(abs);
        setCtx(null);
        return;
      }
      if (id === 'delete') {
        if (!ctx.items.some((item) => item.relativePath)) {
          setCtx(null);
          return;
        }
        setDeleteError(null);
        setPendingDelete({ items: ctx.items.filter((item) => item.relativePath) });
        setCtx(null);
        return;
      }
      setCtx(null);
    },
    [ctx, workspacePath]
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const targets = removeCoveredPaths(pendingDelete.items.map((i) => i.relativePath));
    const deleted: string[] = [];
    let failed = false;
    try {
      for (const rel of targets) {
        const res = rootId === undefined
          ? await window.api.fs.remove(workspaceId, rel)
          : await window.api.fs.removeRef({ workspaceId, rootId, relativePath: rel });
        if (scopeRef.current !== scope) return;
        if (!res.ok) {
          setDeleteError(res.error ?? t('删除失败'));
          failed = true;
          break;
        }
        deleted.push(rel);
      }
    } catch (err) {
      // 通道级 reject（主进程 handler 已整体 try/catch，这里只是防御窗口）：与 {ok:false}
      // 同一呈现，恢复 deleting 并让确认框带错误滞留，不再产生 unhandled rejection
      if (scopeRef.current !== scope) return;
      setDeleteError(err instanceof Error ? err.message : String(err));
      failed = true;
    } finally {
      setDeleting(false);
    }
    if (deleted.length > 0) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const d of deleted) {
          for (const key of [...next]) {
            if (key === d || key.startsWith(`${d}/`)) next.delete(key);
          }
        }
        return next;
      });
      setChildrenMap((prev) => {
        const next = new Map(prev);
        for (const d of deleted) {
          for (const key of [...next.keys()]) {
            if (key === d || key.startsWith(`${d}/`)) next.delete(key);
          }
        }
        return next;
      });
      const parents = new Set(deleted.map((rel) => parentRel(rel)));
      for (const parent of parents) void loadDir(parent);
      for (const rel of deleted) onDeleted?.(rel);
    }
    if (!failed) {
      setPendingDelete(null);
    } else {
      // 部分失败：对话框带错误滞留，重试只删剩余项
      const deletedSet = new Set(deleted);
      setPendingDelete((prev) =>
        prev ? { items: prev.items.filter((i) => !deletedSet.has(i.relativePath)) } : prev
      );
    }
  }, [pendingDelete, deleting, workspaceId, rootId, scope, loadDir, onDeleted, t]);

  // 定位滚动：目标行进入可见行集合后滚动到视口中部（行未出现＝祖先还在懒加载，等下轮）
  useEffect(() => {
    if (!pendingReveal || !rowById.has(pendingReveal)) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-file-tree-row="${pendingReveal.replace(/"/g, '\\"')}"]`
    );
    if (el) el.scrollIntoView({ block: 'center' });
    setPendingReveal(null);
  }, [pendingReveal, rowById]);

  const focusRow = useCallback((id: string) => {
    if (rootId) onClaimFocus?.(rootId);
    setFocusedPath(id);
  }, [onClaimFocus, rootId]);

  const openEntry = useCallback((id: string, keep = false) => {
    const entry = entriesByPath.get(id);
    if (!entry || entry.linkError) return;
    const open = keep ? onKeepFile ?? onOpenFile : onOpenFile;
    if (entry.externalPath) open(id, entry.externalPath);
    else open(id);
  }, [entriesByPath, onKeepFile, onOpenFile]);

  const onNavSelect = useCallback(
    (id: string) => {
      focusRow(id);
      const row = rowById.get(id);
      if (row && !row.expandable) {
        openEntry(id);
      }
    },
    [rowById, openEntry, focusRow]
  );

  const { onTreeKeyDown, getItemProps } = useTreeKeyboardNav({
    rows: visibleRows,
    selectedId: focusedPath,
    onSelect: onNavSelect,
    onToggleExpand: toggleDir
  });

  const onScrollKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 多选键（Ctrl+A / Esc / Shift+↑↓）优先；Shift+↑↓ 同时移焦点并扩选区
      if (selection.handleKeyDown(e, { currentId: focusedPath, onMoveFocus: onNavSelect })) return;
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && onBoundary) {
        const cur = focusedPath == null ? -1 : visibleRows.findIndex((row) => row.id === focusedPath);
        const direction = e.key === 'ArrowUp' ? 'up' : 'down';
        const atEdge = direction === 'up' ? cur === 0 : cur >= 0 && cur === visibleRows.length - 1;
        if (atEdge && onBoundary(direction)) {
          e.preventDefault();
          setFocusedPath(null);
          return;
        }
      }
      onTreeKeyDown(e);
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (focusedPath === null) return;
      const row = rowById.get(focusedPath);
      if (!row) return;
      e.preventDefault();
      if (row.expandable) {
        toggleDir(focusedPath);
      } else {
        openEntry(focusedPath, true);
      }
    },
    [selection, onTreeKeyDown, focusedPath, visibleRows, onBoundary, rowById, toggleDir, openEntry, onNavSelect]
  );

  const renderEntries = (dirRel: string, depth: number): React.ReactNode => {
    const entries = childrenMap.get(dirRel);
    const loading = loadingDirs.has(dirRel);
    const err = dirErrors.get(dirRel);

    if (err && !entries) return dirRel ? <ErrorTip message={err} /> : null;
    if (loading && !entries) {
      return (
        <div className="file-tree-hint" style={{ paddingLeft: 4 + depth * 12 }}>
          {t('加载中…')}
        </div>
      );
    }
    if (!entries || entries.length === 0) {
      return (
        <div className="file-tree-hint" style={{ paddingLeft: 4 + depth * 12 }}>
          {entries ? t('空目录') : null}
        </div>
      );
    }

    return entries.map((entry) => {
      if (entry.isDirectory) {
        const open = expanded.has(entry.relativePath);
        const focused = focusedPath === entry.relativePath;
        const multiselected = selection.isSelected(entry.relativePath);
        return (
          <div key={`d:${entry.relativePath}`} className="file-tree-dir">
            <div
              className={`file-tree-row is-dir${focused ? ' is-active' : ''}${multiselected ? ' is-multiselected' : ''}`}
              style={{ paddingLeft: 4 + depth * 12 }}
              data-file-tree-row={entry.relativePath}
              role="treeitem"
              aria-expanded={open}
              aria-level={depth}
              aria-selected={focused || multiselected}
              title={entry.linkError ?? entry.externalPath ?? entry.relativePath}
              draggable
              onDragStart={(e) => beginPathDrag(e, entry.relativePath)}
              onClick={(e) => {
                const mode = selection.click(entry.relativePath, e);
                if (mode !== 'plain') return;
                focusRow(entry.relativePath);
                toggleDir(entry.relativePath);
              }}
              onContextMenu={(e) => openCtx(e, entry)}
              {...getItemProps(entry.relativePath)}
            >
              <span className="file-tree-folder" aria-hidden>
                {open ? <IconFolderOpen size={13} /> : <IconFolder size={13} />}
              </span>
              <span className="file-tree-name is-dir-name">{entry.name}</span>
              {entry.isSymbolicLink ? <IconExternalLink size={10} className="file-tree-link" /> : null}
            </div>
            {open ? <div role="group">{renderEntries(entry.relativePath, depth + 1)}</div> : null}
          </div>
        );
      }

      const focused = focusedPath === entry.relativePath;
      const multiselected = selection.isSelected(entry.relativePath);
      return (
        <div
          key={`f:${entry.relativePath}`}
          className={`file-tree-row is-file${focused ? ' is-active' : ''}${multiselected ? ' is-multiselected' : ''}`}
          style={{ paddingLeft: 4 + depth * 12 }}
          data-file-tree-row={entry.relativePath}
          role="treeitem"
          aria-level={depth}
          aria-selected={focused || multiselected}
          aria-disabled={entry.linkError ? true : undefined}
          title={entry.linkError ?? entry.externalPath ?? entry.relativePath}
          aria-label={entry.linkError ? `${entry.name}: ${entry.linkError}` : undefined}
          draggable
          onDragStart={(e) => beginPathDrag(e, entry.relativePath)}
          onClick={(e) => {
            const mode = selection.click(entry.relativePath, e);
            if (mode !== 'plain') return;
            focusRow(entry.relativePath);
            openEntry(entry.relativePath);
          }}
          onDoubleClick={() => { if (onKeepFile) openEntry(entry.relativePath, true); }}
          onContextMenu={(e) => openCtx(e, entry)}
          {...getItemProps(entry.relativePath)}
        >
          <span className="file-tree-twist-spacer" aria-hidden />
          <span className="file-tree-name">{entry.name}</span>
          {entry.isSymbolicLink ? <IconExternalLink size={10} className="file-tree-link" /> : null}
          {entry.linkError ? <span className="file-tree-hint">{t('无法读取文件')}</span> : null}
        </div>
      );
    });
  };

  const label = rootLabel ?? workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? t('工作区');
  const rootFocused = focusedPath === '';

  const ctxItems = useMemo((): ContextMenuItem[] => {
    if (!ctx) return [];
    const items: ContextMenuItem[] = [];
    // 多项时不提供「在资源管理器中打开」（逐项 reveal 会开 N 个窗口）
    if (ctx.items.length <= 1) {
      items.push({ id: 'reveal', label: t('在资源管理器中打开') });
    }
    if (ctx.items.some((item) => item.relativePath) && !ctx.items.some((item) => item.linked)) {
      items.push({
        id: 'delete',
        label: ctx.items.length > 1 ? t('删除 {{n}} 项', { n: ctx.items.length }) : t('删除'),
        danger: true
      });
    }
    return items;
  }, [ctx, t]);

  return (
    <div className="file-tree" data-drag-source="file-tree" data-source-root={rootId}>
      {showHeader ? (
        <div className="file-tree-toolbar">
          <div className="file-tree-root-caption">
            <span className="file-tree-toolbar-label" title={workspacePath || undefined}>{label}</span>
            {showRootPath ? <span className="file-tree-root-path" title={workspacePath}>{workspacePath}</span> : null}
          </div>
          <div className="file-tree-toolbar-actions">
            <button type="button" className="git-btn ghost tiny" aria-label={t('刷新')} onClick={refresh}>
              {loadingDirs.size > 0 ? <BrandLoading size={18} /> : <IconRefresh />}
            </button>
          </div>
        </div>
      ) : null}
      {rootError ? <ErrorTip message={rootError} /> : null}
      {watchError ? <ErrorTip message={t('文件监听失败：{{message}}', { message: watchError })} /> : null}
      <div
        className="file-tree-scroll"
        ref={scrollRef}
        role="tree"
        aria-label={label}
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={onScrollKeyDown}
      >
        <div
          className={`file-tree-row is-dir is-root${rootFocused ? ' is-active' : ''}`}
          data-file-tree-row=""
          role="treeitem"
          aria-expanded={expanded.has('')}
          aria-level={1}
          aria-selected={rootFocused}
          title={workspacePath || undefined}
          draggable={Boolean(workspacePath)}
          onDragStart={(e) => beginPathDrag(e, '')}
          onClick={(e) => {
            // 根行不参与多选：任意点击清空选区；普通点击维持开合
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
              selection.clear();
              return;
            }
            focusRow('');
            toggleDir('');
          }}
          onContextMenu={(e) => openCtx(e, { relativePath: '', isDirectory: true })}
          {...getItemProps('')}
        >
          <span className="file-tree-folder" aria-hidden>
            {expanded.has('') ? <IconFolderOpen size={13} /> : <IconFolder size={13} />}
          </span>
          <span className="file-tree-name is-dir-name">{label}</span>
        </div>
        {expanded.has('') ? <div role="group">{renderEntries('', 1)}</div> : null}
      </div>
      {ctx ? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          anchor={ctx.anchor}
          items={ctxItems}
          onSelect={(id) => void onCtxSelect(id)}
          onClose={() => setCtx(null)}
        />
      ) : null}
      <AppConfirmDialog
        open={!!pendingDelete}
        title={
          pendingDelete && pendingDelete.items.length > 1
            ? t('删除 {{n}} 项？', { n: pendingDelete.items.length })
            : pendingDelete?.items[0]?.isDirectory
              ? t('删除文件夹？')
              : t('删除文件？')
        }
        detail={
          (pendingDelete && pendingDelete.items.length > 1
            ? t('将永久删除 {{n}} 项（不可恢复）：\n{{list}}', {
                n: pendingDelete.items.length,
                list: deletePreview(pendingDelete.items.map((i) => i.relativePath), t)
              })
            : pendingDelete?.items[0]?.isDirectory
              ? t('将永久删除文件夹及其全部内容（不可恢复）：\n{{path}}', {
                  path: pendingDelete?.items[0]?.relativePath ?? ''
                })
              : t('将永久删除文件（不可恢复）：\n{{path}}', {
                  path: pendingDelete?.items[0]?.relativePath ?? ''
                })) +
          (deleteError ? `\n\n${t('错误：{{error}}', { error: deleteError })}` : '')
        }
        confirmLabel={deleting ? t('删除中…') : t('删除')}
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (deleting) return;
          setPendingDelete(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
