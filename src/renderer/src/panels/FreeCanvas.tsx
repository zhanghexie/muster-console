/**
 * 自由视图画布（Obsidian canvas 式）——组合入口。
 * 职责已按画布分层拆进 panels/freeCanvas/*（行为与拆分前一致）：
 * - types.ts            对外类型与手势内部状态契约
 * - cardHeights.ts      卡片实测高度（DOM 测高）
 * - canvasOps.ts        框选命中 / 拖拽吸附位移 / 同对连线去重（纯函数）
 * - nodeCards.tsx       会话卡与便签的 memo 纯渲染
 * - useCanvasEdits      备注 / 便签 / 连线标签 / 组名编辑态
 * - useCanvasMetrics    集合派生 + 实测高度 + hOf/posOf/rectOf
 * - useCanvasSelection  选集三态 + 打组 / 解散 / 删除
 * - useCanvasCamera     平移缩放相机 + fit + 滚轮
 * - useCanvasCreate     拉线菜单（fork/交接/便签）+ placeSession + 交接事件
 * - useCanvasSync       会话集补位 / 修剪 + 首铺自动取景
 * - useCanvasArrange    一键自动布局 + 撤销 toast
 * - useCanvasKeyboard   键盘手势 + Space 态
 * - useCanvasPointer    视口统一指针手势（分类派发）
 * - useCanvasInteractions 双击分类 + 右键菜单
 * - useCanvasViews      连线 / 组框 / hull / 拉线预览推导
 * - CanvasWorld/CanvasControls  世界层与屏幕层 JSX
 * 本文件只做 hook 接线与视口骨架；对外 API（FreeCanvas/Handle/Item/Props）不变。
 */
import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useFreeViewLayout } from './freeViewStore';
import { FREE_GRID_X, FREE_GRID_Y } from './freeViewGeom';
import { useUiStore } from '../store';
import type { FreeCanvasHandle, FreeCanvasProps } from './freeCanvas/types';
import { CanvasWorld } from './freeCanvas/CanvasWorld';
import { CanvasControls } from './freeCanvas/CanvasControls';
import { useCanvasEdits } from './freeCanvas/useCanvasEdits';
import { useCanvasMetrics } from './freeCanvas/useCanvasMetrics';
import { useCanvasSelection } from './freeCanvas/useCanvasSelection';
import { useCanvasCamera } from './freeCanvas/useCanvasCamera';
import { useCanvasCreate } from './freeCanvas/useCanvasCreate';
import { useCanvasSync } from './freeCanvas/useCanvasSync';
import { useCanvasArrange } from './freeCanvas/useCanvasArrange';
import { useCanvasKeyboard } from './freeCanvas/useCanvasKeyboard';
import { useCanvasPointer } from './freeCanvas/useCanvasPointer';
import { useCanvasInteractions } from './freeCanvas/useCanvasInteractions';
import { useCanvasViews } from './freeCanvas/useCanvasViews';

export type { FreeCanvasItem, FreeCanvasHandle, FreeCanvasProps } from './freeCanvas/types';

/**
 * 自由视图画布（Obsidian canvas 式）：
 * - 空白左键拖动 = 框选（shift 累加）；空格按住 / 右键拖动 = 平移；滚轮以光标为中心缩放；
 * - 节点拖拽带 Figma 式对齐参考线（边/中线吸附），多选拖拽整组跟手；
 * - 节点四缘圆点拖出连线（按拖出/落入位置记 fromPort/toPort；旧边无 port 仍按中心自动选边）；连线可点选，Delete 删除；
 * - 卡片备注经右键菜单添加/编辑（只存画布 layout.notes）；有内容才显示并抬高卡片；
 * - Ctrl+G 打组（组框实时包住成员、拖组框整组移动、双击组名内联重命名）、
 *   Ctrl+Shift+D 解散（避开 globalBoard.toggle 的 Ctrl+Shift+G）；Delete 删选中连线 / 解散选中组；
 * - 工作区分区 hull：按 zoneId 实时凸包（纯背景、事件穿透，垫在手动组框下）；
 * - 布局（节点位/连线/分组/相机/视图档/过滤开关）持久在 freeViewStore（localStorage）。
 *   会话集同步用 aliveIds（全量），渲染用 items（可被工作区过滤）。
 * 事件全走视口统一分类派发（节点纯渲染保 memo）；会话集变化自动补位/修剪。
 */
export const FreeCanvas = forwardRef<FreeCanvasHandle, FreeCanvasProps>(function FreeCanvas(
  { items, aliveIds, zones, workspaceOrder, active, onSelectSession, onContextMenu, onRequestCreate },
  ref
): React.JSX.Element {
  const { flashTip } = useUiStore();
  const layout = useFreeViewLayout();
  const { pan, zoom, nodes, edges, groups } = layout;
  const notes = layout.notes ?? {};
  const stickies = layout.stickies ?? [];
  const worldRef = useRef<HTMLDivElement>(null);

  const [selNodes, setSelNodes] = useState<string[]>([]);
  const [selEdges, setSelEdges] = useState<string[]>([]);
  const [selGroups, setSelGroups] = useState<string[]>([]);

  const edits = useCanvasEdits({ notes, setSelNodes, setSelEdges, setSelGroups });
  const metrics = useCanvasMetrics({
    items,
    stickies,
    notes,
    noteEdit: edits.noteEdit,
    nodes,
    worldRef,
    active
  });
  const selection = useCanvasSelection({
    sessionIdSet: metrics.sessionIdSet,
    stickyIds: metrics.stickyIds,
    groups,
    selNodes,
    selEdges,
    selGroups,
    setSelNodes,
    setSelEdges,
    setSelGroups
  });
  const camera = useCanvasCamera({ active, items, stickies, hOf: metrics.hOf, setSelEdges });
  const create = useCanvasCreate({
    posOf: metrics.posOf,
    flashTip,
    setStickyEdit: edits.setStickyEdit,
    setSelNodes,
    setSelEdges,
    setSelGroups,
    onRequestCreate
  });
  useCanvasSync({
    aliveIds,
    visibleKey: metrics.visibleKey,
    visibleIdSet: metrics.visibleIdSet,
    setSelNodes,
    items,
    vpRef: camera.vpRef,
    pendingPlaceRef: create.pendingPlaceRef
  });
  const arrange = useCanvasArrange({
    aliveIds,
    zones,
    workspaceOrder,
    items,
    measuredH: metrics.measuredH,
    hOf: metrics.hOf,
    vpRef: camera.vpRef,
    worldRef
  });
  const keyboard = useCanvasKeyboard({
    active,
    deleteSelection: selection.deleteSelection,
    groupSelection: selection.groupSelection,
    ungroupSelection: selection.ungroupSelection,
    itemIds: metrics.itemIds,
    stickyIds: metrics.stickyIds,
    runAutoArrange: arrange.runAutoArrange,
    setSelNodes,
    setSelEdges,
    setSelGroups
  });
  const pointer = useCanvasPointer({
    active,
    selNodes,
    setSelNodes,
    setSelEdges,
    setSelGroups,
    visibleIdSet: metrics.visibleIdSet,
    sessionIdSet: metrics.sessionIdSet,
    stickyById: metrics.stickyById,
    stickies,
    hOf: metrics.hOf,
    rectOf: metrics.rectOf,
    localPoint: camera.localPoint,
    toWorld: camera.toWorld,
    noteEdit: edits.noteEdit,
    commitNoteEdit: edits.commitNoteEdit,
    interruptArrange: arrange.interruptArrange,
    onSelectSession,
    isLinkMenuOpen: create.isLinkMenuOpen,
    cancelLinkMenuRequest: create.cancelLinkMenuRequest,
    requestLinkMenu: create.requestLinkMenu,
    spaceRef: keyboard.spaceRef
  });
  const interactions = useCanvasInteractions({
    active,
    onContextMenu,
    onRequestCreate,
    onSelectSession,
    localPoint: camera.localPoint,
    toWorld: camera.toWorld,
    blankMovedRef: pointer.blankMovedRef,
    rightPanMovedRef: pointer.rightPanMovedRef,
    setGroupRename: edits.setGroupRename,
    setEdgeLabelEdit: edits.setEdgeLabelEdit,
    setStickyEdit: edits.setStickyEdit,
    setSelNodes,
    setSelEdges,
    setSelGroups
  });
  const views = useCanvasViews({
    edges,
    groups,
    items,
    nodes,
    visibleIdSet: metrics.visibleIdSet,
    rectOf: metrics.rectOf,
    hOf: metrics.hOf,
    stickyById: metrics.stickyById,
    linkDrag: pointer.linkDrag
  });

  const sourceById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  useImperativeHandle(
    ref,
    () => ({ startNoteEdit: edits.startNoteEdit, clearNote: edits.clearNote, placeSession: create.placeSessionNode }),
    [edits.startNoteEdit, edits.clearNote, create.placeSessionNode]
  );

  return (
    <div
      ref={camera.vpRef}
      className={`fc-viewport${keyboard.spaceDown ? ' is-space' : ''}${
        pointer.dragRef.current?.mode === 'pan' ? ' is-panning' : ''
      }${pointer.linkDrag ? ' is-linking' : ''}${arrange.arranging ? ' is-arranging' : ''}`}
      onPointerDown={pointer.onPointerDown}
      onPointerMove={pointer.onPointerMove}
      onPointerUp={pointer.onPointerUp}
      onPointerCancel={pointer.onPointerCancel}
      onPointerLeave={() => {
        if (!pointer.dragRef.current) pointer.setHotZone(null);
      }}
      onDoubleClick={interactions.onDoubleClick}
      onContextMenu={interactions.onCanvasContextMenu}
      style={{
        backgroundImage: 'radial-gradient(var(--fc-dot) 1px, transparent 1.2px)',
        backgroundSize: `${FREE_GRID_X * zoom}px ${FREE_GRID_Y * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`
      }}
    >
      <div
        ref={worldRef}
        className="fc-world"
        style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
      >
        <CanvasWorld
          onEditTodo={onSelectSession}
          items={items}
          nodes={nodes}
          stickies={stickies}
          notes={notes}
          noteEdit={edits.noteEdit}
          stickyEdit={edits.stickyEdit}
          edgeLabelEdit={edits.edgeLabelEdit}
          groupRename={edits.groupRename}
          commitGroupRename={edits.commitGroupRename}
          setGroupRename={edits.setGroupRename}
          commitEdgeLabel={edits.commitEdgeLabel}
          setEdgeLabelEdit={edits.setEdgeLabelEdit}
          changeNoteEdit={edits.changeNoteEdit}
          commitNoteEdit={edits.commitNoteEdit}
          cancelNoteEdit={edits.cancelNoteEdit}
          changeStickyEdit={edits.changeStickyEdit}
          commitStickyEdit={edits.commitStickyEdit}
          cancelStickyEdit={edits.cancelStickyEdit}
          onRequestCreate={onRequestCreate}
          cancelHandover={create.cancelHandover}
          selNodeSet={selection.selNodeSet}
          selEdgeSet={selection.selEdgeSet}
          selGroupSet={selection.selGroupSet}
          zoom={zoom}
          hotZone={pointer.hotZone}
          guides={pointer.guides}
          linkDrag={pointer.linkDrag}
          linkPath={views.linkPath}
          handoverStubs={create.handoverStubs}
          handoverJobs={create.handoverJobs}
          sourceById={sourceById}
          edgeViews={views.edgeViews}
          groupViews={views.groupViews}
          hullViews={views.hullViews}
        />
      </div>

      <CanvasControls
        marquee={pointer.marquee}
        zoomPct={Math.round(zoom * 100)}
        canGroup={selection.canGroup}
        inAnyGroup={selection.inAnyGroup}
        runAutoArrange={arrange.runAutoArrange}
        groupSelection={selection.groupSelection}
        ungroupSelection={selection.ungroupSelection}
        zoomAt={camera.zoomAt}
        fitView={camera.fitView}
        vpRef={camera.vpRef}
        toastPresence={arrange.toastPresence}
        undoArrange={arrange.undoArrange}
        linkMenu={create.linkMenu}
        sourceById={sourceById}
        onLinkMenu={create.onLinkMenu}
        closeLinkMenu={create.closeLinkMenu}
      />
    </div>
  );
});
