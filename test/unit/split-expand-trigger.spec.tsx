/** 把手触发带、拖动选项和进出场。实际命中范围由 Electron 端到端测试验证。 */
import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
let buttonRect: DOMRect;

beforeEach(() => {
  buttonRect = new DOMRect(0, 284, 28, 32);
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
    if (this.classList.contains('split-expand-btn')) return buttonRect;
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
  focusToggles: number;
  switchModes: string[];
  resizeStarts: number;
  resizeMoves: number[];
  resizeEnds: boolean[];
};

function renderHarness(
  hVs = true,
  switchMode: 'hover' | 'click' = 'hover',
  focusMode = false
): Events {
  const events: Events = {
    along: [], hot: [], focusToggles: 0, switchModes: [], resizeStarts: 0, resizeMoves: [], resizeEnds: []
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
        onResizeStart={() => { events.resizeStarts += 1; }}
        onResizeMove={(x) => { events.resizeMoves.push(x); }}
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
const btn = (): HTMLElement | null => document.querySelector('.split-expand-btn[data-pointer-active]');
const menu = (): HTMLElement | null => document.querySelector('.split-mode-menu');
const drops = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.split-mode-menu:not([data-mp-stage="out"]) .split-mode-drop')];
const hint = (): HTMLElement | null => document.querySelector('.split-hint-drop:not([data-mp-stage="out"])');
const reveal = (): void => { fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 }); };

/** 长按进入 picking 菜单（400ms 定时） */
function enterPick(target: HTMLElement): void {
  fireEvent.pointerDown(target, {
    clientX: buttonRect.x + buttonRect.width / 2, clientY: buttonRect.y + buttonRect.height / 2,
    button: 0, buttons: 1, pointerId: 1
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

  it('离开条带立即释放按钮命中，快速移回复用尚在退场的把手', () => {
    const events = renderHarness();
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    expect(btn()).toBeTruthy();
    fireEvent.pointerLeave(hit(), { pointerId: 1 });
    expect(events.hot.at(-1)).toBe(false);
    expect(btn()).toBeNull();
    const grip = document.querySelector('.split-expand-grip')!;
    expect(grip.getAttribute('data-mp-stage')).toBe('out');
    reveal();
    expect(document.querySelector('.split-expand-grip')).toBe(grip);
    expect(grip.getAttribute('data-mp-stage')).toBe('in');
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
    expect(events.focusToggles).toBe(0);
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
    expect(events.focusToggles).toBe(0);
  });
});

describe('把手长按菜单落点', () => {
  it('长按展示一张菜单，尚未横拖时不进入调宽状态', () => {
    const events = renderHarness();
    reveal();
    enterPick(btn()!);
    expect(document.querySelectorAll('.split-mode-menu')).toHaveLength(1);
    expect(menu()?.getAttribute('data-mp-stage')).toBe('in');
    expect(drops()).toHaveLength(3);
    expect(events.resizeStarts).toBe(0);
    fireEvent.pointerUp(btn()!, { clientX: 14, clientY: 300, pointerId: 1 });
    expect(menu()?.getAttribute('data-mp-stage')).toBe('out');
    expect(menu()?.hasAttribute('inert')).toBe(true);
    expect(events.switchModes).toEqual([]);
    expect(events.resizeEnds).toEqual([]);
  });

  it.each([
    [24, 56, 'click'],
    [574, 542, 'focus']
  ] as const)('贴近纵向边缘时向有空间的一侧展开，并可拖到可见行（%d）', (originY, targetY, mode) => {
    const events = renderHarness();
    buttonRect = new DOMRect(0, originY - 16, 28, 32);
    reveal();
    const button = btn()!;
    enterPick(button);
    fireEvent.pointerMove(button, { clientX: 14, clientY: targetY, buttons: 1, pointerId: 1 });
    flushFrame();
    expect(drops().find(row => row.dataset.mode === mode)?.classList.contains('is-armed')).toBe(true);
    fireEvent.pointerUp(button, { clientX: 14, clientY: targetY, pointerId: 1 });
    expect(events.switchModes).toEqual(mode === 'click' ? ['click'] : []);
    expect(events.focusToggles).toBe(mode === 'focus' ? 1 : 0);
    expect(events.resizeStarts).toBe(0);
  });

  it('键盘从当前项进入，Esc 归还焦点，退场中重开可选模式', () => {
    const events = renderHarness();
    const button = screen.getByRole('button', { name: '虚拟屏操作' });
    act(() => button.focus());
    fireEvent.click(button, { detail: 0 });
    const hover = screen.getByRole('menuitemradio', { name: '鼠标悬浮切屏' });
    const click = screen.getByRole('menuitemradio', { name: '鼠标点击切屏' });
    expect(document.activeElement).toBe(hover);
    expect(hover.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(hover, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(click);
    const surface = menu();
    fireEvent.keyDown(click, { key: 'Escape' });
    expect(document.activeElement).toBe(button);
    expect(surface?.getAttribute('data-mp-stage')).toBe('out');
    expect(surface?.hasAttribute('inert')).toBe(true);
    fireEvent.click(button, { detail: 0 });
    expect(menu()).toBe(surface);
    expect(surface?.getAttribute('data-mp-stage')).toBe('in');
    fireEvent.click(click);
    expect(events.switchModes).toEqual(['click']);
  });

  it('VS 开启高亮现行切屏方式，拖到「关闭虚拟屏」提交 onToggleFocus', () => {
    const events = renderHarness(true, 'click');
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    enterPick(btn() as HTMLElement);
    const [clickDrop, hoverDrop, vsOffDrop] = drops();
    expect(hoverDrop.classList.contains('is-current')).toBe(false);
    expect(clickDrop.classList.contains('is-current')).toBe(true);
    expect(vsOffDrop.classList.contains('is-current')).toBe(false);
    // 拖到正下方「关闭虚拟屏」落点（原点下方 32px）松手 → 切换双栏全屏态
    fireEvent.pointerMove(btn() as HTMLElement, {
      clientX: 14, clientY: 332, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    expect(vsOffDrop.classList.contains('is-armed')).toBe(true);
    fireEvent.pointerUp(btn() as HTMLElement, {
      clientX: 14, clientY: 332, button: 0, buttons: 0, pointerId: 1
    });
    expect(events.focusToggles).toBe(1);
    expect(events.switchModes).toHaveLength(0);
  });

  it('「关闭虚拟屏」态下切屏方式落点不高亮、第三落点高亮且菜单初开即预亮', () => {
    renderHarness(false, 'hover', true);
    fireEvent.pointerEnter(hit(), { clientX: 14, clientY: 300, pointerId: 1 });
    enterPick(btn() as HTMLElement);
    const [clickDrop, hoverDrop, vsOffDrop] = drops();
    expect(hoverDrop.classList.contains('is-current')).toBe(false);
    expect(clickDrop.classList.contains('is-current')).toBe(false);
    expect(vsOffDrop.classList.contains('is-current')).toBe(true);
    // 当前态落点初开即预亮（hoverTarget 初始即 focus）
    expect(vsOffDrop.classList.contains('is-armed')).toBe(true);
  });

  it.each([
    [268, 'hover', 26, 'right'],
    [332, 'focus', -26, 'left']
  ] as const)('从%s这一行回到加减号时可以直接改为调宽', (rowY, mode, dx, direction) => {
    buttonRect = new DOMRect(180, 284, 28, 32);
    const events = renderHarness();
    reveal();
    const button = btn()!;
    enterPick(button);
    const pill = document.querySelector('.split-menu-resize');
    const move = (x: number, y: number): void => {
      fireEvent.pointerMove(button, { clientX: x, clientY: y, buttons: 1, pointerId: 1 });
      flushFrame();
    };

    move(194, rowY);
    move(194 + dx, rowY);
    expect(drops().find(row => row.dataset.mode === mode)?.classList.contains('is-armed')).toBe(true);
    expect(events.resizeStarts).toBe(0);

    move(194 + dx, 300);
    expect(events.resizeStarts).toBe(1);
    expect(events.resizeMoves).toEqual([194 + dx]);
    expect(menu()?.getAttribute('data-mp-stage')).toBe('out');
    expect(menu()?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.split-menu-resize')).toBe(pill);
    expect(pill?.getAttribute('data-mp-stage')).toBe('in');
    expect(pill?.getAttribute('data-direction')).toBe(direction);

    fireEvent.pointerUp(button, { clientX: 194 + dx, clientY: 300, pointerId: 1 });
    expect(events.resizeEnds).toEqual([false]);
    expect(events.switchModes).toEqual([]);
    expect(events.focusToggles).toBe(0);
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
      clientX: 14, clientY: 332, button: 0, buttons: 1, pointerId: 1
    });
    flushFrame();
    fireEvent.pointerUp(button, {
      clientX: 14, clientY: 332, button: 0, buttons: 0, pointerId: 1
    });
    expect(events.switchModes).toHaveLength(0);
    expect(events.focusToggles).toBe(0);
    expect(events.resizeEnds.at(-1)).toBe(false);
  });

  it('指针越过分割线的调宽限位再折返时，仍使用同一次拖动的起点', () => {
    buttonRect = new DOMRect(346, 284, 28, 32);
    const events = renderHarness();
    reveal();
    const button = btn()!;
    enterPick(button);
    const move = (x: number): void => {
      fireEvent.pointerMove(button, { clientX: x, clientY: 300, buttons: 1, pointerId: 1 });
      flushFrame();
    };

    move(430);
    // 容器把分割线限制在 x=400，指针仍可越过分割线后折返。
    buttonRect = new DOMRect(386, 284, 28, 32);
    move(480);
    move(390);
    fireEvent.pointerUp(button, { clientX: 390, clientY: 300, pointerId: 1 });

    expect(events.resizeStarts).toBe(1);
    expect(events.resizeMoves).toEqual([430, 480, 390]);
    expect(events.resizeEnds).toEqual([false]);
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
    expect(hint()).toBeNull();
    fireEvent.pointerEnter(button, { clientX: 14, clientY: 300, pointerId: 1 });
    expect(hint()).toBeTruthy();
    // 按下即隐（不用等长按菜单弹出）
    fireEvent.pointerDown(button, {
      clientX: 14, clientY: 300, button: 0, buttons: 1, pointerId: 1
    });
    expect(hint()).toBeNull();
    // 长按菜单开着也不回显
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(hint()).toBeNull();
    // 松手回按钮上恢复悬停提示
    fireEvent.pointerUp(button, {
      clientX: 14, clientY: 300, button: 0, buttons: 0, pointerId: 1
    });
    expect(hint()).toBeTruthy();
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
    expect(events.focusToggles).toBe(0);
  });
});
