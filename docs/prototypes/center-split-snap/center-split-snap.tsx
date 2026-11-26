import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePresence, usePresenceValue } from '../../../src/renderer/src/components/motion';

export type SnapSessionId = 'a' | 'b' | 'c' | 'd';
export type SnapLayoutId = 'full' | 'halves' | 'wide' | 'stack' | 'focus' | 'thirds' | 'quad';
export interface SnapCell { x: number; y: number; width: number; height: number }
export interface SnapTarget { layoutId: SnapLayoutId; index: number }
export interface SnapPrototypeState { layoutId: SnapLayoutId; slots: (SnapSessionId | null)[]; focused: SnapSessionId; assistSlot: number | null }
export const SNAP_LAYOUTS: { id: SnapLayoutId; label: string; cells: SnapCell[] }[] = [
  { id: 'full', label: '铺满工作面', cells: [{ x: 0, y: 0, width: 1, height: 1 }] },
  { id: 'halves', label: '左右两格', cells: [{ x: 0, y: 0, width: .5, height: 1 }, { x: .5, y: 0, width: .5, height: 1 }] },
  { id: 'wide', label: '左宽右窄', cells: [{ x: 0, y: 0, width: 2 / 3, height: 1 }, { x: 2 / 3, y: 0, width: 1 / 3, height: 1 }] },
  { id: 'stack', label: '上下两格', cells: [{ x: 0, y: 0, width: 1, height: .5 }, { x: 0, y: .5, width: 1, height: .5 }] },
  { id: 'focus', label: '主辅三格', cells: [{ x: 0, y: 0, width: .5, height: 1 }, { x: .5, y: 0, width: .5, height: .5 }, { x: .5, y: .5, width: .5, height: .5 }] },
  { id: 'thirds', label: '并排三格', cells: [{ x: 0, y: 0, width: 1 / 3, height: 1 }, { x: 1 / 3, y: 0, width: 1 / 3, height: 1 }, { x: 2 / 3, y: 0, width: 1 / 3, height: 1 }] },
  { id: 'quad', label: '四宫格', cells: [{ x: 0, y: 0, width: .5, height: .5 }, { x: .5, y: 0, width: .5, height: .5 }, { x: 0, y: .5, width: .5, height: .5 }, { x: .5, y: .5, width: .5, height: .5 }] }
];
export const SNAP_SESSIONS = {
  a: { name: '官网首页', engine: 'Codex', user: '把首页第一屏改得更简洁，突出工作台本身。', paragraphs: ['主标题和一个开始使用的入口就足够了。产品截图占据主要空间，下面用一行说明三个核心能力。', '我先给你一个可以直接对照的版本，确认方向后再调整后面的内容。'], result: '首页草稿已准备好。' },
  b: { name: '发布检查', engine: 'Claude', user: '帮我核对今天这版的发布清单。', paragraphs: ['文案、图标和主要入口已经核对。还需要确认安装后的窗口尺寸、菜单位置，以及旧数据能否恢复。', '检查记录会保留在这次会话里，你可以随时继续。'], result: '接下来检查安装与恢复流程。' },
  c: { name: '本周计划', engine: 'Codex', user: '把这周的几件事排一下，先做最重要的。', paragraphs: ['周一完成首页，周二检查发布流程，周三再处理搜索页面。每项都留出一段复查时间。'], result: '先完成首页与发布检查。' },
  d: { name: '搜索交互', engine: 'Pi', user: '搜索结果先展示标题和一行摘要，其他信息少一点。', paragraphs: ['结果列表会收紧间距，匹配词保持清楚。点击结果后再展开详细内容，列表里保留足够的上下文。'], result: '可以先从结果列表开始。' }
} satisfies Record<SnapSessionId, { name: string; engine: string; user: string; paragraphs: string[]; result: string }>;
const SESSION_IDS: SnapSessionId[] = ['a', 'b', 'c', 'd'];
const DEFAULT_STATE: SnapPrototypeState = { layoutId: 'halves', slots: ['a', 'b'], focused: 'a', assistSlot: null };
const layout = (id: SnapLayoutId) => SNAP_LAYOUTS.find(item => item.id === id)!;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const cellStyle = (cell: SnapCell): React.CSSProperties => ({ left: `${cell.x * 100}%`, top: `${cell.y * 100}%`, width: `${cell.width * 100}%`, height: `${cell.height * 100}%` });
export function createSnappedState(current: SnapPrototypeState, id: SnapSessionId, target: SnapTarget): SnapPrototypeState {
  const cells = layout(target.layoutId)?.cells;
  if (!cells || target.index < 0 || target.index >= cells.length) return current;
  const slots: (SnapSessionId | null)[] = cells.map((_, index) => index === target.index ? id : null);
  return { layoutId: target.layoutId, slots, focused: id, assistSlot: slots.findIndex(value => value == null) < 0 ? null : slots.findIndex(value => value == null) };
}

interface Gesture {
  id: SnapSessionId; pointerId: number; element: HTMLButtonElement; startX: number; startY: number;
  x: number; y: number; active: boolean; bar: boolean; target: SnapTarget | null;
  original: SnapPrototypeState; source: { left: number; top: number; width: number; height: number };
}
interface MenuSnapshot { id: SnapSessionId; left: number; top: number }

function SessionPane({ id, shown, style, floating, dragging, onDown, onMove, onUp, onCancel, onMenu, onFocus }: {
  id: SnapSessionId; shown: boolean; style: React.CSSProperties; floating: boolean; dragging: boolean;
  onDown: (id: SnapSessionId, event: React.PointerEvent<HTMLButtonElement>) => void;
  onMove: (event: React.PointerEvent<HTMLButtonElement>) => void; onUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onCancel: () => void; onMenu: (id: SnapSessionId, event: React.MouseEvent<HTMLButtonElement>) => void; onFocus: (id: SnapSessionId) => void;
}) {
  const session = SNAP_SESSIONS[id];
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  return <section className={`sp-pane${floating ? ' is-floating' : ''}`} data-testid={`snap-pane-${id}`} data-session={id}
    data-floating={floating || undefined} aria-hidden={!shown || undefined} style={{ ...style, display: shown ? 'flex' : 'none' }}
    ref={element => { if (element) { if (shown) element.removeAttribute('inert'); else element.setAttribute('inert', ''); } }}
    onPointerDown={event => { if (!(event.target as HTMLElement).closest('.sp-toolbar')) onFocus(id); }} onFocus={event => { if (!(event.target as HTMLElement).closest('.sp-toolbar')) onFocus(id); }}>
    <div className={`sp-toolbar${dragging ? ' is-moving' : ''}`}>
      <button className="sp-handle cursor-interaction" type="button" aria-label={`${session.name}：面板操作`} aria-haspopup="menu"
        data-testid={`snap-handle-${id}`} onPointerDown={event => onDown(id, event)} onPointerMove={onMove} onPointerUp={onUp}
        onPointerCancel={onCancel} onLostPointerCapture={onCancel} onClick={event => onMenu(id, event)}><span aria-hidden="true">···</span></button>
    </div>
    <div className="sp-conversation" data-testid={`snap-conversation-${id}`}>
      <div className="sp-user-message">{session.user}</div>
      <div className="sp-author"><span className="sp-agent-mark" aria-hidden="true">M</span><span>{session.engine}</span></div>
      {session.paragraphs.map(text => <p key={text}>{text}</p>)}
      <p className="sp-result">{session.result}</p>
      {sent.map((message, index) => <div className="sp-user-message" key={index}>{message}</div>)}
    </div>
    <form className="sp-composer" onSubmit={event => { event.preventDefault(); if (!dragging && draft.trim()) { setSent(items => [...items, draft.trim()]); setDraft(''); } }}>
      <textarea aria-label={`${session.name}的草稿`} data-testid={`snap-composer-${id}`} placeholder="继续这次会话…" value={draft} onChange={event => setDraft(event.target.value)} />
      <div className="sp-composer-foot"><span>＋ <span className="sp-mode">自动</span></span><span className="sp-engine">{session.engine}</span><button className="sp-send cursor-interaction" type="submit" aria-label="发送" disabled={dragging || !draft.trim()}>↑</button></div>
    </form>
  </section>;
}

export function SnapSplitPrototype({ initialState = DEFAULT_STATE, onStateChange }: { initialState?: SnapPrototypeState; onStateChange?: (state: SnapPrototypeState) => void }): React.JSX.Element {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state); stateRef.current = state;
  const [size, setSize] = useState({ width: 800, height: 580 });
  const workRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Gesture | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const [captureActive, setCaptureActive] = useState(false);
  const suppressedClick = useRef(false);
  const [menu, setMenu] = useState<MenuSnapshot | null>(null);
  const keyboardMenu = useRef(false);
  const focusPicker = useRef(false);
  const [narrowAssistOpen, setNarrowAssistOpen] = useState(false);
  const [pickerId, setPickerId] = useState<SnapSessionId | null>(null);
  const [hoverTarget, setHoverTarget] = useState<SnapTarget | null>(null);
  const { presence: menuPresence, value: menuSnapshot } = usePresenceValue(menu);
  const barOpen = !!pickerId || !!drag?.bar;
  const barPresence = usePresence(barOpen);
  const target = drag?.active ? drag.target : hoverTarget;
  const { presence: frostPresence, value: frostTarget } = usePresenceValue(target);
  const narrow = size.width < 480;
  const { presence: assistPresence, value: assistSnapshot } = usePresenceValue(narrow && narrowAssistOpen && state.assistSlot != null
    ? { index: state.assistSlot, available: SESSION_IDS.filter(id => !state.slots.includes(id)) } : null);
  const overlaySource = useRef<SnapSessionId | null>(null); overlaySource.current = menu?.id ?? pickerId;
  const focusHandle = (id: SnapSessionId) => workRef.current?.querySelector<HTMLButtonElement>(`[data-testid="snap-handle-${id}"]`)?.focus({ preventScroll: true });
  useLayoutEffect(() => {
    if (menu && keyboardMenu.current && menuPresence.mounted) {
      workRef.current?.querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')?.focus({ preventScroll: true }); keyboardMenu.current = false;
    }
  }, [menu, menuPresence.mounted]);
  useLayoutEffect(() => {
    if (pickerId && focusPicker.current && barPresence.mounted) {
      workRef.current?.querySelector<HTMLButtonElement>('[data-snap-layout]')?.focus({ preventScroll: true }); focusPicker.current = false;
    }
  }, [pickerId, barPresence.mounted]);

  useLayoutEffect(() => {
    const measure = () => { const element = workRef.current; if (element) setSize({ width: element.clientWidth || 800, height: element.clientHeight || 580 }); };
    measure(); const observer = new ResizeObserver(measure); if (workRef.current) observer.observe(workRef.current);
    window.addEventListener('resize', measure); return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const apply = (next: SnapPrototypeState) => { stateRef.current = next; setState(next); onStateChange?.(next); };
  const release = (current: Gesture) => { try { current.element.releasePointerCapture(current.pointerId); } catch { /* already released */ } };
  const cancel = () => { const current = gesture.current; gesture.current = null; if (current) suppressedClick.current = true;
    setDrag(null); setCaptureActive(false); setPickerId(null); setHoverTarget(null); if (current) release(current); };
  const cancelRef = useRef(cancel); cancelRef.current = cancel;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { const source = gesture.current?.id ?? overlaySource.current;
      cancelRef.current(); setMenu(null); setNarrowAssistOpen(false); if (source) focusHandle(source); } };
    const up = (event: PointerEvent) => { const current = gesture.current; if (current && event.pointerId === current.pointerId && event.buttons === 0 && !current.element.contains(event.target as Node)) cancelRef.current(); };
    const blur = () => { cancelRef.current(); setMenu(null); setNarrowAssistOpen(false); };
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', blur);
    window.addEventListener('pointerup', up); window.addEventListener('pointermove', up);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointermove', up); const current = gesture.current; gesture.current = null; if (current) release(current); };
  }, []);
  useEffect(() => { if (narrow && gesture.current) cancel(); }, [narrow]);

  const hitTarget = (clientX: number, clientY: number, allowBar: boolean): SnapTarget | null => {
    const area = workRef.current?.getBoundingClientRect(); if (!area) return null;
    const x = clientX - area.left, y = clientY - area.top;
    if (x < 0 || y < 0 || x > area.width || y > area.height) return null;
    if (allowBar) {
      for (const element of workRef.current!.querySelectorAll<HTMLElement>('[data-snap-layout][data-snap-index]')) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom)
          return { layoutId: element.dataset.snapLayout as SnapLayoutId, index: Number(element.dataset.snapIndex) };
      }
    }
    // Familiar side/corner snapping remains available without opening the bar.
    if (x <= 18 || x >= area.width - 18) {
      const right = x > area.width / 2;
      if (y <= 18 || y >= area.height - 18) return { layoutId: 'quad', index: (y > area.height / 2 ? 2 : 0) + (right ? 1 : 0) };
      return { layoutId: 'halves', index: right ? 1 : 0 };
    }
    return null;
  };
  const sample = (current: Gesture, clientX: number, clientY: number): Gesture => {
    const area = workRef.current!.getBoundingClientRect();
    const x = clientX - area.left, y = clientY - area.top;
    const barBounds = workRef.current!.querySelector('[data-testid="snap-layout-bar"]')?.getBoundingClientRect();
    const inSurface = x >= 0 && y >= 0 && x <= area.width && y <= area.height;
    const bar = inSurface && (y <= 28 || (current.bar && !!barBounds && clientX >= barBounds.left - 18 && clientX <= barBounds.right + 18 && clientY <= barBounds.bottom + 18));
    return { ...current, x, y, bar, target: hitTarget(clientX, clientY, bar && current.bar) };
  };
  const down = (id: SnapSessionId, event: React.PointerEvent<HTMLButtonElement>) => {
    suppressedClick.current = false;
    if (event.button !== 0 || narrow || gesture.current) return;
    const area = workRef.current!.getBoundingClientRect();
    const pane = workRef.current!.querySelector(`[data-testid="snap-pane-${id}"]`)!.getBoundingClientRect();
    const current: Gesture = { id, pointerId: event.pointerId, element: event.currentTarget, startX: event.clientX, startY: event.clientY,
      x: event.clientX - area.left, y: event.clientY - area.top, active: false, bar: false, target: null, original: stateRef.current,
      source: { left: pane.left - area.left, top: pane.top - area.top, width: pane.width, height: pane.height } };
    gesture.current = current; setCaptureActive(true); setMenu(null); setPickerId(null); setHoverTarget(null);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* window fallback owns cancellation */ }
  };
  const move = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current; if (!current || current.pointerId !== event.pointerId) return;
    if (event.buttons === 0) { cancel(); return; }
    if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return;
    event.preventDefault(); suppressedClick.current = true;
    const next = sample({ ...current, active: true }, event.clientX, event.clientY);
    gesture.current = next; setDrag(next);
  };
  const up = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current; if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (current.active) { event.preventDefault(); suppressedClick.current = true; const final = sample(current, event.clientX, event.clientY);
      if (final.target) apply(createSnappedState(stateRef.current, current.id, final.target)); }
    setDrag(null); setCaptureActive(false); setHoverTarget(null); release(current);
  };
  const openMenu = (id: SnapSessionId, event: React.MouseEvent<HTMLButtonElement>) => {
    const suppressed = suppressedClick.current && event.detail !== 0; suppressedClick.current = false;
    if (suppressed) return; setHoverTarget(null); setPickerId(null);
    keyboardMenu.current = event.detail === 0;
    const area = workRef.current!.getBoundingClientRect();
    const handle = event.currentTarget.getBoundingClientRect();
    setMenu(previous => previous?.id === id ? null : { id,
      left: clamp(handle.left + handle.width / 2 - area.left - 98, 8, Math.max(8, area.width - 204)),
      top: handle.bottom - area.top + 4 });
  };
  const choose = (id: SnapSessionId, slot: number) => {
    if (stateRef.current.slots.includes(id) || slot < 0 || slot >= stateRef.current.slots.length || stateRef.current.slots[slot] != null) return;
    const slots = [...stateRef.current.slots]; slots[slot] = id;
    const next = slots.findIndex(value => value == null);
    apply({ ...stateRef.current, slots, focused: id, assistSlot: next < 0 ? null : next });
  };
  const activate = (id: SnapSessionId) => { cancel(); setMenu(null); setNarrowAssistOpen(false); if (state.slots.includes(id)) apply({ ...state, focused: id });
    else if (state.assistSlot != null) choose(id, state.assistSlot);
    else { const slots = [...state.slots]; const index = slots.indexOf(state.focused); slots[index < 0 ? 0 : index] = id; apply({ ...state, slots, focused: id }); } };
  const sourceId = drag?.id ?? pickerId;
  const remaining = state.slots.filter((id): id is SnapSessionId => id != null && id !== drag?.id);
  const fullCell = layout('full').cells[0];
  const paneStyle = (id: SnapSessionId): { style: React.CSSProperties; shown: boolean; floating: boolean } => {
    const index = state.slots.indexOf(id);
    const floating = drag?.active && drag.id === id;
    if (floating) {
      const scale = drag.bar ? .32 : .76;
      const left = clamp(drag.x + 16, 0, Math.max(0, size.width - drag.source.width * scale));
      const top = clamp(drag.y + 24, 0, Math.max(0, size.height - drag.source.height * scale));
      return { shown: true, floating: true, style: { left: 0, top: 0, width: drag.source.width, height: drag.source.height,
        transformOrigin: '0 0', transform: `translate(${left}px, ${top}px) scale(${scale})` } };
    }
    const shown = index >= 0 && (!narrow || state.focused === id);
    const cell = narrow || drag?.active && remaining.length === 1 && remaining.includes(id) ? fullCell : layout(state.layoutId).cells[Math.max(0, index)];
    return { shown, floating: false, style: cellStyle(cell) };
  };
  const previewTarget = frostTarget;
  const previewCell = previewTarget ? layout(previewTarget.layoutId).cells[previewTarget.index] : null;
  const available = SESSION_IDS.filter(id => !state.slots.includes(id));
  const menuSession = menuSnapshot?.id;
  const assistChoices = (index: number, choices = available) => <><div className="sp-assist-title">选择会话填入此处</div><div className="sp-assist-list">{choices.map(candidate => <button type="button" className="sp-assist-choice cursor-interaction" key={candidate} onClick={() => choose(candidate, index)} data-testid={`snap-fill-${index}-${candidate}`}>
    <span className="sp-assist-icon" aria-hidden="true">M</span><span>{SNAP_SESSIONS[candidate].name}<small>{SNAP_SESSIONS[candidate].engine}</small></span></button>)}</div></>;

  return <div id="snap-split-prototype" className="sp-app" data-testid="snap-prototype" data-layout={state.layoutId} data-slots={state.slots.join(',')}>
    <header className="sp-app-chrome"><span className="sp-app-mark" aria-hidden="true">M</span><span>MetaAgent</span><span className="sp-chrome-divider"/><span className="sp-workspace-name">产品工作台</span></header>
    <div className="sp-app-body">
      <aside className="sp-sidebar"><div className="sp-sidebar-caption">工作会话</div>{SESSION_IDS.map(id => <button type="button" className={`sp-session-row cursor-interaction${state.focused === id ? ' is-selected' : ''}`} key={id}
        onClick={() => activate(id)} data-testid={`snap-library-${id}`}><span className="sp-session-dot" aria-hidden="true"/><span>{SNAP_SESSIONS[id].name}</span><small>{SNAP_SESSIONS[id].engine}</small></button>)}
        <div className="sp-sidebar-bottom"><span className="sp-workspace-dot"/>产品工作台<span>⌄</span></div>
      </aside>
      <div className="sp-work-area" data-testid="snap-surface" ref={workRef} data-narrow={narrow} data-dragging={drag?.active || undefined} data-bar-open={barOpen || undefined} data-preview={target ? `${target.layoutId}:${target.index}` : undefined}
        onPointerDownCapture={event => { if (!(event.target as HTMLElement).closest('.sp-toolbar, .sp-menu-position, .sp-snapbar-position')) { setMenu(null); if (!gesture.current) { setPickerId(null); setHoverTarget(null); } } }}>
        {SESSION_IDS.map(id => { const view = paneStyle(id); return <SessionPane key={id} id={id} shown={view.shown} style={view.style} floating={view.floating} dragging={!!drag?.active}
          onDown={down} onMove={move} onUp={up} onCancel={cancel} onMenu={openMenu} onFocus={id => { if (!gesture.current && state.focused !== id) apply({ ...state, focused: id }); }} />; })}
        {!drag?.active && !narrow && state.slots.map((id, index) => id == null ? <section className="sp-empty-slot" key={index} style={cellStyle(layout(state.layoutId).cells[index])} data-testid={`snap-empty-${index}`}>{assistChoices(index)}</section> : null)}
        {assistPresence.mounted && assistSnapshot && <section className="sp-narrow-assist mp-pop" {...assistPresence.spread} data-testid={`snap-empty-${assistSnapshot.index}`}>{assistChoices(assistSnapshot.index, assistSnapshot.available)}</section>}
        {narrow && <div className="sp-narrow-switch">{state.slots.filter((id): id is SnapSessionId => id != null).map(id => <button type="button" className="cursor-interaction" aria-pressed={state.focused === id} key={id} onClick={() => activate(id)}>{SNAP_SESSIONS[id].name}</button>)}{state.assistSlot != null && <button type="button" className="cursor-interaction" aria-expanded={narrowAssistOpen} data-testid="snap-assist-toggle" onClick={() => setNarrowAssistOpen(previous => !previous)}>填入空位</button>}</div>}
        {captureActive && <div className="sp-capture-shield" data-testid="snap-capture-shield" aria-hidden="true"/>}
        {drag?.active && !barOpen && <div className="sp-top-hint" aria-hidden="true"/>}
        {frostPresence.mounted && previewCell && <div className="sp-frost mp-scrim" {...frostPresence.spread} style={cellStyle(previewCell)} data-testid="snap-target-preview" aria-hidden="true"/>}
        {barPresence.mounted && <div className="sp-snapbar-position"><div className="sp-snapbar mp-panel" {...barPresence.spread} data-testid="snap-layout-bar" aria-label="分屏布局" role="group"
          onPointerLeave={() => { if (pickerId && !gesture.current) setHoverTarget(null); }}
          onBlurCapture={event => { if (pickerId && !event.currentTarget.contains(event.relatedTarget as Node)) setHoverTarget(null); }}>
          {SNAP_LAYOUTS.filter(item => item.id !== 'full').map(item => <div className="sp-layout" key={item.id} aria-label={item.label}>
            {item.cells.map((cell, index) => <button type="button" className={`sp-layout-cell cursor-interaction${target?.layoutId === item.id && target.index === index ? ' is-selected' : ''}`}
              key={index} style={{ left: `calc(${cell.x * 100}% + 2px)`, top: `calc(${cell.y * 100}% + 2px)`, width: `calc(${cell.width * 100}% - 4px)`, height: `calc(${cell.height * 100}% - 4px)` }}
              aria-label={`${item.label} · ${index + 1}`} data-snap-layout={item.id} data-snap-index={index} data-testid={`snap-cell-${item.id}-${index}`}
              onPointerEnter={() => { if (pickerId && !gesture.current) setHoverTarget({ layoutId: item.id, index }); }}
              onFocus={() => { if (pickerId) setHoverTarget({ layoutId: item.id, index }); }}
              onClick={() => { if (pickerId && sourceId) { apply(createSnappedState(stateRef.current, sourceId, { layoutId: item.id, index })); setPickerId(null); setHoverTarget(null); } }} />)}
          </div>)}
        </div></div>}
        {menuPresence.mounted && menuSession && <div className="sp-menu-position" style={{ left: menuSnapshot!.left, top: menuSnapshot!.top }}>
          <div className="sp-menu mp-pop" {...menuPresence.spread} role="menu" aria-label={`${SNAP_SESSIONS[menuSession].name}的面板菜单`}
            onKeyDown={event => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
              items[index]?.focus({ preventScroll: true });
            }}>
            <div className="sp-menu-caption">{SNAP_SESSIONS[menuSession].name}</div>
            <button type="button" className="cursor-interaction" role="menuitem" onClick={() => { focusPicker.current = true; setPickerId(menuSession); setMenu(null); }}>选择分屏布局<span>▦</span></button>
            <button type="button" className="cursor-interaction" role="menuitem" onClick={() => { apply(createSnappedState(state, menuSession, { layoutId: 'full', index: 0 })); setMenu(null); }}>铺满工作面</button>
            <div className="sp-menu-divider"/>
            <button type="button" className="cursor-interaction" role="menuitem" disabled={state.slots.filter(Boolean).length < 2} onClick={() => { const rest = state.slots.filter((id): id is SnapSessionId => id != null && id !== menuSession);
              if (rest.length === 1) apply(createSnappedState(state, rest[0], { layoutId: 'full', index: 0 })); else { const slots = state.slots.map(id => id === menuSession ? null : id); apply({ ...state, slots, focused: rest[0], assistSlot: slots.findIndex(id => id == null) }); } setMenu(null); }}>收起此面板</button>
          </div>
        </div>}
      </div>
    </div>
  </div>;
}
