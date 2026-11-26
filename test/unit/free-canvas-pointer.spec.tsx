/**
 * 自由画布指针手势组件用例（P1-2 前置：freeCanvas 此前零组件级覆盖）：
 * 框选（marquee 命中 + 选集）、连线（handle 拉线 → 落点建边）、吸附（node 拖拽
 * 对齐参考线 + 吸附修正）三路径走真实 useCanvasPointer + freeViewStore。
 * 本文件 stub rAF（P1-2 合帧后 move 走帧调度，手动 flush 驱动，确定性断言）。
 * 还原即红：对应实现被摘除时相应断言转红。
 * 运行: npx vitest run test/unit/free-canvas-pointer.spec.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { useCanvasPointer } from '../../src/renderer/src/panels/freeCanvas/useCanvasPointer';
import type { CanvasPointerApi, CanvasPointerOptions } from '../../src/renderer/src/panels/freeCanvas/types';
import { setFreeViewLayout, getFreeViewLayout, useFreeViewLayout } from '../../src/renderer/src/panels/freeViewStore';
import { emptyFreeViewLayout } from '../../src/renderer/src/panels/freeViewGeom';

/* ---------- rAF 桩：手动 flush 驱动帧调度（jsdom 无实现） ---------- */
let rafCbs: Array<() => void> = [];
const flushRaf = (): void => {
  const cbs = rafCbs;
  rafCbs = [];
  cbs.forEach((cb) => cb());
};
vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
  rafCbs.push(() => cb(0));
  return rafCbs.length;
});
vi.stubGlobal('cancelAnimationFrame', () => undefined);

/* ---------- pointer capture 桩（jsdom 未实现） ---------- */
beforeAll(() => {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => true;
});

/* ---------- 被测几何：n1(0,0) 可拖；n2(600,0) 静态吸附/连线目标 ---------- */
const RECT_W = 248;
const RECT_H = 70;
const rectOf = (id: string) => {
  if (id === 'n1') return { x: 0, y: 0, w: RECT_W, h: RECT_H };
  if (id === 'n2') return { x: 600, y: 0, w: RECT_W, h: RECT_H };
  return null;
};

function PointerHarness({
  apiRef,
  space,
  renderCount
}: {
  apiRef: { current: CanvasPointerApi | null };
  space?: boolean;
  renderCount?: { n: number };
}): React.JSX.Element {
  // 订阅 store：updateFreeViewLayout 每次写都触发本组件重渲（P1-2 合帧计数器）
  useFreeViewLayout();
  if (renderCount) renderCount.n += 1;
  const spaceRef = { current: space ?? false };
  const opts: CanvasPointerOptions = {
    active: true,
    selNodes: [],
    setSelNodes: () => undefined,
    setSelEdges: () => undefined,
    setSelGroups: () => undefined,
    visibleIdSet: new Set(['n1', 'n2']),
    sessionIdSet: new Set(),
    stickyById: new Map(),
    stickies: [],
    hOf: () => RECT_H,
    rectOf,
    localPoint: (e) => ({ x: e.clientX, y: e.clientY }),
    toWorld: (x, y) => ({ x, y }),
    noteEdit: null,
    commitNoteEdit: () => undefined,
    interruptArrange: () => undefined,
    onSelectSession: () => undefined,
    isLinkMenuOpen: () => false,
    cancelLinkMenuRequest: () => undefined,
    requestLinkMenu: () => undefined,
    spaceRef
  };
  const api = useCanvasPointer(opts);
  apiRef.current = api;
  return (
    <div
      data-testid="canvas"
      onPointerDown={api.onPointerDown}
      onPointerMove={api.onPointerMove}
      onPointerUp={api.onPointerUp}
      onPointerCancel={api.onPointerCancel}
    >
      <div data-cnode="n1">
        <div data-fc-handle="e" data-testid="n1-handle" />
      </div>
      <div data-cnode="n2" data-testid="n2-el" />
    </div>
  );
}

let apiRef: { current: CanvasPointerApi | null };
let view: ReturnType<typeof render> | null = null;

function mount(
  space = false,
  renderCount?: { n: number }
): HTMLElement {
  apiRef = { current: null };
  view = render(<PointerHarness apiRef={apiRef} space={space} renderCount={renderCount} />);
  return view.container.querySelector('[data-testid="canvas"]') as HTMLElement;
}

const seedNodes = (): void => {
  setFreeViewLayout({ ...emptyFreeViewLayout(), nodes: { n1: { x: 0, y: 0 }, n2: { x: 600, y: 0 } } });
};

describe('自由画布指针手势（P1-2 前置覆盖）', () => {
  beforeEach(() => {
    rafCbs = [];
    setFreeViewLayout(emptyFreeViewLayout());
  });
  afterEach(() => {
    view?.unmount();
    view = null;
    vi.restoreAllMocks();
  });

  it('框选：空白按下拖出矩形，命中节点进选集，松手收起', () => {
    seedNodes();
    const canvas = mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    expect(apiRef.current!.marquee).not.toBeNull();
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 30, clientY: 30 });
    act(() => flushRaf());
    // marquee 矩形 (5,5)-(30,30) 命中 n1(0,0,248,70)
    expect(apiRef.current!.marquee).toEqual({ x0: 5, y0: 5, x1: 30, y1: 30 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 30, clientY: 30 });
    expect(apiRef.current!.marquee).toBeNull();
  });

  it('连线：handle 按下拉线，hover 目标节点，松手建边 n1→n2', () => {
    seedNodes();
    const canvas = mount();
    const n2El = view!.container.querySelector('[data-testid="n2-el"]') as Element;
    // jsdom 无 elementFromPoint：直接挂桩返回 n2 元素
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => n2El;

    fireEvent.pointerDown(view!.container.querySelector('[data-testid="n1-handle"]')!, {
      button: 0,
      pointerId: 2,
      clientX: 248,
      clientY: 35
    });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 700, clientY: 35 });
    act(() => flushRaf());
    // hover 目标：linkDrag 记录 from/hover
    expect(apiRef.current!.linkDrag?.hoverId).toBe('n2');
    expect(apiRef.current!.linkDrag?.from).toBe('n1');
    // 松手在 n2 上：建边 n1→n2
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 700, clientY: 35 });
    const l = getFreeViewLayout();
    expect(l.edges.length).toBe(1);
    expect(l.edges[0]).toMatchObject({ from: 'n1', to: 'n2' });
  });

  it('吸附：node 拖拽对齐静态节点左边线，出参考线并吸附修正落位', () => {
    seedNodes();
    const canvas = mount();
    const n1El = view!.container.querySelector('[data-cnode="n1"]') as Element;
    fireEvent.pointerDown(n1El, { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
    // 拖到 n1 左边线与 n2 左边线（x=600）对齐（y 差 2px 在 6px 吸附阈内）
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 610, clientY: 12 });
    act(() => flushRaf());
    // 吸附参考线（x=600 对齐线）出现
    expect(apiRef.current!.guides.length).toBeGreaterThan(0);
    // 拖拽写回：n1 落在吸附位（x=600，y 被吸附回 0）
    const l = getFreeViewLayout();
    expect(l.nodes.n1).toMatchObject({ x: 600, y: 0 });
  });
});

// ---------- 拖拽帧合帧（P1-2）----------
// 契约：拖拽期连续 pointermove 只入 ref + rAF 调度（帧未 flush 前 store 零写），
// flush 后至多一次写且为尾值；pointerup 携带更晚事件时同步 flush 尾值。
// 还原即红：恢复 onPointerMove 单 commit（每事件直写 store）后，
// 「帧未 flush store 不变」断言转红。
describe('拖拽帧合帧（P1-2）', () => {
  beforeEach(() => {
    rafCbs = [];
    setFreeViewLayout(emptyFreeViewLayout());
  });
  afterEach(() => {
    view?.unmount();
    view = null;
    vi.restoreAllMocks();
  });

  it('连续 move 不逐事件写 store；flush 应用尾值；pointerup 同步 flush', () => {
    seedNodes();
    const counter = { n: 0 };
    const canvas = mount(true, counter);
    // space 按下 = pan 手势：down (10,10)，startPan (0,0)
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
    counter.n = 0;
    // 连续 5 次 move（不 flush rAF）：store 零写（零重渲）
    for (let i = 1; i <= 5; i++) {
      fireEvent.pointerMove(canvas, { pointerId: 9, clientX: 10 + i * 10, clientY: 10 });
    }
    expect(getFreeViewLayout().pan.x).toBe(0);
    expect(counter.n).toBe(0);
    // flush 一帧：至多一次写，应用尾值（最后 move → pan.x = 50）
    act(() => flushRaf());
    expect(getFreeViewLayout().pan.x).toBe(50);
    expect(counter.n).toBe(1);
    // pointerup 携带更晚 move：同步 flush 尾值（pan.x = 110）
    fireEvent.pointerMove(canvas, { pointerId: 9, clientX: 120, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 9, clientX: 120, clientY: 10 });
    expect(getFreeViewLayout().pan.x).toBe(110);
  });
});
