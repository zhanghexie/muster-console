/**
 * 自由视图画布 · 节点卡片纯渲染（会话卡 + 思路便签）。
 * 事件全部由视口统一分类派发（useCanvasPointer），入参原始值保 memo。
 * 从 FreeCanvas.tsx 原样拆出，渲染结构与行为不变。
 */
import React, { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BOARD_STATUS_PRESENTATION } from '../boardPresentation';
import { SessionStatusIcon } from '../../components/StatusIcon';
import { BoardHarnessAvatar } from '../BoardHarnessAvatar';
import { workspaceAccent } from '../../../../shared/workspaceAccent';
import {
  FREE_NODE_NOTE_MAX_LINES,
  FREE_STICKY_H,
  FREE_STICKY_W,
  type FreePort,
  type FreeSticky
} from '../freeViewGeom';
import type { FreeCanvasItem } from './types';
import { BoardTodoCard } from '../BoardTodoCard';

export const CanvasNode = memo(function CanvasNode({
  item,
  x,
  y,
  selected,
  zoomHint,
  note,
  editing,
  editValue,
  hotPort,
  notePlaceholder,
  onNoteChange,
  onNoteCommit,
  onNoteCancel,
  onEditTodo,
  handoverJobId,
  handoverLabel,
  handoverCancelLabel,
  onCancelHandover
}: {
  item: FreeCanvasItem;
  x: number;
  y: number;
  selected: boolean;
  zoomHint: string;
  note: string;
  editing: boolean;
  editValue: string;
  hotPort?: FreePort;
  notePlaceholder: string;
  onNoteChange: (id: string, v: string) => void;
  onNoteCommit: () => void;
  onNoteCancel: () => void;
  onEditTodo?: (id: string) => void;
  handoverJobId?: string;
  handoverLabel?: string;
  handoverCancelLabel?: string;
  onCancelHandover?: (jobId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const visual = BOARD_STATUS_PRESENTATION[item.status];
  const skipBlurRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);
  if (item.todoTask !== undefined) return <div className={`fc-node${selected ? ' is-selected' : ''}`} data-cnode={item.id} data-fc-kind="todo"
    data-fc-zone={item.zoneId} style={{ transform: `translate3d(${x}px, ${y}px, 0)` }}>
    <BoardTodoCard id={item.id} name={item.name} task={item.todoTask} workspaceName={item.workspaceName} onEdit={onEditTodo ? () => onEditTodo(item.id) : undefined} />
  </div>;
  return (
    <div
      className={`fc-node${selected ? ' is-selected' : ''}`}
      data-cnode={item.id}
      data-fc-zone={item.zoneId}
      style={{ transform: `translate3d(${x}px, ${y}px, 0)` }}
    >
      <div
        className={`board-card ${visual.toneClass}${item.isActive ? ' active' : ''}${
          item.needsUnread === true ? ' is-needs-unread' : item.needsUnread === false ? ' is-needs-read' : ''
        }`}
        data-needs={item.needsUnread === true ? 'unread' : item.needsUnread === false ? 'read' : undefined}
        title={`${item.name} · ${item.runtimeLabel}\n${visual.label}${
          item.needsUnread === true ? ` · ${t('未读')}` : item.needsUnread === false ? ` · ${t('已读')}` : ''
        }${item.liveSummary ? ` — ${item.liveSummary}` : ''}\n${zoomHint}`}
      >
        <div className="board-card-head">
          <BoardHarnessAvatar harnessId={item.harnessId} runtimeLabel={item.runtimeLabel} />
          <span className="board-card-name">{item.name}</span>
          {item.needsUnread ? <span className="board-card-unread-pip" aria-label={t('未读')} /> : null}
        </div>
        <div className="board-card-meta">
          <span
            className={`board-status-ic${item.orchestrated ? ' is-orchestrated' : ''}`}
            title={item.orchestrated ? t('由调度编排') : undefined}
          >
            <SessionStatusIcon status={item.status} size={12} />
            {item.orchestrated ? (
              <span className="board-card-orch-dot" aria-label={t('由调度编排')} />
            ) : null}
          </span>
          {item.workspaceName ? (
            <span
              className="board-card-ws"
              style={item.zoneId ? ({ '--ws-accent': workspaceAccent(item.zoneId) } as React.CSSProperties) : undefined}
            >
              {item.workspaceName}
            </span>
          ) : null}
          {item.liveLabel ? (
            <span className={`fc-node-capsule k-${item.liveKind ?? 'info'}`}>{item.liveLabel}</span>
          ) : null}
        </div>
        {item.branch ? (
          <div className="board-card-branch" title={item.branchTitle ?? item.branch}>
            {item.branch}
          </div>
        ) : null}


        {editing ? (
          <textarea
            ref={taRef}
            className="fc-note-input"
            data-fc-note={item.id}
            value={editValue}
            placeholder={notePlaceholder}
            rows={Math.min(FREE_NODE_NOTE_MAX_LINES, Math.max(1, editValue.split('\n').length))}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onChange={(e) => onNoteChange(item.id, e.target.value)}
            onBlur={() => {
              if (skipBlurRef.current) {
                skipBlurRef.current = false;
                return;
              }
              onNoteCommit();
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                skipBlurRef.current = true;
                onNoteCancel();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
          />
        ) : note ? (
          <div className="fc-note" data-fc-note={item.id} title={note}>
            {note}
          </div>
        ) : null}
      </div>
      <span className={`fc-handle${hotPort === 'n' ? ' is-hot' : ''}`} data-fc-handle="n" aria-hidden />
      <span className={`fc-handle${hotPort === 'e' ? ' is-hot' : ''}`} data-fc-handle="e" aria-hidden />
      <span className={`fc-handle${hotPort === 's' ? ' is-hot' : ''}`} data-fc-handle="s" aria-hidden />
      <span className={`fc-handle${hotPort === 'w' ? ' is-hot' : ''}`} data-fc-handle="w" aria-hidden />
      {handoverJobId ? (
        <span className="fc-handover-badge">
          {handoverLabel}
          <button
            type="button"
            className="fc-handover-cancel"
            title={handoverCancelLabel}
            aria-label={handoverCancelLabel}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onCancelHandover?.(handoverJobId);
            }}
          >
            ×
          </button>
        </span>
      ) : null}
    </div>
  );
});

export const StickyNode = memo(function StickyNode({
  sticky,
  selected,
  editing,
  editValue,
  hotPort,
  placeholder,
  startLabel,
  hint,
  onChange,
  onCommit,
  onCancel,
  onStartTask
}: {
  sticky: FreeSticky;
  selected: boolean;
  editing: boolean;
  editValue: string;
  hotPort?: FreePort;
  placeholder: string;
  startLabel: string;
  hint: string;
  onChange: (id: string, v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onStartTask: (id: string) => void;
}): React.JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const skipBlurRef = useRef(false);
  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);
  return (
    <div
      className={`fc-sticky${selected ? ' is-selected' : ''}`}
      data-cnode={sticky.id}
      data-fc-kind="sticky"
      title={hint}
      style={{
        transform: `translate3d(${sticky.x}px, ${sticky.y}px, 0)`,
        width: FREE_STICKY_W,
        height: FREE_STICKY_H
      }}
    >
      {editing ? (
        <textarea
          ref={taRef}
          className="fc-sticky-input"
          value={editValue}
          placeholder={placeholder}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(sticky.id, e.target.value)}
          onBlur={() => {
            if (skipBlurRef.current) {
              skipBlurRef.current = false;
              return;
            }
            onCommit();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              skipBlurRef.current = true;
              onCancel();
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
      ) : (
        <div className="fc-sticky-text">{sticky.text || placeholder}</div>
      )}
      <button
        type="button"
        className="fc-sticky-start"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onStartTask(sticky.id);
        }}
      >
        {startLabel}
      </button>
      <span className={`fc-handle${hotPort === 'n' ? ' is-hot' : ''}`} data-fc-handle="n" aria-hidden />
      <span className={`fc-handle${hotPort === 'e' ? ' is-hot' : ''}`} data-fc-handle="e" aria-hidden />
      <span className={`fc-handle${hotPort === 's' ? ' is-hot' : ''}`} data-fc-handle="s" aria-hidden />
      <span className={`fc-handle${hotPort === 'w' ? ' is-hot' : ''}`} data-fc-handle="w" aria-hidden />
    </div>
  );
});
