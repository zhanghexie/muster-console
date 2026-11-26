/**
 * 自由视图画布 · 世界层渲染：分区 hull（垫底纯背景）→ 手动组框 → 连线 SVG 与标签 chip →
 * 会话节点 / 思路便签 → 交接占位假节点 → 顶层参考线与拖出中的连线。
 * JSX 从 FreeCanvas.tsx 原样拆出；层叠顺序、data-* 命中锚点与事件冒泡行为不变。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { getFreeViewLayout } from '../freeViewStore';
import { edgeKindOf, FREE_NODE_H, FREE_NODE_W, FREE_STICKY_W, type FreePoint, type FreeSticky } from '../freeViewGeom';
import { CanvasNode, StickyNode } from './nodeCards';
import type { CanvasEditValue, EditStateSetter } from './useCanvasEdits';
import type { EdgeView, GroupView, HullView } from './useCanvasViews';
import type { FreeCanvasItem } from './types';

export interface CanvasWorldProps {
  onEditTodo?: (id: string) => void;
  items: FreeCanvasItem[];
  /** 布局里的会话节点位置 */
  nodes: Record<string, FreePoint>;
  stickies: FreeSticky[];
  /** 卡片备注 */
  notes: Record<string, string>;
  noteEdit: CanvasEditValue | null;
  stickyEdit: CanvasEditValue | null;
  edgeLabelEdit: CanvasEditValue | null;
  groupRename: CanvasEditValue | null;
  commitGroupRename: () => void;
  setGroupRename: EditStateSetter;
  commitEdgeLabel: () => void;
  setEdgeLabelEdit: EditStateSetter;
  changeNoteEdit: (id: string, value: string) => void;
  commitNoteEdit: () => void;
  cancelNoteEdit: () => void;
  changeStickyEdit: (id: string, value: string) => void;
  commitStickyEdit: () => void;
  cancelStickyEdit: () => void;
  /** 便签「发起任务」→ NewTaskDialog 预填思路全文 */
  onRequestCreate: (opts: { world: FreePoint; initialTask?: string; stickyId?: string }) => void;
  cancelHandover: (jobId: string) => void;
  selNodeSet: ReadonlySet<string>;
  selEdgeSet: ReadonlySet<string>;
  selGroupSet: ReadonlySet<string>;
  zoom: number;
  /** 悬停卡片所属分区 id（hull 微高亮） */
  hotZone: string | null;
  guides: Array<{ axis: 'x' | 'y'; at: number; from: number; to: number }>;
  linkDrag: {
    from: string;
    fromPort: 'n' | 'e' | 's' | 'w';
    to: FreePoint;
    toOut: FreePoint;
    hoverId?: string;
    hoverPort?: 'n' | 'e' | 's' | 'w';
  } | null;
  linkPath: { path: string } | null;
  /** 交接占位（画布假节点）：jobId → 落点与来源 */
  handoverStubs: Record<string, { world: FreePoint; from: string; fromPort: 'n' | 'e' | 's' | 'w' }>;
  /** 源节点徽标：会话 id → jobId */
  handoverJobs: Record<string, string>;
  sourceById: Map<string, FreeCanvasItem>;
  edgeViews: EdgeView[];
  groupViews: GroupView[];
  hullViews: HullView[];
}

export function CanvasWorld(props: CanvasWorldProps): React.JSX.Element {
  const {
    items,
    nodes,
    stickies,
    notes,
    noteEdit,
    stickyEdit,
    edgeLabelEdit,
    groupRename,
    commitGroupRename,
    setGroupRename,
    commitEdgeLabel,
    setEdgeLabelEdit,
    changeNoteEdit,
    commitNoteEdit,
    cancelNoteEdit,
    changeStickyEdit,
    commitStickyEdit,
    cancelStickyEdit,
    onRequestCreate,
    cancelHandover,
    selNodeSet,
    selEdgeSet,
    selGroupSet,
    zoom,
    hotZone,
    guides,
    linkDrag,
    linkPath,
    handoverStubs,
    handoverJobs,
    sourceById,
    edgeViews,
    groupViews,
    hullViews
  } = props;
  const { t } = useTranslation();
  const nodePos = nodes;

  return (
    <>
      {/* 工作区分区 hull：纯背景、事件穿透，垫在手动组框之下 */}
      <svg className="fc-svg fc-hull-svg" aria-hidden>
        {hullViews.map((h) => (
          <path
            key={h.id || '__unzoned__'}
            className={`fc-hull${h.unzoned ? ' is-unzoned' : ''}${hotZone === h.id ? ' is-hot' : ''}`}
            d={h.path}
          />
        ))}
      </svg>
      {hullViews.map((h) => (
        <span
          key={`lbl-${h.id || '__unzoned__'}`}
          className={`fc-hull-label${h.unzoned ? ' is-unzoned' : ''}${hotZone === h.id ? ' is-hot' : ''}`}
          style={{ transform: `translate3d(${h.labelX}px, ${h.labelY}px, 0)` }}
        >
          {h.label}
        </span>
      ))}

      {/* 分组框（垫在节点与连线之下，分区 hull 之上） */}
      {groupViews.map(({ g, box }) => (
        <div
          key={g.id}
          className={`fc-group${selGroupSet.has(g.id) ? ' is-selected' : ''}`}
          data-fcgroup={g.id}
          style={{
            transform: `translate3d(${box.x}px, ${box.y}px, 0)`,
            width: box.w,
            height: box.h
          }}
        >
          {groupRename?.id === g.id ? (
            <input
              className="fc-group-input"
              value={groupRename.value}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setGroupRename({ id: g.id, value: e.target.value })}
              onBlur={commitGroupRename}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitGroupRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setGroupRename(null);
                }
              }}
            />
          ) : (
            <span className="fc-group-label" data-fcglabel title={t('双击重命名分组')}>
              {g.label} · {g.members.length}
            </span>
          )}
        </div>
      ))}

      {/* 连线层 */}
      <svg className="fc-svg">
        {edgeViews.map(({ e, path, an, mid, angle, aName, bName }) => {
          const sel = selEdgeSet.has(e.id);
          return (
            <g key={e.id} className={sel ? 'is-selected' : undefined}>
              <title>{`${aName} → ${bName}`}</title>
              <path className="fc-edge-hit" data-fc-edge={e.id} d={path} />
              <path className={`fc-edge${sel ? ' is-selected' : ''}`} d={path} />
              <path
                className={`fc-arrow${sel ? ' is-selected' : ''}`}
                d="M 0 0 L -8 -4.5 L -8 4.5 Z"
                transform={`translate(${an.b.x} ${an.b.y}) rotate(${angle}) scale(${1 / zoom})`}
              />
            </g>
          );
        })}
      </svg>
      {edgeViews.map(({ e, mid }) => {
        const kind = edgeKindOf(e);
        const editing = edgeLabelEdit?.id === e.id;
        if (!kind && !e.label && !editing) return null;
        return (
          <div
            key={`lbl-${e.id}`}
            className="fc-edge-chipwrap"
            style={{ transform: `translate3d(${mid.x}px, ${mid.y}px, 0) translate(-50%, -50%)` }}
          >
            {kind ? (
              <span className="fc-edge-chip is-kind">{kind === 'fork' ? t('fork') : t('交接')}</span>
            ) : null}
            {editing ? (
              <input
                className="fc-edge-label-input fc-ui"
                value={edgeLabelEdit?.value ?? ''}
                autoFocus
                aria-label={t('连线标签')}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(ev) => setEdgeLabelEdit({ id: e.id, value: ev.target.value })}
                onBlur={commitEdgeLabel}
                onKeyDown={(ev) => {
                  ev.stopPropagation();
                  if (ev.nativeEvent.isComposing || ev.keyCode === 229) return;
                  if (ev.key === 'Enter') {
                    ev.preventDefault();
                    commitEdgeLabel();
                  } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    commitEdgeLabel();
                  }
                }}
              />
            ) : e.label ? (
              <span className="fc-edge-chip">{e.label}</span>
            ) : null}
          </div>
        );
      })}

      {/* 节点 */}
      {items.map((item) => {
        const p = nodePos[item.id];
        if (!p) return null;
        return (
          <CanvasNode
            key={item.id}
            item={item}
            onEditTodo={props.onEditTodo}
            x={p.x}
            y={p.y}
            selected={selNodeSet.has(item.id)}
            zoomHint={t('双击打开会话 · 拖动移动')}
            note={notes[item.id] ?? ''}
            editing={noteEdit?.id === item.id}
            editValue={noteEdit?.id === item.id ? noteEdit.value : ''}
            hotPort={
              linkDrag?.hoverId === item.id
                ? linkDrag.hoverPort
                : linkDrag?.from === item.id
                  ? linkDrag.fromPort
                  : undefined
            }
            notePlaceholder={t('添加备注')}
            onNoteChange={changeNoteEdit}
            onNoteCommit={commitNoteEdit}
            onNoteCancel={cancelNoteEdit}
            handoverJobId={handoverJobs[item.id]}
            handoverLabel={t('交接中')}
            handoverCancelLabel={t('取消交接')}
            onCancelHandover={cancelHandover}
          />
        );
      })}
      {stickies.map((st) => (
        <StickyNode
          key={st.id}
          sticky={st}
          selected={selNodeSet.has(st.id)}
          editing={stickyEdit?.id === st.id}
          editValue={stickyEdit?.id === st.id ? stickyEdit.value : st.text}
          hotPort={
            linkDrag?.hoverId === st.id
              ? linkDrag.hoverPort
              : linkDrag?.from === st.id
                ? linkDrag.fromPort
                : undefined
          }
          placeholder={t('写任务思路…')}
          startLabel={t('发起任务')}
          hint={t('双击编辑便签')}
          onChange={changeStickyEdit}
          onCommit={commitStickyEdit}
          onCancel={cancelStickyEdit}
          onStartTask={(id) => {
            const cur = getFreeViewLayout().stickies?.find((s) => s.id === id);
            if (!cur) return;
            onRequestCreate({
              world: { x: cur.x + FREE_STICKY_W + 40, y: cur.y },
              initialTask: cur.text,
              stickyId: id
            });
          }}
        />
      ))}

      {/* 准备交接文档期间的画布占位；确认新任务后再创建真实节点 */}
      {Object.entries(handoverStubs).map(([jobId, stub]) => (
        <div
          key={jobId}
          className="fc-node fc-handover-stub"
          style={{
            transform: `translate3d(${stub.world.x}px, ${stub.world.y}px, 0)`,
            width: FREE_NODE_W,
            height: FREE_NODE_H
          }}
        >
          <div className="fc-handover-stub-card">
            <span>{t('交接中')}</span>
            <span className="fc-handover-stub-from">
              {sourceById.get(stub.from)?.name ?? ''}
            </span>
          </div>
        </div>
      ))}

      {/* 顶层装饰：参考线 + 拖出中的连线（不吃指针） */}
      <svg className="fc-svg fc-svg-top">
        {guides.map((g, i) =>
          g.axis === 'x' ? (
            <line
              key={`gx${i}`}
              className="fc-guide-line"
              x1={g.at}
              y1={g.from - 10}
              x2={g.at}
              y2={g.to + 10}
            />
          ) : (
            <line
              key={`gy${i}`}
              className="fc-guide-line"
              x1={g.from - 10}
              y1={g.at}
              x2={g.to + 10}
              y2={g.at}
            />
          )
        )}
        {linkPath ? <path className="fc-link-live" d={linkPath.path} /> : null}
      </svg>
    </>
  );
}
