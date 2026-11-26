import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitFileChange } from '../../../shared/types';
import type { TreeNavRow } from '../../../shared/listTreeKeyboardNav';
import { setPathDragData } from '../../../shared/fileDropPaths';
import { useTreeKeyboardNav } from '../hooks/useTreeKeyboardNav';
import { useListSelection } from '../hooks/useListSelection';
import { IconFolder, IconFolderOpen } from '../components/icons';

function joinRepoRel(repoPath: string, rel: string): string {
  const base = repoPath.replace(/[/\\]+$/, '');
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return base;
  const sep = repoPath.includes('\\') ? '\\' : '/';
  return [base, ...parts].join(sep);
}

/** 简单 31 进制字符串哈希（FNV 变体），用于 files 变化检测 */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

export type ChangeTreeNode = {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  file?: GitFileChange;
  children: ChangeTreeNode[];
  /** 目录下文件数（构建时算好） */
  fileCount: number;
  /** 目录下全部文件路径（构建时算好，供双击批量 stage） */
  filePaths: string[];
};

export type GitChangeContextTarget = {
  zone: 'unstaged' | 'staged';
  /** 相对仓根；目录为该节点全部文件路径 */
  paths: string[];
  /** 用于 Reveal：文件为文件相对路径，目录为目录相对路径 */
  revealRelPath: string;
  kind: 'file' | 'dir';
  file?: GitFileChange;
};

type MutableNode = {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  file?: GitFileChange;
  children: Map<string, MutableNode>;
};

function finalize(m: MutableNode): ChangeTreeNode {
  const children = [...m.children.values()]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    })
    .map(finalize);

  if (m.kind === 'file' && m.file) {
    return {
      name: m.name,
      path: m.path,
      kind: 'file',
      file: m.file,
      children: [],
      fileCount: 1,
      filePaths: [m.file.path]
    };
  }

  const filePaths = children.flatMap((c) => c.filePaths);
  return {
    name: m.name,
    path: m.path,
    kind: 'dir',
    children,
    fileCount: filePaths.length,
    filePaths
  };
}

export function buildFileTree(files: GitFileChange[]): ChangeTreeNode[] {
  const root: MutableNode = {
    name: '',
    path: '',
    kind: 'dir',
    children: new Map()
  };

  for (const f of files) {
    const parts = f.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join('/');
      let child = cur.children.get(part);
      if (!child) {
        child = {
          name: part,
          path: childPath,
          kind: isFile ? 'file' : 'dir',
          file: isFile ? f : undefined,
          children: new Map()
        };
        cur.children.set(part, child);
      } else if (isFile) {
        child.kind = 'file';
        child.file = f;
      }
      cur = child;
    }
  }

  return finalize(root).children;
}

function collapsedKey(zone: 'unstaged' | 'staged', path: string): string {
  return `${zone}:${path}`;
}

/** 按 collapsed 跳过子树（空 Set = 默认全开） */
function flattenVisibleRows(
  nodes: ChangeTreeNode[],
  collapsed: Set<string>,
  zone: 'unstaged' | 'staged',
  parentId: string | null = null
): TreeNavRow[] {
  const rows: TreeNavRow[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      const expanded = !collapsed.has(collapsedKey(zone, node.path));
      rows.push({
        id: node.path,
        parentId,
        expandable: true,
        expanded
      });
      if (expanded) {
        rows.push(...flattenVisibleRows(node.children, collapsed, zone, node.path));
      }
    } else {
      rows.push({
        id: node.path,
        parentId,
        expandable: false,
        expanded: false
      });
    }
  }
  return rows;
}

function indexNodes(nodes: ChangeTreeNode[]): Map<string, ChangeTreeNode> {
  const map = new Map<string, ChangeTreeNode>();
  const walk = (list: ChangeTreeNode[]): void => {
    for (const n of list) {
      map.set(n.path, n);
      if (n.kind === 'dir') walk(n.children);
    }
  };
  walk(nodes);
  return map;
}

type ItemProps = {
  tabIndex: 0 | -1;
  ref?: (el: HTMLElement | null) => void;
};

const FileRow = memo(function FileRow({
  node,
  depth,
  zone,
  selected,
  focused,
  busy,
  badge,
  readOnly,
  getItemProps,
  onSelect,
  onTogglePaths,
  onContextMenu,
  onPathDragStart,
  onModifierClick,
  onResolveSelectionPaths,
  isMultiselected
}: {
  node: ChangeTreeNode;
  depth: number;
  zone: 'unstaged' | 'staged';
  selected: boolean;
  focused: boolean;
  busy: boolean;
  badge: string;
  readOnly: boolean;
  /** 与 DirRow 同款：传函数 + id 内部展开，避免每 render 新 props 对象击穿 memo */
  getItemProps: (id: string) => ItemProps;
  onSelect: (f: GitFileChange, zone: 'unstaged' | 'staged') => void;
  onTogglePaths: (paths: string[]) => void;
  onContextMenu?: (e: React.MouseEvent, target: GitChangeContextTarget) => void;
  onPathDragStart?: (e: React.DragEvent, relativePath: string) => void;
  /** Ctrl/⌘/Shift 修饰键点击：返回 true 表示已作为选区操作消费（不触发查看 Diff） */
  onModifierClick?: (id: string, e: React.MouseEvent) => boolean;
  /** id 落在多选区内时返回整选区文件路径（目录展开为其文件），否则 null */
  onResolveSelectionPaths?: (id: string) => string[] | null;
  /** 多选态查询（稳定回调，行内自取） */
  isMultiselected?: (id: string) => boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const f = node.file!;
  const multiselected = isMultiselected?.(node.path) ?? false;
  return (
    <div
      className={`file-tree-row is-file${selected || focused ? ' is-active' : ''}${multiselected ? ' is-multiselected' : ''}${busy ? ' is-busy' : ''}`}
      style={{ paddingLeft: 6 + depth * 12 }}
      role="button"
      aria-selected={selected || focused || multiselected}
      title={
        readOnly
          ? t('{{path}}\n单击查看 Diff', { path: f.path })
          : t('{{path}}\n单击 Diff · 双击{{action}}', {
              path: f.path,
              action: zone === 'unstaged' ? t('暂存') : t('取消暂存')
            })
      }
      aria-disabled={busy || undefined}
      draggable={Boolean(onPathDragStart)}
      onDragStart={
        onPathDragStart
          ? (e) => {
              onPathDragStart(e, f.path);
            }
          : undefined
      }
      onClick={(e) => {
        if (busy) return;
        if (onModifierClick?.(node.path, e)) return;
        onSelect(f, zone);
      }}
      onDoubleClick={
        readOnly || busy
          ? undefined
          : (e) => {
              e.preventDefault();
              onTogglePaths(onResolveSelectionPaths?.(node.path) ?? [f.path]);
            }
      }
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e, {
                zone,
                paths: onResolveSelectionPaths?.(node.path) ?? [f.path],
                revealRelPath: f.path,
                kind: 'file',
                file: f
              });
            }
          : undefined
      }
      {...getItemProps(node.path)}
    >
      <span className="file-tree-twist-spacer" aria-hidden />
      <span
        className={`git-file-badge${zone === 'staged' ? ' is-staged' : ''}`}
        data-kind={badge}
      >
        {badge}
      </span>
      <span className="file-tree-name" title={f.path}>
        {node.name}
      </span>
    </div>
  );
});

const DirRow = memo(function DirRow({
  node,
  depth,
  zone,
  collapsed,
  selectedFile,
  activeZone,
  focusedId,
  busy,
  readOnly,
  badgeOf,
  getItemProps,
  onToggle,
  onSelectFile,
  onTogglePaths,
  onContextMenu,
  onPathDragStart,
  onModifierClick,
  onResolveSelectionPaths,
  isMultiselected
}: {
  node: ChangeTreeNode;
  depth: number;
  zone: 'unstaged' | 'staged';
  collapsed: Set<string>;
  selectedFile: string | null;
  activeZone: boolean;
  focusedId: string | null;
  busy: boolean;
  readOnly: boolean;
  badgeOf: (f: GitFileChange) => string;
  getItemProps: (id: string) => ItemProps;
  onToggle: (path: string) => void;
  onSelectFile: (f: GitFileChange, zone: 'unstaged' | 'staged') => void;
  onTogglePaths: (paths: string[]) => void;
  onContextMenu?: (e: React.MouseEvent, target: GitChangeContextTarget) => void;
  onPathDragStart?: (e: React.DragEvent, relativePath: string) => void;
  onModifierClick?: (id: string, e: React.MouseEvent) => boolean;
  onResolveSelectionPaths?: (id: string) => string[] | null;
  isMultiselected?: (id: string) => boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const open = !collapsed.has(collapsedKey(zone, node.path));
  const focused = activeZone && focusedId === node.path;
  const multiselected = isMultiselected?.(node.path) ?? false;

  /** detail>1 时跳过，避免双击的第二下再折一次；dblclick 里再还原第一下 */
  const onRowClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.detail > 1) return;
      if (onModifierClick?.(node.path, e)) return;
      onToggle(node.path);
    },
    [node.path, onToggle, onModifierClick]
  );

  const onRowDblClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onToggle(node.path);
      if (readOnly || !node.filePaths.length) return;
      onTogglePaths(onResolveSelectionPaths?.(node.path) ?? node.filePaths);
    },
    [node.filePaths, node.path, onToggle, onTogglePaths, readOnly, onResolveSelectionPaths]
  );

  return (
    <div className="file-tree-dir">
      <div
        className={`file-tree-row is-dir${focused ? ' is-active' : ''}${multiselected ? ' is-multiselected' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        title={
          readOnly
            ? t('{{path}}\n单击折叠', { path: node.path })
            : t('{{path}}\n单击折叠 · 双击{{action}}目录', {
                path: node.path,
                action: zone === 'unstaged' ? t('暂存') : t('取消暂存')
              })
        }
        role="button"
        aria-selected={focused || multiselected}
        draggable={Boolean(onPathDragStart)}
        onDragStart={
          onPathDragStart
            ? (e) => {
                onPathDragStart(e, node.path);
              }
            : undefined
        }
        onClick={onRowClick}
        onDoubleClick={onRowDblClick}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!node.filePaths.length) return;
                onContextMenu(e, {
                  zone,
                  paths: onResolveSelectionPaths?.(node.path) ?? node.filePaths,
                  revealRelPath: node.path,
                  kind: 'dir'
                });
              }
            : undefined
        }
        {...getItemProps(node.path)}
      >
        {/* 展开态由文件夹图标本身表达（打开/闭合），不再单列指示器 */}
        <span className="file-tree-folder" aria-hidden>
          {open ? <IconFolderOpen size={13} /> : <IconFolder size={13} />}
        </span>
        <span className="file-tree-name is-dir-name" title={node.path}>
          {node.name}
        </span>
        <span className="git-tree-count">{node.fileCount}</span>
      </div>
      {open
        ? node.children.map((c) =>
            c.kind === 'dir' ? (
              <DirRow
                key={`d:${c.path}`}
                node={c}
                depth={depth + 1}
                zone={zone}
                collapsed={collapsed}
                selectedFile={selectedFile}
                activeZone={activeZone}
                focusedId={focusedId}
                busy={busy}
                readOnly={readOnly}
                badgeOf={badgeOf}
                getItemProps={getItemProps}
                onToggle={onToggle}
                onSelectFile={onSelectFile}
                onTogglePaths={onTogglePaths}
                onContextMenu={onContextMenu}
                onPathDragStart={onPathDragStart}
                onModifierClick={onModifierClick}
                onResolveSelectionPaths={onResolveSelectionPaths}
                isMultiselected={isMultiselected}
              />
            ) : (
              <FileRow
                key={`f:${c.path}`}
                node={c}
                depth={depth + 1}
                zone={zone}
                selected={activeZone && selectedFile === c.path}
                focused={activeZone && focusedId === c.path}
                busy={busy}
                badge={badgeOf(c.file!)}
                readOnly={readOnly}
                getItemProps={getItemProps}
                onSelect={onSelectFile}
                onTogglePaths={onTogglePaths}
                onContextMenu={onContextMenu}
                onPathDragStart={onPathDragStart}
                onModifierClick={onModifierClick}
                onResolveSelectionPaths={onResolveSelectionPaths}
                isMultiselected={isMultiselected}
              />
            )
          )
        : null}
    </div>
  );
});

export function GitChangeTree({
  files,
  zone,
  selectedFile,
  activeZone,
  busy,
  badgeOf,
  onSelectFile,
  onTogglePaths,
  onContextMenu,
  readOnly = false,
  repoPath
}: {
  files: GitFileChange[];
  zone: 'unstaged' | 'staged';
  selectedFile: string | null;
  activeZone: boolean;
  busy: boolean;
  badgeOf: (f: GitFileChange) => string;
  onSelectFile: (f: GitFileChange, zone: 'unstaged' | 'staged') => void;
  onTogglePaths: (paths: string[]) => void;
  onContextMenu?: (e: React.MouseEvent, target: GitChangeContextTarget) => void;
  readOnly?: boolean;
  /** 仓根绝对路径；有则支持拖出路径 */
  repoPath?: string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  // 仅在 files 内容真变时重建树。
  // 用数值哈希替代大字符串拼接：files 多时（metaapp 大改动几百文件）省 O(n log n) 拼接。
  // 哈希碰撞概率极低（31 进制 + 长度），且最坏情况只是多建一次树，不会出错。
  const treeKey = useMemo(() => {
    let h = files.length;
    for (const f of files) {
      // 31 进制滚动哈希；index/working_dir 是单字符，直接 charCodeAt
      h = (h * 31 + hashStr(f.path)) | 0;
      h = (h + (f.index.charCodeAt(0) || 0)) | 0;
      h = (h + (f.working_dir.charCodeAt(0) || 0)) | 0;
    }
    return h;
  }, [files]);
  // 哈希命中时沿用旧数组（内容一致）：deps 只留 treeKey，父级刷新给新数组身份
  // （GitPanel 每次 status 刷新都 filter 出新数组）不再触发重建树
  const treeFilesRef = useRef<{ key: number; files: GitFileChange[] }>({
    key: Number.NaN,
    files: []
  });
  if (treeFilesRef.current.key !== treeKey) treeFilesRef.current = { key: treeKey, files };
  const roots = useMemo(() => buildFileTree(treeFilesRef.current.files), [treeKey]);

  /** 空 = 全开（对齐原 DirRow useState(true)） */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  useEffect(() => {
    if (!activeZone) {
      setFocusedId(null);
    } else if (selectedFile != null) {
      setFocusedId(selectedFile);
    }
  }, [selectedFile, activeZone]);

  const nodeById = useMemo(() => indexNodes(roots), [roots]);

  const visibleRows = useMemo(
    () => flattenVisibleRows(roots, collapsed, zone),
    [roots, collapsed, zone]
  );

  const rowById = useMemo(() => {
    const map = new Map<string, TreeNavRow>();
    for (const row of visibleRows) map.set(row.id, row);
    return map;
  }, [visibleRows]);

  // 多选（Ctrl/⌘ 点选、Shift 范围）：本区独立，不跨 unstaged/staged
  const selectionOrderedIds = useMemo(() => visibleRows.map((r) => r.id), [visibleRows]);
  const selection = useListSelection({ orderedIds: selectionOrderedIds });

  /** 行点击修饰键分流：返回 true = 已作为选区操作消费 */
  const handleModifierClick = useCallback(
    (id: string, e: React.MouseEvent): boolean => selection.click(id, e) !== 'plain',
    [selection.click]
  );

  /** id 落在多选区内时返回整选区文件路径（按可见行序、目录展开为其文件），否则 null */
  const resolveSelectionPaths = useCallback(
    (id: string): string[] | null => {
      if (!selection.isSelected(id) || selection.selectedIds.size <= 1) return null;
      const out: string[] = [];
      const seen = new Set<string>();
      for (const row of visibleRows) {
        if (!selection.isSelected(row.id)) continue;
        const node = nodeById.get(row.id);
        if (!node) continue;
        const paths = node.kind === 'dir' ? node.filePaths : node.file ? [node.file.path] : [];
        for (const p of paths) {
          if (!seen.has(p)) {
            seen.add(p);
            out.push(p);
          }
        }
      }
      return out;
    },
    [selection, visibleRows, nodeById]
  );

  const onPathDragStart = useCallback(
    (e: React.DragEvent, relativePath: string) => {
      const root = repoPath?.trim();
      if (!root) {
        e.preventDefault();
        return;
      }
      // 拖动选区内行 = 拖整选区（目录展开为其文件）；否则只拖该行
      const rels = resolveSelectionPaths(relativePath) ?? [relativePath];
      const abs = rels.map((rel) => joinRepoRel(root, rel));
      setPathDragData(e.dataTransfer, abs);
      try {
        window.api.shell.startPathDrag?.(abs);
      } catch {
        // HTML5 MIME 仍可用
      }
    },
    [repoPath, resolveSelectionPaths]
  );
  const pathDragHandler = repoPath?.trim() ? onPathDragStart : undefined;

  const onToggleExpand = useCallback(
    (path: string) => {
      const key = collapsedKey(zone, path);
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setFocusedId(path);
    },
    [zone]
  );

  const selectFileRow = useCallback(
    (f: GitFileChange, z: 'unstaged' | 'staged') => {
      setFocusedId(f.path);
      onSelectFile(f, z);
    },
    [onSelectFile]
  );

  const onNavSelect = useCallback(
    (id: string) => {
      setFocusedId(id);
      const node = nodeById.get(id);
      if (!node || node.kind !== 'file' || !node.file || busy) return;
      onSelectFile(node.file, zone);
    },
    [nodeById, busy, onSelectFile, zone]
  );

  const { onTreeKeyDown, getItemProps } = useTreeKeyboardNav({
    rows: visibleRows,
    selectedId: focusedId,
    onSelect: onNavSelect,
    onToggleExpand,
    disabled: busy
  });

  const onScrollKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 多选键（Ctrl+A / Esc / Shift+↑↓）优先；Shift+↑↓ 同时移焦点并扩选区
      if (selection.handleKeyDown(e, { currentId: focusedId, onMoveFocus: onNavSelect })) return;
      onTreeKeyDown(e);
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (focusedId == null || busy) return;
      const row = rowById.get(focusedId);
      if (!row) return;
      e.preventDefault();
      if (row.expandable) {
        onToggleExpand(focusedId);
      } else {
        const node = nodeById.get(focusedId);
        if (node?.kind === 'file' && node.file) {
          onSelectFile(node.file, zone);
        }
      }
    },
    [
      selection,
      onTreeKeyDown,
      focusedId,
      busy,
      rowById,
      onToggleExpand,
      nodeById,
      onSelectFile,
      zone,
      onNavSelect
    ]
  );

  const ctxHandler = readOnly ? undefined : onContextMenu;

  if (roots.length === 0) return <div className="empty-hint">{t('无文件')}</div>;

  return (
    <div
      className="git-change-tree file-tree-scroll"
      tabIndex={0}
      onKeyDown={onScrollKeyDown}
    >
      {roots.map((n) =>
        n.kind === 'dir' ? (
          <DirRow
            key={`d:${n.path}`}
            node={n}
            depth={0}
            zone={zone}
            collapsed={collapsed}
            selectedFile={selectedFile}
            activeZone={activeZone}
            focusedId={focusedId}
            busy={busy}
            readOnly={readOnly}
            badgeOf={badgeOf}
            getItemProps={getItemProps}
            onToggle={onToggleExpand}
            onSelectFile={selectFileRow}
            onTogglePaths={onTogglePaths}
            onContextMenu={ctxHandler}
            onPathDragStart={pathDragHandler}
            onModifierClick={handleModifierClick}
            onResolveSelectionPaths={resolveSelectionPaths}
            isMultiselected={selection.isSelected}
          />
        ) : (
          <FileRow
            key={`f:${n.path}`}
            node={n}
            depth={0}
            zone={zone}
            selected={activeZone && selectedFile === n.path}
            focused={activeZone && focusedId === n.path}
            busy={busy}
            badge={badgeOf(n.file!)}
            readOnly={readOnly}
            getItemProps={getItemProps}
            onSelect={selectFileRow}
            onTogglePaths={onTogglePaths}
            onContextMenu={ctxHandler}
            onPathDragStart={pathDragHandler}
            onModifierClick={handleModifierClick}
            onResolveSelectionPaths={resolveSelectionPaths}
            isMultiselected={selection.isSelected}
          />
        )
      )}
    </div>
  );
}
