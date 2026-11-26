/**
 * 虚拟屏分割条触发区与把手菜单（组件级）：
 * - 全高 28px 检测带即热区：压线任意位置（pointerenter）即召出按钮并上报 along；
 * - 旧版竖直居中一小段 `.pane-split-zone` 触发区 + 幽灵胶囊指示器已删（两屏贴死
 *   年代怕热区难触发的妥协；页缝有框色间隔后不再需要）；
 * - 离开条带熄灭；长按拖调大小松手后保持热态（等指针真正离开再熄）；
 * - 短按按钮开关虚拟屏；
 * - 长按菜单三落点=悬浮/点击切屏/关闭虚拟屏：is-current 跟随真实态（VS 开高亮
 *   现行切屏方式、VS 关高亮「关闭虚拟屏」），拖到「关闭虚拟屏」提交 onVsOff；
 * - 截图等抢走指针捕获/窗口焦点时拖拽必须收尾回滚（lostpointercapture / blur），
 *   且正常松手不因捕获释放事件二次收尾。
 * jsdom 查交互状态；热区命中、按钮 hover 视觉与跟手渲染走浏览器 QA
 * （test/frame-gap-visual.mjs 守 CSS 几何）。
 */
import React, { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitExpandControl } from '../../src/renderer/src/components/SplitExpandControl';

class StubPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

const HIT_RECT = new DOMRect(0, 0, 28, 600);
const BTN_RECT = new DOMRect(0, 288, 28, 24);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', StubPointerEvent);
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn()
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('pane-split-hit')) return HIT_RECT;
    if (this.classList.contains('split-expand-btn')) return BTN_RECT;
    return new DOMRect();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Events = {
  along: number[];
  hot: boolean[];
  toggles: number;
  focusToggles: number;
  switchModes: string[];
  resizeEnds: (boolean | undefined)[];
};

function renderHarness(
  hVs = true,
  switchMode: 'hover' | 'click' = 'hover',
  focusMode = false
): Events {
  const events: Events = {
    along: [], hot: [], toggles: 0, focusToggles: 0, switchModes: [], resizeEnds: []
  };
  function Harness(): React.JSX.Element {
    const [hot, setHot] = useState(false);
    return (
      <SplitExpandControl
        hVs={hVs}
        focusMode={focusMode}
        along={0.5}
        switchMode={switchMode}
        visible={hot}
        growSign={1}
        onAlong={(t) => {
          events.along.push(t);
        }}
        onHotChange={(v) => {
          events.hot.push(v);
          setHot(v);
        }}
        onSwitchMode={(mode) => {
          events.switchModes.push(mode);
        }}
        onToggleFocus={() => {
          events.focusToggles += 1;
        }}
        onBtnPointerActive={() => {}}
        onResizeStart={() => {}}
        onResizeMove={() => {}}
        onResizeEnd={(canceled) => {
          events.resizeEnds.push(canceled);
        }}
      />
    );
  }
  render(<Harness />);
  return events;
}

const hit = (): HTMLElement => document.querySelector('.pane-split-hit') as HTMLElement;
const btn = (): HTMLElement | null => document.querySelector('.split-expand-btn');
const drops = (): HTMLElement[] =>
  [...document.querySelectorAll('.split-mode-drop')] as HTMLElement[];

/** 长按进入 picking 菜单（400ms 定时） */
function enterPick(target: HTMLElement): void {
  fireEvent.pointerDown(target, {
    clientX: 14, clientY: 300, button: 0, buttons: 1, pointerId: 1
  });
  act(() => {
    vi.advanceTimersByTime(400);
  });
}

function flushFrame(): void {
  act(() => {
    vi.advanceTimersByTime(20);
  });
}

describe('虚拟屏分割条触发区', () => {
  it('右侧虚拟屏收起时不挂载悬浮热区和把手', () => {
    const events = renderHarness(false);
    expect(hit()).toBeNull();
    expect(btn()).toBeNull();
    expect(events.hot).toEqual([]);
  });

  it('压线任意位置即召出按钮并上报 along，胶囊触发区已删除', () => {
    const events = renderHarness();
    expect(document.querySelector('.pane-split-zone')).toBeNull();
    // 中段以外（沿条 25%）压线同样召出——整条即热区
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 150, pointerId: 1 });
    expect(events.hot.at(-1)).toBe(true);
    expect(events.along.at(-1)).toBeCloseTo(0.25);
    expect(btn()).toBeTruthy();
    fireEvent.pointerMove(hit(), { clientX: 14, clientY: 450, pointerId: 1 });
    expect(events.along.at(-1)).toBeCloseTo(0.75);
  });

  it('离开条带熄灭，按钮收起', () => {
    const events = renderHarness();
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    expect(btn()).toBeTruthy();
    fireEvent.pointerLeave(hit(), { pointerId: 1 });
    expect(events.hot.at(-1)).toBe(false);
    expect(btn()).toBeNull();
  });

  it('短按无动作（开/关虚拟屏由顶栏右栏开关承担，与把手不重复）', () => {
    const events = renderHarness();
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    const button = btn() as HTMLElement;
    fireEvent.pointerDown(button, {
      clientX: 14, clientY: 300, button: 0, buttons: 1, pointerId: 1
    });
    fireEvent.pointerUp(button, {
      clientX: 14, clientY: 300, button: 0, buttons: 0, pointerId: 1
    });
    expect(events.toggles).toBe(0);
    expect(events.switchModes).toHaveLength(0);
  });

  it('长按拖调大小松手后保持热态，不误触发开关', () => {
    const events = renderHarness();
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    const button = btn() as HTMLElement;
    enterPick(button);
    fireEvent.pointerMove(button, {
      clientX: 40, clientY: 300, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    fireEvent.pointerUp(button, {
      clientX: 40, clientY: 300, button: 0, buttons: 0, pointerId: 1
    });
    expect(events.resizeEnds.at(-1)).toBe(false);
    // 松手时指针通常仍压在条上：保持热态（线体加亮 + 按钮召出），等真正离开再熄
    expect(events.hot.at(-1)).toBe(true);
    expect(events.toggles).toBe(0);
  });
});

describe('把手长按菜单落点', () => {
  it('VS 开启高亮现行切屏方式，拖到「关闭虚拟屏」提交 onToggleFocus', () => {
    const events = renderHarness(true, 'click');
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    enterPick(btn() as HTMLElement);
    const [hoverDrop, clickDrop, vsOffDrop] = drops();
    expect(hoverDrop.classList.contains('is-current')).toBe(false);
    expect(clickDrop.classList.contains('is-current')).toBe(true);
    expect(vsOffDrop.classList.contains('is-current')).toBe(false);
    // 拖到正下方「关闭虚拟屏」落点（原点下方 48px）松手 → 切换双栏全屏态
    fireEvent.pointerMove(btn() as HTMLElement, {
      clientX: 14, clientY: 348, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    expect(vsOffDrop.classList.contains('is-armed')).toBe(true);
    fireEvent.pointerUp(btn() as HTMLElement, {
      clientX: 14, clientY: 348, button: 0, buttons: 0, pointerId: 1
    });
    expect(events.focusToggles).toBe(1);
    expect(events.switchModes).toHaveLength(0);
  });

  it('「关闭虚拟屏」态下切屏方式落点不高亮、第三落点高亮且菜单初开即预亮', () => {
    renderHarness(false, 'hover', true);
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    enterPick(btn() as HTMLElement);
    const [hoverDrop, clickDrop, vsOffDrop] = drops();
    expect(hoverDrop.classList.contains('is-current')).toBe(false);
    expect(clickDrop.classList.contains('is-current')).toBe(false);
    expect(vsOffDrop.classList.contains('is-current')).toBe(true);
    // 当前态落点初开即预亮（hoverTarget 初始即 focus）
    expect(vsOffDrop.classList.contains('is-armed')).toBe(true);
  });

  it('调宽轴锁定：拖回起点附近切屏落点不回弹，松手不误提交落点', () => {
    const events = renderHarness();
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    const button = btn() as HTMLElement;
    enterPick(button);
    // 水平越过阈值 → 锁定调大小轴，落点让位
    fireEvent.pointerMove(button, {
      clientX: 40, clientY: 300, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    expect(drops()).toHaveLength(0);
    // 拖回起点附近（|dx| 缩回阈值内）→ 轴不回弹，落点不闪回
    fireEvent.pointerMove(button, {
      clientX: 20, clientY: 302, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    expect(drops()).toHaveLength(0);
    // 甚至拖到「关闭虚拟屏」落点坐标上松手：调大小轴锁定不提交落点
    fireEvent.pointerMove(button, {
      clientX: 14, clientY: 348, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    fireEvent.pointerUp(button, {
      clientX: 14, clientY: 348, button: 0, buttons: 0, pointerId: 1
    });
    expect(events.switchModes).toHaveLength(0);
    expect(events.focusToggles).toBe(0);
    expect(events.resizeEnds.at(-1)).toBe(false);
  });

  it('水平拖锁定调大小轴后，拖回起点或转纵向切屏落点都不回弹（换轴须松手重开）', () => {
    renderHarness();
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    enterPick(btn() as HTMLElement);
    // 未动：三落点齐显
    expect(drops()).toHaveLength(3);
    // 水平主导（dx=26 > SIZE_ARM_PX）→ 落点全部隐藏，锁定调大小轴
    fireEvent.pointerMove(btn() as HTMLElement, {
      clientX: 40, clientY: 300, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    expect(drops()).toHaveLength(0);
    // 转纵向 / 拖回起点附近：轴锁不回弹，落点不再出现
    fireEvent.pointerMove(btn() as HTMLElement, {
      clientX: 40, clientY: 340, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    expect(drops()).toHaveLength(0);
    fireEvent.pointerMove(btn() as HTMLElement, {
      clientX: 20, clientY: 302, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    expect(drops()).toHaveLength(0);
  });

  it('悬停显示自绘提示，按下/长按菜单即隐；不挂原生 title', () => {
    renderHarness();
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    const button = btn() as HTMLElement;
    expect(button.hasAttribute('title')).toBe(false);
    // 提示只跟按钮悬停走：检测带热态不显示，悬停到按钮才显示
    expect(document.querySelector('.split-hint-drop')).toBeNull();
    fireEvent.pointerEnter(button, { clientX: 14, clientY: 300, pointerId: 1 });
    expect(document.querySelector('.split-hint-drop')).toBeTruthy();
    // 按下即隐（不用等长按菜单弹出）
    fireEvent.pointerDown(button, {
      clientX: 14, clientY: 300, button: 0, buttons: 1, pointerId: 1
    });
    expect(document.querySelector('.split-hint-drop')).toBeNull();
    // 长按菜单开着也不回显
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.querySelector('.split-hint-drop')).toBeNull();
    // 松手回按钮上恢复悬停提示
    fireEvent.pointerUp(button, {
      clientX: 14, clientY: 300, button: 0, buttons: 0, pointerId: 1
    });
    expect(document.querySelector('.split-hint-drop')).toBeTruthy();
  });
});

describe('拖拽打断兜底', () => {
  it.each([
    ['窗口失焦', 'blur'],
    ['指针捕获被抢', 'lostpointercapture']
  ] as const)('%s时按取消收尾并回滚，后续指针事件不二次收尾', (_name, kind) => {
    const events = renderHarness();
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    const button = btn() as HTMLElement;
    enterPick(button);
    fireEvent.pointerMove(button, {
      clientX: 40, clientY: 300, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    if (kind === 'blur') {
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
    } else {
      act(() => {
        fireEvent.lostPointerCapture(button);
      });
    }
    expect(events.resizeEnds).toEqual([true]);
    // 残留的 pointerup（捕获已丢、落点在别处后回投）不得二次收尾/误触开关
    fireEvent.pointerUp(button, {
      clientX: 40, clientY: 300, button: 0, buttons: 0, pointerId: 1
    });
    expect(events.resizeEnds).toEqual([true]);
    expect(events.toggles).toBe(0);
  });
});
