/**
 * 会话内展开/收起全面动画化 + 输入条高度弹簧（2026-10-31）：
 * - AnimatedDetails（工具卡/思考卡/harness 标注共用）：收起态内容不进 DOM
 *   （同原生 closed details），点 summary 展开 acc 折叠体（is-open），收起走
 *   presence 退场窗口后真卸载；受控模式由宿主驱动；
 * - useSmoothComposerHeight：内容高度变化经弹簧逐帧写 wrap 显式 height，
 *   收敛即停 rAF；减少动态不接管。
 * 运行：npm run test:unit -- test/unit/chat-animated-details.spec.tsx
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { AnimatedDetails } from '../../src/renderer/src/components/AnimatedDetails';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { useSmoothComposerHeight } from '../../src/renderer/src/chatSurface/smoothComposerHeight';
import { resetRevealTickerForTest, revealTickerIdle } from '../../src/renderer/src/chatSurface/revealTicker';
import type { ChatMessage } from '../../src/shared/types';

const state = vi.hoisted(() => ({ reduced: false, listeners: new Set<() => void>() }));
vi.mock('../../src/renderer/src/interactionPreferences', () => ({
  getInteractionPreferences: () => ({ scrollFeel: 'native', scrollDistance: 1, motion: 'system' }),
  prefersReducedMotionPreference: () => state.reduced,
  subscribeInteractionPreferences: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); }
}));

let now = 0;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
let observers: Array<ResizeObserverCallback> = [];

beforeEach(() => {
  now = 0; nextFrame = 0; frames.clear(); observers = [];
  state.reduced = false; state.listeners.clear();
  resetRevealTickerForTest();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.push(callback); }
    observe() {}
    disconnect() { observers = observers.filter(callback => callback !== this.callback); }
    unobserve() {}
  });
});
afterEach(() => {
  cleanup(); document.body.innerHTML = '';
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function frame(ms = 16): void {
  now += ms;
  const pending = [...frames.values()]; frames.clear();
  act(() => { for (const fn of pending) fn(now); });
}
function pumpFrames(limit = 160): void {
  for (let i = 0; i < limit && frames.size > 0; i++) frame(16);
}
/** RO 桩触发（模拟内容尺寸变化） */
function contentResized(): void {
  act(() => { for (const cb of observers) cb([], {} as ResizeObserver); });
}

describe('AnimatedDetails（会话内 details 展开动画）', () => {
  it('收起态内容不进 DOM；点 summary 展开 acc 折叠体', () => {
    const view = render(
      <AnimatedDetails className="tool-card tool-lite ok" summary={<span>动词 · 详情</span>}>
        <div className="tool-detail">结果正文</div>
      </AnimatedDetails>
    );
    const details = view.container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(view.container.textContent).not.toContain('结果正文'); // 收起零挂载
    fireEvent.click(view.container.querySelector('summary')!);
    expect(details.open).toBe(true);
    const body = view.container.querySelector('.details-anim-body')!;
    expect(body.classList.contains('acc')).toBe(true);
    expect(body.classList.contains('is-open')).toBe(true); // enter→in 提交后起播
    expect(view.container.textContent).toContain('结果正文');
    view.unmount();
  });

  it('summary 内嵌交互元素（文件链接等）点击不翻转折叠', () => {
    const onFileLink = vi.fn();
    const view = render(
      <AnimatedDetails
        summary={
          <span>
            读取 ·{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault(); // 与 ToolTitleTarget 同型：只 preventDefault 不 stopPropagation
                onFileLink();
              }}
            >
              src/main.ts
            </a>
          </span>
        }
      >
        <div className="tool-detail">正文</div>
      </AnimatedDetails>
    );
    fireEvent.click(view.container.querySelector('summary a')!);
    expect(onFileLink).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('details')!.open).toBe(false); // 不附带翻转
    expect(view.container.textContent).not.toContain('正文');
    fireEvent.click(view.container.querySelector('summary span')!); // 点普通文字仍翻转
    expect(view.container.querySelector('details')!.open).toBe(true);
    view.unmount();
  });

  it('再点收起：退场窗口内内容仍在，退场后真卸载', async () => {
    const view = render(
      <AnimatedDetails summary="头"><div className="tool-detail">正文X</div></AnimatedDetails>
    );
    fireEvent.click(view.container.querySelector('summary')!);
    expect(view.container.textContent).toContain('正文X');
    fireEvent.click(view.container.querySelector('summary')!); // 收起
    expect(view.container.querySelector('.details-anim-body')).toBeTruthy();
    expect(view.container.querySelector('.details-anim-body')!.classList.contains('is-open')).toBe(false);
    expect(view.container.textContent).toContain('正文X'); // 播退场动画期间仍在
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); }); // exitMs+80 之后
    expect(view.container.querySelector('.details-anim-body')).toBeNull();
    expect(view.container.textContent).not.toContain('正文X');
  });

  it('受控模式：open/onToggle 由宿主驱动（思考卡用法）', () => {
    function Host() {
      const [open, setOpen] = React.useState(false);
      return <AnimatedDetails open={open} onToggle={setOpen} summary="思考"><div>思考正文</div></AnimatedDetails>;
    }
    const view = render(<Host />);
    expect(view.container.textContent).not.toContain('思考正文');
    fireEvent.click(view.container.querySelector('summary')!);
    expect(view.container.textContent).toContain('思考正文');
    fireEvent.click(view.container.querySelector('summary')!);
    expect(view.container.querySelector('.details-anim-body')).toBeTruthy(); // 退场窗口
  });

  it('减少动态：即时开合，无退场窗口', () => {
    state.reduced = true;
    const view = render(
      <AnimatedDetails summary="头"><div>正文R</div></AnimatedDetails>
    );
    fireEvent.click(view.container.querySelector('summary')!);
    expect(view.container.querySelector('.details-anim-body')!.classList.contains('is-open')).toBe(true);
    fireEvent.click(view.container.querySelector('summary')!);
    expect(view.container.querySelector('.details-anim-body')).toBeNull(); // 立即卸载
    expect(view.container.textContent).not.toContain('正文R');
    state.reduced = false;
  });

  it('工具卡接入：错误终态即时在摘要行，输出点开后可见', () => {
    const message = {
      id: 'm', role: 'assistant', createdAt: Date.now(), content: '完',
      parts: [{
        kind: 'tool',
        toolCall: { id: 't', name: 'shell', arguments: '{}', input: {}, status: 'error', result: 'boom output' }
      }]
    } as unknown as ChatMessage;
    const view = render(<ChatMessageView message={message} streaming={false} timeLabel="" quiet />);
    fireEvent.click(view.container.querySelector('.tool-call-group-details > summary')!);
    const card = view.container.querySelector('.tool-card.error')!;
    expect(card).toBeTruthy();
    expect(view.container.textContent).not.toContain('boom output'); // 收起零挂载
    fireEvent.click(card.querySelector('summary')!);
    expect(view.container.textContent).toContain('boom output');
  });
});

describe('useSmoothComposerHeight（输入条高度弹簧）', () => {
  /** 模拟 composer：wrap（高度被弹簧接管）+ 内容子元素（点击在 100/200px 间切换） */
  function Harness() {
    const wrapRef = React.useRef<HTMLDivElement>(null);
    const [tall, setTall] = React.useState(false);
    const height = tall ? 200 : 100;
    const contentRef = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
      const content = contentRef.current!;
      const wrap = wrapRef.current!;
      Object.defineProperty(content, 'checkVisibility', { configurable: true, value: () => true });
      Object.defineProperty(content, 'offsetHeight', { configurable: true, get: () => height });
      Object.defineProperty(wrap, 'offsetHeight', {
        configurable: true,
        get: () => (wrap.style.height ? Number.parseFloat(wrap.style.height) : height)
      });
    }); // 每拍重定义：getter 闭包读最新 height
    useSmoothComposerHeight(wrapRef);
    return (
      <div ref={wrapRef} style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
        <div ref={contentRef} onClick={() => setTall((v) => !v)}>composer</div>
      </div>
    );
  }

  it('首挂 snap 到自然高度（不播开屏动画），内容增长经弹簧平滑到新高度', () => {
    const view = render(<Harness />);
    const wrap = view.container.firstElementChild as HTMLElement;
    expect(wrap.style.height).toBe('100px'); // snap
    fireEvent.click(wrap.firstElementChild!); // 内容长高 100→200
    contentResized(); // RO 唤醒弹簧任务
    frame(16);
    const mid = Number.parseFloat(wrap.style.height);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(200); // 不硬切
    pumpFrames();
    expect(wrap.style.height).toBe('200px');
    expect(revealTickerIdle()).toBe(true); // 收敛即停 rAF
    view.unmount();
    expect(revealTickerIdle()).toBe(true);
  });

  it('收缩同样平滑（变大变小都走弹簧）', () => {
    const view = render(<Harness />);
    const wrap = view.container.firstElementChild as HTMLElement;
    fireEvent.click(wrap.firstElementChild!); // →200
    contentResized(); pumpFrames();
    expect(wrap.style.height).toBe('200px');
    fireEvent.click(wrap.firstElementChild!); // →100
    contentResized();
    frame(16);
    const mid = Number.parseFloat(wrap.style.height);
    expect(mid).toBeLessThan(200);
    expect(mid).toBeGreaterThan(100);
    pumpFrames();
    expect(wrap.style.height).toBe('100px');
    view.unmount();
  });

  it('减少动态不接管：height 保持 auto（无内联高度）', () => {
    state.reduced = true;
    const view = render(<Harness />);
    const wrap = view.container.firstElementChild as HTMLElement;
    expect(wrap.style.height).toBe('');
    fireEvent.click(wrap.firstElementChild!);
    contentResized(); pumpFrames();
    expect(wrap.style.height).toBe(''); // 不写高度，维持现状
    state.reduced = false;
    view.unmount();
  });

  it('隐藏时输入条尺寸变化，重新显示应直接采用新高度', () => {
    function Reopening({ active, height }: { active: boolean; height: number }) {
      const wrap = React.useRef<HTMLDivElement>(null);
      const content = React.useRef<HTMLDivElement>(null);
      React.useLayoutEffect(() => {
        Object.defineProperty(content.current!, 'offsetHeight', { configurable: true, value: height });
        Object.defineProperty(content.current!, 'checkVisibility', { configurable: true, value: () => active });
      });
      useSmoothComposerHeight(wrap, active);
      return <div ref={wrap}><div ref={content}>composer</div></div>;
    }
    const view = render(<Reopening active height={100} />);
    const wrap = view.container.firstElementChild as HTMLElement;
    expect(wrap.style.height).toBe('100px');
    view.rerender(<Reopening active={false} height={200} />);
    contentResized(); frame();
    view.rerender(<Reopening active height={200} />);
    expect(wrap.style.height).toBe('200px');
    contentResized(); frame();
    expect(wrap.style.height).toBe('200px');
    view.unmount();
  });
});
