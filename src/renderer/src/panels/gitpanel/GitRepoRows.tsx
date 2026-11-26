import type { ContextMenuPoint } from '../../components/ContextMenu';
/**
 * GitPanel 仓库树行组件（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，原样迁出）：
 * FolderRow / RepoRow（memo 隔离整面板重渲）与 status 拉取骨架。
 */
import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconBranch, IconFolder, IconFolderOpen } from '../../components/icons';
import { IconEye, IconEyeOff, IconPin } from './GitPanelIcons';

export type TreeItemProps = { tabIndex: 0 | -1; ref?: (el: HTMLElement | null) => void };

/** 仓库树目录/工作区行（纯展示 + 稳定回调，memo 隔离整面板重渲） */
export const FolderRow = memo(function FolderRow({
  id,
  depth,
  label,
  source,
  absPath,
  expandable,
  expanded,
  focused,
  getItemProps,
  onRowClick,
  onModifierClick,
  isMultiselected,
  onPathDragStart
}: {
  id: string;
  depth: number;
  label: string;
  source?: boolean;
  absPath: string | null;
  expandable: boolean;
  expanded: boolean;
  focused: boolean;
  getItemProps: (id: string) => TreeItemProps;
  onRowClick: (id: string) => void;
  /** Ctrl/⌘/Shift 修饰键点击：返回 true 表示已作为选区操作消费（不折叠/展开） */
  onModifierClick?: (id: string, e: React.MouseEvent) => boolean;
  /** 多选态查询（稳定回调，行内自取） */
  isMultiselected?: (id: string) => boolean;
  onPathDragStart: (e: React.DragEvent, absPaths: string[]) => void;
}): React.JSX.Element {
  const canDrag = Boolean(absPath);
  const multiselected = isMultiselected?.(id) ?? false;
  return (
    <div
      {...getItemProps(id)}
      className={`file-tree-row is-dir${source ? ' git-source-row' : ''}${focused ? ' is-active' : ''}${multiselected ? ' is-multiselected' : ''}`}
      style={{ '--git-tree-depth': depth } as React.CSSProperties}
      title={absPath ?? undefined}
      aria-label={source ? `${label} ${absPath}` : undefined}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={focused || multiselected}
      draggable={canDrag}
      onDragStart={canDrag && absPath ? (e) => onPathDragStart(e, [absPath]) : undefined}
      onClick={(e) => {
        if (onModifierClick?.(id, e)) return;
        onRowClick(id);
      }}
    >
      {/* 展开态由文件夹图标本身表达（打开/闭合），不再单列指示器 */}
      <span className="file-tree-folder" aria-hidden>
        {expandable && expanded ? <IconFolderOpen size={13} /> : <IconFolder size={13} />}
      </span>
      <span className="file-tree-name is-dir-name">{label}</span>
    </div>
  );
});

/** 仓库行同时保有选仓与目录开合能力。 */
export const RepoRow = memo(function RepoRow({
  id,
  depth,
  name,
  path,
  branch,
  ahead,
  behind,
  dirty,
  source,
  pinned,
  hidden,
  focused,
  expandable,
  expanded,
  getItemProps,
  onToggle,
  onSelect,
  onPathDragStart,
  onTogglePin,
  onToggleHidden,
  onModifierClick,
  isMultiselected,
  onContextMenu
}: {
  id: string;
  depth: number;
  name: string;
  path: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  source?: boolean;
  pinned: boolean;
  hidden: boolean;
  focused: boolean;
  expandable: boolean;
  expanded: boolean;
  getItemProps: (id: string) => TreeItemProps;
  onToggle: (id: string) => void;
  onSelect: (id: string, repoPath: string) => void;
  onPathDragStart: (e: React.DragEvent, absPaths: string[]) => void;
  onTogglePin: (repoPath: string) => void;
  onToggleHidden: (repoPath: string) => void;
  onModifierClick?: (id: string, e: React.MouseEvent) => boolean;
  isMultiselected?: (id: string) => boolean;
  onContextMenu?: (id: string, point: ContextMenuPoint) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const branchMeta = `${dirty === undefined ? '…' : branch ?? '—'}${
    ahead || behind ? ` ↑${ahead ?? 0} ↓${behind ?? 0}` : ''
  }`;
  const multiselected = isMultiselected?.(id) ?? false;
  return (
    <div
      {...getItemProps(id)}
      className={`file-tree-row is-file git-repo-tree-leaf${
        focused ? ' is-active' : ''
      }${multiselected ? ' is-multiselected' : ''}${pinned ? ' is-pinned' : ''}${hidden ? ' is-hidden-repo' : ''}`}
      style={{ '--git-tree-depth': depth } as React.CSSProperties}
      title={path}
      role="treeitem"
      aria-label={source ? `${name} ${path}` : undefined}
      aria-level={depth + 1}
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={focused || multiselected}
      draggable
      onDragStart={(e) => onPathDragStart(e, [path])}
      onClick={(e) => {
        if (onModifierClick?.(id, e)) return;
        onSelect(id, path);
        // 带子仓的仓库行：点击在选中之外同时展开/收起（与目录行行为对齐）
        if (expandable) onToggle(id);
      }}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(id, { x: e.clientX, y: e.clientY, anchor: e.currentTarget });
            }
          : undefined
      }
    >
      <span className="file-tree-folder" aria-hidden>
        {expandable ? (expanded ? <IconFolderOpen size={13} /> : <IconFolder size={13} />) : <IconBranch size={13} />}
      </span>
      <span className="git-repo-label">
        <span className="file-tree-name">{name}</span>
        {dirty ? <span className="git-dirty-dot" role="img" aria-label={t('有未提交改动')} title={t('有未提交改动')} /> : null}
        {hidden ? (
          <span className="git-hidden-tag" title={t('已隐藏')}>
            <IconEyeOff />
          </span>
        ) : null}
      </span>
      <span className="git-repo-branch" title={branchMeta}>
        {branchMeta}
      </span>
      <span className="git-repo-item-actions">
        <button
          type="button"
          className={`git-pin-btn git-hide-btn${hidden ? ' is-hidden' : ''}`}
          title={hidden ? t('显示此仓库') : t('隐藏此仓库')}
          aria-label={hidden ? t('显示此仓库') : t('隐藏此仓库')}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleHidden(path);
          }}
        >
          {hidden ? <IconEye /> : <IconEyeOff />}
        </button>
        <button
          type="button"
          className={`git-pin-btn${pinned ? ' is-pinned' : ''}`}
          title={pinned ? t('取消置顶') : t('置顶')}
          aria-label={pinned ? t('取消置顶') : t('置顶')}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(path);
          }}
        >
          <IconPin />
        </button>
      </span>
    </div>
  );
});

/** status 拉取期间 Changes 区骨架（复用 skel.css 的 shimmer 体系） */
export function GitChangesSkeleton(): React.JSX.Element {
  return (
    <div className="git-changes-skel" aria-hidden>
      <div className="ws-skel-block ws-skel-row" />
      <div className="ws-skel-block ws-skel-row short" />
      <div className="ws-skel-block ws-skel-row" />
      <div className="ws-skel-block ws-skel-row short" />
      <div className="ws-skel-block ws-skel-row" />
    </div>
  );
}
