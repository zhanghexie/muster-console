import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MOTION, usePresence, usePresenceValue } from '../../../src/renderer/src/components/motion';

export type PaneId = 'a' | 'b';
export type SplitDirection = 'row' | 'col';
export type SplitSide = 'left' | 'right' | 'top' | 'bottom';
export interface PrototypeState { panes: PaneId[]; direction: SplitDirection; ratio: number; focused: PaneId }
export type DropTarget = { kind: 'edge'; side: SplitSide };

/** Viewport coordinates against the fixed work surface. Only its four edges dock a pane. */
export function classifyDrop(
  x: number, y: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
): DropTarget | null {
  const px = x - rect.left, py = y - rect.top;
  if (rect.width <= 0 || rect.height <= 0 || px < 0 || py < 0 ||
      px > rect.width || py > rect.height) return null;
  const edgeX = Math.min(64, rect.width * 0.15);
  const edgeY = Math.min(56, rect.height * 0.15);
  const edges: [SplitSide, number][] = [
    ['left', px / edgeX], ['right', (rect.width - px) / edgeX],
    ['top', py / edgeY], ['bottom', (rect.height - py) / edgeY]
  ];
  edges.sort((a, b) => a[1] - b[1]);
  if (edges[0][1] <= 1) return { kind: 'edge', side: edges[0][0] };
  return null;
}

/** Preview and commit share one calculation; a missing target preserves the original layout. */
export function deriveDropLayout(current: PrototypeState, sourceId: PaneId, target: DropTarget | null): PrototypeState {
  if (!target || current.panes.length < 2 || !current.panes.includes(sourceId)) return current;
  const other = current.panes.find(id => id !== sourceId);
  if (!other) return current;
  const first = target.side === 'left' || target.side === 'top';
  return { ...current, panes: first ? [sourceId, other] : [other, sourceId],
    direction: target.side === 'left' || target.side === 'right' ? 'row' : 'col', ratio: 0.5, focused: sourceId };
}

const SESSIONS: Record<PaneId, { name: string; runtime: string; user: string; paragraphs: string[]; code: string; result: string }> = {
  a: {
    name: '整理分屏布局', runtime: 'Codex',
    user: '关闭分屏后，把剩下的会话恢复到完整工作面。',
    paragraphs: ['问题在于布局已经收起，但会话仍保留上一帧的半屏尺寸。', '我会让单屏和分屏使用同一套几何规则，并保留会话里的输入和滚动位置。'],
    code: 'const bounds = split.open\n  ? paneBounds[slot]\n  : fullBounds;',
    result: '已定位布局边界，正在补关闭与恢复的回归用例。'
  },
  b: {
    name: '打磨拖拽交互', runtime: 'Claude',
    user: '让拖拽的落点明确一些，不要遮住聊天内容。',
    paragraphs: ['把拖动入口收进顶部的三个点，正文区域继续接收输入和滚轮。', '拖起整个面板后，另一侧先铺满工作面。靠近四周边缘时预览新的分屏位置，松手前可以按 Escape 取消。'],
    code: 'pointerDown → 移动 6px → 拖动\nclick → 打开菜单',
    result: '保留清楚的预览，取消操作后布局不变。'
  }
};
const SESSION_IDS: PaneId[] = ['a', 'b'];
const initial: PrototypeState = { panes: ['a', 'b'], direction: 'row', ratio: 0.5, focused: 'a' };
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

interface Gesture {
  id: PaneId; pointerId: number; startX: number; startY: number;
  x: number; y: number; moved: boolean; target: DropTarget | null;
  original: PrototypeState;
  sourceBounds: Rectangle;
  grab: { x: number; y: number };
}
interface Rectangle { left: number; top: number; width: number; height: number }
interface FloatingPane { left: number; top: number; scale: number }
interface DragSnapshot {
  sourceId: PaneId;
  layout: PrototypeState;
  width: number;
  height: number;
  target: DropTarget | null;
  sourceBounds: Rectangle;
  floating: FloatingPane;
  remainingId?: PaneId;
  remainingBounds: Rectangle;
  targetBounds: Rectangle | null;
}
function paneBounds(layout: PrototypeState, ids: PaneId[], id: PaneId, width: number, height: number): Rectangle {
  const slot = layout.panes.indexOf(id);
  if (ids.length === 1) return { left: 0, top: 0, width, height };
  if (layout.direction === 'row') {
    const boundary = Math.round(width * layout.ratio);
    return slot === 0 ? { left: 0, top: 0, width: boundary, height }
      : { left: boundary, top: 0, width: width - boundary, height };
  }
  const boundary = Math.round(height * layout.ratio);
  return slot === 0 ? { left: 0, top: 0, width, height: boundary }
    : { left: 0, top: boundary, width, height: height - boundary };
}
interface MenuSnapshot {
  id: PaneId;
  bounds: Rectangle;
  position: { left: number; top: number };
  items: { key: string; label: string; selected?: boolean }[];
}

function SessionPane({
  id, shown, bounds, floating, docked, remaining, menuOpen, dragging, blocked, onFocusPane, onHandleDown, onHandleMove,
  onHandleUp, onHandleCancel, onHandleClick, registerHandle
}: {
  id: PaneId; shown: boolean; bounds: Rectangle; menuOpen: boolean; dragging: boolean; blocked: boolean;
  floating?: FloatingPane; docked?: boolean; remaining?: boolean;
  onFocusPane: (id: PaneId) => void;
  onHandleDown: (e: React.PointerEvent<HTMLButtonElement>, id: PaneId) => void;
  onHandleMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onHandleUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onHandleCancel: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onHandleClick: (e: React.MouseEvent<HTMLButtonElement>, id: PaneId) => void;
  registerHandle: (id: PaneId, element: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  const session = SESSIONS[id];
  const [topHovered, setTopHovered] = useState(false);
  const [handleFocused, setHandleFocused] = useState(false);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const showHandle = shown && (topHovered || handleFocused || menuOpen || dragging);
  const halo = usePresence(showHandle, MOTION.microMs);
  const send = (): void => {
    if (blocked || !draft.trim()) return;
    setSent(messages => [...messages, draft.trim()]); setDraft('');
  };
  return (
    <section
      className={`shp-session xfade xfade-instant${shown ? ' is-shown' : ''}${floating ? ' is-floating' : ''}`}
      data-testid={`pane-${id}`} data-pane-id={id} data-floating={floating ? true : undefined}
      data-docked={docked ? true : undefined}
      data-role={docked ? 'docked-pane' : floating ? 'floating-pane' : remaining ? 'remaining-pane' : undefined}
      data-floating-scale={floating?.scale}
      aria-label={session.name} aria-hidden={!shown || undefined}
      style={{ ...bounds, display: shown ? undefined : 'none',
        transform: floating ? `translate(${floating.left}px, ${floating.top}px) scale(${floating.scale})` : undefined }}
      onPointerMove={e => {
        if (e.pointerType === 'touch') return;
        const rect = e.currentTarget.getBoundingClientRect();
        setTopHovered(e.clientY >= rect.top && e.clientY <= rect.top + 32);
      }}
      onPointerLeave={() => setTopHovered(false)}
      onPointerDown={() => onFocusPane(id)}
      onFocusCapture={e => {
        setHandleFocused(e.target instanceof Element && e.target.closest('.shp-handle') != null);
        onFocusPane(id);
      }}
      onBlurCapture={e => {
        setHandleFocused(e.relatedTarget instanceof Element &&
          e.currentTarget.contains(e.relatedTarget) && e.relatedTarget.closest('.shp-handle') != null);
      }}
    >
      <div className="shp-conversation" ref={element => { if (element) element.inert = blocked; }}>
        <div className="shp-user-message">{session.user}</div>
        <article className="shp-assistant-message">
          <div className="shp-author">{session.runtime}<span>刚刚</span></div>
          {session.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
          <pre><code>{session.code}</code></pre>
          <p className="shp-result">{session.result}</p>
        </article>
        {sent.map((message, index) => <div className="shp-user-message" key={index}>{message}</div>)}
      </div>
      <div className="shp-composer" ref={element => { if (element) element.inert = blocked; }}>
        <textarea
          data-testid={`pane-composer-${id}`} aria-label={`给${session.name}发送消息`}
          placeholder="继续聊聊…" value={draft} rows={2} readOnly={blocked}
          onChange={e => { if (!blocked) setDraft(e.currentTarget.value); }}
          onKeyDown={e => {
            if (blocked) { e.preventDefault(); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
        />
        <div className="shp-composer-foot">
          <span>{session.runtime}<span className="shp-composer-separator">·</span>本地会话</span>
          <button type="button" className="shp-send cursor-interaction" aria-label="发送消息" disabled={blocked || !draft.trim()} onClick={send}>↑</button>
        </div>
      </div>
      {halo.mounted && <div className="shp-halo xfade" {...halo.spread} data-testid={`handle-halo-${id}`} aria-hidden />}
      <button
        type="button" className={`shp-handle cursor-interaction${showHandle ? ' is-visible' : ''}${dragging ? ' is-dragging' : ''}`}
        data-testid={`pane-handle-${id}`} aria-label={`${session.name}：分屏操作`}
        aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={`shp-menu-${id}`}
        ref={element => registerHandle(id, element)}
        onPointerDown={e => onHandleDown(e, id)} onPointerMove={onHandleMove}
        onPointerUp={onHandleUp} onPointerCancel={onHandleCancel} onLostPointerCapture={onHandleCancel}
        onClick={e => onHandleClick(e, id)}
      ><span /><span /><span /></button>
    </section>
  );
}

/** The two session bodies stay mounted in a fixed DOM order; only their rectangles change. */
export function SplitHandlePrototype({
  initialState, onStateChange
}: { initialState?: Partial<PrototypeState>; onStateChange?: (state: PrototypeState) => void } = {}): React.JSX.Element {
  const [state, setState] = useState<PrototypeState>(() => ({ ...initial, ...initialState }));
  const stateRef = useRef(state); stateRef.current = state;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 736, height: 580 });
  const [menuFor, setMenuFor] = useState<PaneId | null>(null);
  const menu = usePresenceValue(menuFor, MOTION.microMs);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuSnapshotRef = useRef<MenuSnapshot | null>(null);
  const handlesRef = useRef<Partial<Record<PaneId, HTMLButtonElement>>>({});
  const gestureRef = useRef<Gesture | null>(null);
  const [drag, setDrag] = useState<Gesture | null>(null);
  const suppressClick = useRef(false);
  const dividerRef = useRef<HTMLDivElement>(null);
  const dividerGesture = useRef<{ pointerId: number; originalRatio: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const narrow = state.panes.length > 1 && size.width < 560;
  const shownIds = narrow ? [state.focused] : state.panes;

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const measure = (): void => setSize({ width: surface.clientWidth, height: surface.clientHeight });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const update = (next: PrototypeState, description?: string): void => {
    stateRef.current = next; setState(next); onStateChange?.(next);
    if (description) setAnnouncement(description);
  };
  const focusPane = (id: PaneId): void => {
    if (gestureRef.current?.moved) return;
    const current = stateRef.current;
    if (current.focused !== id) update({ ...current, focused: id });
  };
  const closeMenu = (restoreFocus = true): void => {
    const id = menuFor; setMenuFor(null);
    if (restoreFocus && id) requestAnimationFrame(() => handlesRef.current[id]?.focus());
  };
  const boundsFor = (id: PaneId): Rectangle => paneBounds(state, shownIds, id, size.width, size.height);
  const dropAt = (x: number, y: number): DropTarget | null => {
    const surface = surfaceRef.current, current = gestureRef.current;
    if (!surface || !current || narrow || current.original.panes.length < 2) return null;
    return classifyDrop(x, y, surface.getBoundingClientRect());
  };
  const finishGesture = (): void => {
    const gesture = gestureRef.current;
    gestureRef.current = null; setDrag(null);
    if (gesture) {
      try { handlesRef.current[gesture.id]?.releasePointerCapture(gesture.pointerId); } catch { /* capture already released */ }
    }
  };
  const cancelGesture = (): void => {
    if (gestureRef.current) { suppressClick.current = true; finishGesture(); setAnnouncement('拖动已取消'); }
    const resize = dividerGesture.current;
    if (resize) {
      dividerGesture.current = null; setResizing(false);
      update({ ...stateRef.current, ratio: resize.originalRatio }, '调整已取消');
      try { dividerRef.current?.releasePointerCapture(resize.pointerId); } catch { /* already released */ }
    }
  };
  useEffect(() => {
    const onBlur = (): void => { cancelGesture(); setMenuFor(null); };
    const matchesActivePointer = (event: PointerEvent): boolean =>
      gestureRef.current?.pointerId === event.pointerId || dividerGesture.current?.pointerId === event.pointerId;
    // A sandbox iframe may miss release outside its viewport. Returning with no
    // primary button pressed must cancel before the captured handle can move again.
    const onPointerMove = (event: PointerEvent): void => {
      if (matchesActivePointer(event) && (event.buttons & 1) === 0) cancelGesture();
    };
    // Bubble only: normal handle/divider handlers get the first chance to commit.
    const onPointerUp = (event: PointerEvent): void => {
      if (matchesActivePointer(event)) cancelGesture();
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp);
    };
  });

  const onHandleDown = (event: React.PointerEvent<HTMLButtonElement>, id: PaneId): void => {
    if (event.button !== 0 || dividerGesture.current || gestureRef.current?.moved) return;
    const actual = event.currentTarget.closest<HTMLElement>('.shp-session')?.getBoundingClientRect();
    const bounds = boundsFor(id);
    const grab = actual && actual.width > 0 && actual.height > 0 ? {
      x: clamp((event.clientX - actual.left) / actual.width, 0, 1),
      y: clamp((event.clientY - actual.top) / actual.height, 0, 1)
    } : { x: 0.5, y: 16 / Math.max(1, bounds.height) };
    suppressClick.current = false; focusPane(id); event.currentTarget.focus();
    gestureRef.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, moved: false, target: null,
      original: { ...stateRef.current, panes: [...stateRef.current.panes] }, sourceBounds: bounds, grab };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHandleMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const moved = gesture.moved || Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= 6;
    if (!moved) return;
    event.preventDefault(); setMenuFor(null);
    const next = { ...gesture, moved, x: event.clientX, y: event.clientY, target: dropAt(event.clientX, event.clientY) };
    gestureRef.current = next; setDrag(next);
  };
  const onHandleUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.moved) {
      event.preventDefault(); suppressClick.current = true;
      // Commit the last visible candidate; an external or invalid release still cancels.
      const target = dropAt(event.clientX, event.clientY) ? gesture.target : null;
      if (target) update(deriveDropLayout(gesture.original, gesture.id, target), '已重新排列分屏');
      else setAnnouncement('拖动已取消');
    }
    finishGesture();
  };
  const onHandleClick = (event: React.MouseEvent<HTMLButtonElement>, id: PaneId): void => {
    if (suppressClick.current && event.detail > 0) { suppressClick.current = false; event.preventDefault(); return; }
    if (gestureRef.current?.moved) { event.preventDefault(); return; }
    focusPane(id); setMenuFor(current => current === id ? null : id);
  };
  const menuItems = (id: PaneId): { key: string; label: string; selected?: boolean }[] => {
    if (state.panes.length === 1) {
      const other = id === 'a' ? 'b' : 'a';
      return [
        { key: 'reopen-row', label: `与「${SESSIONS[other].name}」左右分屏` },
        { key: 'reopen-col', label: `与「${SESSIONS[other].name}」上下分屏` }
      ];
    }
    return [
      { key: 'keep', label: '只看此侧' }, { key: 'close', label: '收起此侧' },
      { key: 'swap', label: '交换两侧' },
      { key: 'row', label: '左右分屏', selected: state.direction === 'row' },
      { key: 'col', label: '上下分屏', selected: state.direction === 'col' },
      { key: 'reset', label: '恢复等宽' }
    ];
  };
  const selectAction = (key: string, id: PaneId): void => {
    const current = stateRef.current;
    let next = current;
    if (key === 'keep') next = { ...current, panes: [id], focused: id };
    else if (key === 'close') {
      const other = current.panes.find(pane => pane !== id) ?? id;
      next = { ...current, panes: [other], focused: other };
    } else if (key === 'swap') next = { ...current, panes: [...current.panes].reverse() };
    else if (key === 'row' || key === 'col') next = { ...current, direction: key };
    else if (key === 'reset') next = { ...current, ratio: 0.5 };
    else if (key.startsWith('reopen-')) next = { ...current, panes: [id, id === 'a' ? 'b' : 'a'],
      direction: key === 'reopen-row' ? 'row' : 'col', ratio: 0.5, focused: id };
    setMenuFor(null); update(next, key === 'close' ? '此侧已收起，会话仍保留' : '布局已更新');
    requestAnimationFrame(() => handlesRef.current[next.focused]?.focus());
  };
  useEffect(() => {
    if (menuFor && menu.presence.mounted) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [menuFor, menu.presence.mounted]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'Tab') closeMenu(false);
  };
  const ratioAt = (event: React.PointerEvent): void => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = stateRef.current;
    const raw = current.direction === 'row' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
    update({ ...current, ratio: clamp(raw, 0.25, 0.75) });
  };
  const dividerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dividerGesture.current || dividerGesture.current.pointerId !== event.pointerId) return;
    dividerGesture.current = null; setResizing(false);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    setAnnouncement(`分屏比例 ${Math.round(stateRef.current.ratio * 100)}%`);
  };
  // Refresh while open; preserve content and final coordinates throughout exit.
  if (menuFor) {
    const bounds = boundsFor(menuFor);
    menuSnapshotRef.current = {
      id: menuFor, bounds, items: menuItems(menuFor),
      position: {
        left: clamp(bounds.left + bounds.width / 2 - 118, 8, size.width - 244),
        top: clamp(bounds.top + 38, 8, size.height - (state.panes.length === 1 ? 116 : 260))
      }
    };
  }
  const menuId = menu.value;
  const menuSnapshot = menuSnapshotRef.current?.id === menuId ? menuSnapshotRef.current : null;
  const surfaceRect = surfaceRef.current?.getBoundingClientRect();
  const candidate = drag ? deriveDropLayout(drag.original, drag.id, drag.target) : null;
  const remainingId = drag?.original.panes.find(id => id !== drag.id);
  const floatingScale = 0.78;
  const dragPreview = usePresenceValue<DragSnapshot>(drag && candidate ? {
    sourceId: drag.id, layout: candidate, width: size.width, height: size.height,
    target: drag.target, sourceBounds: { ...drag.sourceBounds, left: 0, top: 0 },
    floating: {
      left: clamp(drag.x - (surfaceRect?.left ?? 0) - drag.grab.x * drag.sourceBounds.width * floatingScale,
        0, Math.max(0, size.width - drag.sourceBounds.width * floatingScale)),
      top: clamp(drag.y - (surfaceRect?.top ?? 0) - drag.grab.y * drag.sourceBounds.height * floatingScale,
        0, Math.max(0, size.height - drag.sourceBounds.height * floatingScale)),
      scale: floatingScale
    }, remainingId,
    remainingBounds: drag.target && remainingId
      ? paneBounds(candidate, candidate.panes, remainingId, size.width, size.height)
      : { left: 0, top: 0, width: size.width, height: size.height },
    targetBounds: drag.target ? paneBounds(candidate, candidate.panes, drag.id, size.width, size.height) : null
  } : null, MOTION.exitMs);
  const preview = dragPreview.value;
  // The actual session geometry belongs to committed state as soon as the gesture ends.
  // Presence retains only the decorative scrim for its interruptible exit.
  const activePreview = drag ? preview : null;

  return (
    <div id="split-handle-prototype" className="viz-dotted-background" aria-label="分屏顶部把手">
      <div
        ref={surfaceRef} className={`shp-surface${drag ? ' is-dragging' : ''}${resizing ? ' is-resizing' : ''}`}
        data-testid="prototype-surface" data-layout={state.panes.length === 1 ? 'single' : state.direction}
        data-order={state.panes.join(',')} data-ratio={state.ratio} data-narrow={narrow} data-drag-model="lift-dock"
        data-preview-side={activePreview?.target?.side}
        data-preview-order={activePreview?.target ? activePreview.layout.panes.join(',') : undefined}
        data-preview-layout={activePreview?.target ? activePreview.layout.direction : undefined}
        onPointerDownCapture={e => {
          if (gestureRef.current?.moved) { e.preventDefault(); e.stopPropagation(); return; }
          if (menuFor && e.target instanceof Element && !e.target.closest('.shp-menu, .shp-handle')) closeMenu(false);
        }}
        onKeyDown={e => {
          if (gestureRef.current?.moved) {
            e.preventDefault();
            if (e.key === 'Escape') cancelGesture();
            return;
          }
          if (e.key === 'Escape') { e.preventDefault(); cancelGesture(); if (menuFor) closeMenu(); }
        }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); cancelGesture(); }}
      >
        {SESSION_IDS.map(id => <SessionPane key={id} id={id}
          shown={activePreview ? id === activePreview.sourceId || id === activePreview.remainingId : shownIds.includes(id)}
          bounds={activePreview?.sourceId === id ? activePreview.targetBounds ?? activePreview.sourceBounds
            : activePreview?.remainingId === id ? activePreview.remainingBounds : boundsFor(id)}
          floating={activePreview?.sourceId === id && !activePreview.target ? activePreview.floating : undefined}
          docked={activePreview?.sourceId === id && activePreview.target != null}
          remaining={activePreview?.remainingId === id}
          menuOpen={menuFor === id} dragging={activePreview?.sourceId === id} blocked={dragPreview.presence.mounted} onFocusPane={focusPane}
          onHandleDown={onHandleDown} onHandleMove={onHandleMove} onHandleUp={onHandleUp}
          onHandleCancel={cancelGesture} onHandleClick={onHandleClick}
          registerHandle={(pane, element) => { if (element) handlesRef.current[pane] = element; else delete handlesRef.current[pane]; }} />)}
        {state.panes.length > 1 && !narrow && !dragPreview.presence.mounted && <div
          className="shp-divider" data-testid="split-divider" ref={dividerRef}
          role="separator" tabIndex={dragPreview.presence.mounted ? -1 : 0} aria-label="调整分屏比例"
          aria-orientation={state.direction === 'row' ? 'vertical' : 'horizontal'}
          aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(state.ratio * 100)}
          style={state.direction === 'row' ? { left: size.width * state.ratio - 4, top: 0, width: 8, height: size.height }
            : { left: 0, top: size.height * state.ratio - 4, width: size.width, height: 8 }}
          onPointerDown={e => {
            if (e.button !== 0 || gestureRef.current) return;
            e.preventDefault(); e.currentTarget.focus(); setMenuFor(null); setResizing(true);
            dividerGesture.current = { pointerId: e.pointerId, originalRatio: stateRef.current.ratio };
            e.currentTarget.setPointerCapture(e.pointerId); ratioAt(e);
          }}
          onPointerMove={e => { if (dividerGesture.current?.pointerId === e.pointerId) ratioAt(e); }}
          onPointerUp={dividerUp} onPointerCancel={cancelGesture}
          onDoubleClick={() => update({ ...stateRef.current, ratio: 0.5 }, '已恢复等宽')}
          onKeyDown={e => {
            const current = stateRef.current;
            const decrease = current.direction === 'row' ? 'ArrowLeft' : 'ArrowUp';
            const increase = current.direction === 'row' ? 'ArrowRight' : 'ArrowDown';
            let ratio: number | null = null;
            if (e.key === decrease) ratio = current.ratio - 0.02;
            else if (e.key === increase) ratio = current.ratio + 0.02;
            else if (e.key === 'Home') ratio = 0.25;
            else if (e.key === 'End') ratio = 0.75;
            if (ratio != null) { e.preventDefault(); update({ ...current, ratio: clamp(ratio, 0.25, 0.75) }); }
          }}
        ><span /></div>}
        {narrow && !dragPreview.presence.mounted && <div className="shp-pane-switch" aria-label="切换分屏会话">
          {state.panes.map(id => <button type="button" className="cursor-interaction" key={id} disabled={dragPreview.presence.mounted}
            aria-pressed={state.focused === id} data-tooltip={SESSIONS[id].name}
            onClick={() => focusPane(id)}>{SESSIONS[id].name}</button>)}
        </div>}
        {menu.presence.mounted && menuId && menuSnapshot && <div
          className="shp-menu mp-pop" {...menu.presence.spread} ref={menuRef}
          data-testid={`pane-menu-${menuId}`} id={`shp-menu-${menuId}`} role="menu"
          aria-label={`${SESSIONS[menuId].name}的分屏操作`} aria-hidden={menuFor == null || undefined}
          style={menuSnapshot.position}
          onKeyDown={onMenuKeyDown}
        >
          <div className="shp-menu-name">{SESSIONS[menuId].name}</div>
          {menuSnapshot.items.map(item => <button type="button" className="cursor-interaction" key={item.key}
            role="menuitem" disabled={menuFor == null} data-action={item.key}
            onClick={() => selectAction(item.key, menuId)}>
            <span>{item.label}</span><span aria-hidden>{item.selected ? '✓' : ''}</span>
          </button>)}
        </div>}
        {dragPreview.presence.mounted && preview &&
          <div className="shp-drag-scrim" {...dragPreview.presence.spread}
            data-testid="drag-scrim" aria-hidden>
            {preview.target && preview.targetBounds ? <>
              {preview.layout.panes.map(id => <div key={id} className="shp-pane-scrim mp-scrim" {...dragPreview.presence.spread}
                data-testid={`preview-blur-${id}`} data-scrim-pane={id}
                style={(id === preview.sourceId ? preview.targetBounds : preview.remainingBounds) ?? undefined} />)}
              <div className="shp-divider shp-preview-divider mp-scrim" {...dragPreview.presence.spread} data-testid="preview-divider"
                data-direction={preview.layout.direction} data-ratio={preview.layout.ratio}
                aria-orientation={preview.layout.direction === 'row' ? 'vertical' : 'horizontal'}
                style={preview.layout.direction === 'row'
                  ? { left: preview.width * preview.layout.ratio - 4, top: 0, width: 8, height: preview.height }
                  : { left: 0, top: preview.height * preview.layout.ratio - 4, width: preview.width, height: 8 }}
              ><span /></div>
            </> : <div className="shp-pane-scrim mp-scrim" {...dragPreview.presence.spread} data-testid="preview-blur-full"
              style={{ left: 0, top: 0, width: preview.width, height: preview.height }} />}
          </div>
        }
        <div className="shp-sr-only" role="status" aria-live="polite">{announcement}</div>
      </div>
    </div>
  );
}
