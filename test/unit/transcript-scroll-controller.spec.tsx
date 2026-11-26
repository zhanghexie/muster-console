import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TranscriptScrollController, wheelReachesTranscript } from '../../src/renderer/src/chatSurface/transcriptScrollController';
import { ChatTranscript, resetTranscriptScrollMemoryForTest } from '../../src/renderer/src/chatSurface/ChatTranscript';
import { visibleTranscriptAnchor } from '../../src/renderer/src/chatSurface/transcriptScrollAnchor';
import { useTranscriptScrollController } from '../../src/renderer/src/chatSurface/transcriptScrollController';
import { resetRevealTickerForTest } from '../../src/renderer/src/chatSurface/revealTicker';
import type { ChatMessage } from '../../src/shared/types';

const state = vi.hoisted(() => ({
  prefs: { scrollFeel: 'native' as 'native' | 'crisp' | 'soft', scrollDistance: 1, motion: 'system' as 'system' | 'subtle' | 'reduced' },
  reduced: false,
  listeners: new Set<() => void>(),
  media: new Set<() => void>()
}));
vi.mock('../../src/renderer/src/interactionPreferences', () => ({
  getInteractionPreferences: () => state.prefs,
  prefersReducedMotionPreference: () => state.reduced || state.prefs.motion === 'reduced',
  subscribeInteractionPreferences: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); }
}));
vi.mock('../../src/renderer/src/components/ChatMessageView', () => ({
  ChatMessageView: ({ message }: { message: ChatMessage }) => <div className="chat-text" data-message={message.id}>{message.content}</div>
}));

let now = 0;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
function frame(ms = 16): void {
  now += ms;
  const pending = [...frames.values()]; frames.clear();
  act(() => { for (const fn of pending) fn(now); });
}
/** 弹簧跟随无固定截止时间：泵帧到收敛（ticker 注销任务、frames 清空）或步数上限。
 *  0.01px 级吸附阈值下 2600px 全程约 93 帧（16ms/帧），上限给足余量。 */
function settleFrames(): void {
  for (let i = 0; i < 160 && frames.size > 0; i++) frame(16);
}
function metrics(element: HTMLElement, initial = 800, initialHeight = 2400, client = 400) {
  let top = initial, height = initialHeight;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => client },
    scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(Number(value), height - client)); } }
  });
  return { height: (value: number, clamp = false) => { height = value; if (clamp) top = Math.max(0, Math.min(top, height - client)); } };
}
function harness() {
  const element = document.createElement('div'); document.body.append(element);
  const geometry = metrics(element);
  let active = true;
  const onUserScroll = vi.fn();
  const control = new TranscriptScrollController(() => element, {
    preferences: () => state.prefs, reducedMotion: () => state.reduced || state.prefs.motion === 'reduced',
    active: () => active, onUserScroll
  });
  element.addEventListener('wheel', event => control.wheel(event), { passive: false });
  const wheel = (options: WheelEventInit = {}) => {
    const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, ...options });
    element.dispatchEvent(event); return event;
  };
  return { element, control, geometry, wheel, onUserScroll, hide: () => { active = false; } };
}

beforeEach(() => {
  now = 0; nextFrame = 0; frames.clear();
  state.prefs = { scrollFeel: 'native', scrollDistance: 1, motion: 'system' };
  state.reduced = false; state.listeners.clear(); state.media.clear();
  resetRevealTickerForTest();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: state.reduced,
    addEventListener: (_: string, fn: () => void) => state.media.add(fn),
    removeEventListener: (_: string, fn: () => void) => state.media.delete(fn) }));
  resetTranscriptScrollMemoryForTest();
});
afterEach(() => {
  cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalHitTest) Object.defineProperty(document, 'elementFromPoint', originalHitTest);
  else delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
});

describe('bounded transcript scroll controller', () => {
  it('native is untouched; coarse opt-in scales a detent and finishes without queued frames', () => {
    const h = harness();
    expect(h.wheel().defaultPrevented).toBe(false);
    expect(h.element.scrollTop).toBe(800); expect(frames.size).toBe(0);
    state.prefs = { ...state.prefs, scrollFeel: 'crisp', scrollDistance: 1.5 };
    expect(h.wheel().defaultPrevented).toBe(true);
    expect(h.element.scrollTop).toBe(800);
    frame(20); expect(h.element.scrollTop).toBeGreaterThan(800); expect(h.element.scrollTop).toBeLessThan(980);
    frame(120); expect(h.element.scrollTop).toBe(980); expect(frames.size).toBe(0);
    expect(h.onUserScroll).toHaveBeenCalledWith(120);
  });

  it('line-mode detents work; reversing replaces accumulated travel immediately and bursts stay bounded', () => {
    state.prefs.scrollFeel = 'soft'; const h = harness();
    h.wheel({ deltaY: 3, deltaMode: 1 }); frame(20);
    const before = h.element.scrollTop;
    h.wheel({ deltaY: -3, deltaMode: 1 }); frame(20);
    expect(h.element.scrollTop).toBeLessThan(before);
    for (let i = 0; i < 20; i++) h.wheel({ deltaY: 6, deltaMode: 1 });
    expect(frames.size).toBe(1);
    const start = h.element.scrollTop;
    frame(200); expect(h.element.scrollTop).toBeLessThanOrEqual(start + 400); expect(frames.size).toBe(0);
  });

  it.each([100, 120])('explicit soft mode recognizes a %ipx discrete detent without accepting arbitrary pixel values', magnitude => {
    state.prefs.scrollFeel = 'soft'; const h = harness();
    expect(h.wheel({ deltaY: magnitude }).defaultPrevented).toBe(true);
    frame(200); expect(h.element.scrollTop).toBe(800 + magnitude);
    now += 400; expect(h.wheel({ deltaY: 101 }).defaultPrevented).toBe(false);
  });

  it.each([false, true])('CV settlement preserves the visible paragraph and wheel distance (browser already anchored: %s)', browserAnchored => {
    state.prefs = { ...state.prefs, scrollFeel: 'soft', scrollDistance: 1.5 };
    const h = harness(), geometry = metrics(h.element, 39994, 41440, 921);
    const message = document.createElement('div'), paragraph = document.createElement('p');
    message.dataset.mid = 'large'; message.append(paragraph); h.element.append(message);
    let contentTop = 40002;
    vi.spyOn(h.element, 'getBoundingClientRect').mockReturnValue({ top: 100, left: 0, width: 500, height: 921 } as DOMRect);
    vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 + contentTop - h.element.scrollTop } as DOMRect));
    // The parent remains fixed: settlement occurs among skipped Markdown blocks
    // inside the same message, so anchoring only its wrapper cannot repair it.
    vi.spyOn(message, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 - h.element.scrollTop } as DOMRect));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => paragraph) });
    const before = paragraph.getBoundingClientRect().top;
    expect(h.wheel({ deltaY: -100 }).defaultPrevented).toBe(true); frame(20);
    contentTop -= 968;
    if (browserAnchored) h.element.scrollTop -= 968;
    geometry.height(40472, true); // Chromium also clamps the old top to new max.
    frame(50); frame(130);
    expect(paragraph.getBoundingClientRect().top - before).toBeCloseTo(150, 5);
    expect(h.element.scrollTop).toBeCloseTo(38876, 5);
    expect(h.element.scrollHeight - h.element.clientHeight - h.element.scrollTop).toBeCloseTo(675, 5);
    frame(); frame(); expect(frames.size).toBe(0);
    expect(document.elementFromPoint).toHaveBeenCalledTimes(1);
  });

  it('late local settlement is repaired twice at most; reduced motion finishes relative debt immediately', () => {
    state.prefs = { ...state.prefs, scrollFeel: 'soft', scrollDistance: 1.5 };
    const h = harness(), message = document.createElement('div'), paragraph = document.createElement('p');
    message.dataset.mid = 'body'; message.append(paragraph); h.element.append(message);
    let contentTop = 808;
    vi.spyOn(h.element, 'getBoundingClientRect').mockReturnValue({ top: 100, left: 0, width: 500, height: 400 } as DOMRect);
    vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 + contentTop - h.element.scrollTop } as DOMRect));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => paragraph });
    h.wheel({ deltaY: -100 }); frame(200); expect(h.element.scrollTop).toBe(650);
    contentTop -= 60; frame(); expect(h.element.scrollTop).toBe(590);
    contentTop -= 20; frame(); expect(h.element.scrollTop).toBe(570); expect(frames.size).toBe(0);
    now += 400; h.wheel({ deltaY: -100 }); frame(20);
    contentTop -= 40; state.reduced = true; h.control.preferencesChanged();
    expect(h.element.scrollTop).toBeCloseTo(380, 5); expect(frames.size).toBe(0);
    // User cancellation also removes the small bounded settlement window.
    state.reduced = false; now += 400; h.wheel({ deltaY: 100 }); frame(200); h.control.cancel();
    const stopped = h.element.scrollTop; contentTop -= 50; frame(); expect(h.element.scrollTop).toBe(stopped);
  });

  it('clamps the combined visual destination once when only content below the witness disappears', () => {
    state.prefs = { ...state.prefs, scrollFeel: 'soft', scrollDistance: 1.5 };
    const h = harness(), message = document.createElement('div'), paragraph = document.createElement('p');
    message.dataset.mid = 'body'; message.append(paragraph); h.element.append(message);
    vi.spyOn(h.element, 'getBoundingClientRect').mockReturnValue({ top: 100, left: 0, width: 500, height: 400 } as DOMRect);
    vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => ({ top: 908 - h.element.scrollTop } as DOMRect));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => paragraph });
    h.wheel({ deltaY: -100 }); h.geometry.height(1000, true); expect(h.element.scrollTop).toBe(600);
    frame(200); expect(h.element.scrollTop).toBe(600); // ideal 650 is beyond the physical maximum
    frame(); expect(h.element.scrollTop).toBe(600);
    frame(); expect(h.element.scrollTop).toBe(600); expect(frames.size).toBe(0);
  });

  it('fine, fractional, high-cadence and decaying pixel input remains native and stops synthetic debt', () => {
    state.prefs.scrollFeel = 'soft'; const h = harness();
    expect(h.wheel({ deltaY: 1.25 }).defaultPrevented).toBe(false);
    now += 400; expect(h.wheel().defaultPrevented).toBe(true);
    now += 8; expect(h.wheel().defaultPrevented).toBe(false); expect(frames.size).toBe(0);
    now += 40; expect(h.wheel({ deltaY: 80 }).defaultPrevented).toBe(false);
    now += 40; expect(h.wheel({ deltaY: 40 }).defaultPrevented).toBe(false);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 200 }, { deltaMode: 2 }])('leaves zoom, horizontal and page input to the browser: %o', options => {
    state.prefs.scrollFeel = 'soft'; const h = harness();
    expect(h.wheel(options).defaultPrevented).toBe(false); expect(frames.size).toBe(0);
  });

  it('nested scroll consumption and contained boundaries remain native in both directions', () => {
    state.prefs.scrollFeel = 'soft'; const h = harness();
    const nested = document.createElement('div'); nested.style.overflowY = 'auto'; h.element.append(nested);
    metrics(nested, 100, 1000);
    const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }); nested.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(frames.size).toBe(0);
    expect(wheelReachesTranscript(h.element, nested, 120)).toBe(false);
    nested.scrollTop = 0; nested.style.overscrollBehaviorY = 'contain';
    expect(wheelReachesTranscript(h.element, nested, -120)).toBe(false);
    nested.style.overscrollBehaviorY = 'auto';
    expect(wheelReachesTranscript(h.element, nested, -120)).toBe(true);
    h.element.scrollTop = 0;
    expect(h.wheel({ deltaY: -3, deltaMode: 1 }).defaultPrevented).toBe(false);
  });

  it('long jump limits animated travel to one viewport and replaces older navigation', () => {
    const h = harness(); h.geometry.height(10_000);
    h.control.jumpTo(9000);
    expect(h.element.scrollTop).toBe(8600); expect(frames.size).toBe(1);
    frame(20); expect(h.element.scrollTop).toBeGreaterThan(8600);
    h.control.jumpTo(2000); expect(h.element.scrollTop).toBe(2400);
    frame(200); expect(h.element.scrollTop).toBe(2000); expect(frames.size).toBe(0);
  });

  it('streaming follow is a live-target spring: updates never restart it and it lands at the latest bottom', () => {
    state.prefs.scrollFeel = 'soft'; const h = harness(); h.element.scrollTop = 2000;
    h.geometry.height(2500); h.control.followBottom();
    h.geometry.height(2600); h.control.followBottom(); // 在途弹簧只更新目标，不重启
    h.geometry.height(2700); h.control.followBottom();
    let prev = h.element.scrollTop;
    for (let i = 0; i < 80 && frames.size > 0; i++) {
      frame(16);
      expect(h.element.scrollTop).toBeGreaterThanOrEqual(prev); // 过阻尼：无过冲、无回退
      prev = h.element.scrollTop;
    }
    expect(h.element.scrollTop).toBe(2300); expect(frames.size).toBe(0); // 收敛即停 rAF
    h.geometry.height(2800); state.reduced = true; h.control.followBottom();
    expect(h.element.scrollTop).toBe(2400); expect(frames.size).toBe(0); // 减少动态即时贴底
  });

  it('native feel also follows with the spring instead of hard jumps', () => {
    const h = harness(); h.element.scrollTop = 0; h.geometry.height(3000);
    h.control.followBottom();
    frame(16);
    const early = h.element.scrollTop;
    expect(early).toBeGreaterThan(0); expect(early).toBeLessThan(2600); // 不整段硬跳
    settleFrames();
    expect(h.element.scrollTop).toBe(2600); expect(frames.size).toBe(0);
  });

  it('reducing motion lands at the target; hiding drops animation without hidden writes', () => {
    const h = harness(); h.control.jumpTo(1500); frame(20);
    state.reduced = true; h.control.preferencesChanged();
    expect(h.element.scrollTop).toBe(1500); expect(frames.size).toBe(0);
    state.reduced = false; h.control.jumpTo(1000); const before = h.element.scrollTop;
    h.hide(); frame(20); expect(h.element.scrollTop).toBe(before); expect(frames.size).toBe(0);
  });
});

const messages = [{ id: 'u', role: 'user' as const, content: 'hello' }];
const model = { toDisplay: (message: typeof messages[number]) => message as unknown as ChatMessage };
function transcript() {
  const view = render(<ChatTranscript sessionId="controlled" messages={messages} busy={false} model={model} />);
  const list = view.container.querySelector<HTMLElement>('.chat-list')!; metrics(list, 1600, 2400);
  fireEvent.scroll(list); list.scrollTop = 600; fireEvent.wheel(list, { deltaY: -12.5 }); fireEvent.scroll(list);
  return { view, list };
}
describe('transcript controller integration', () => {
  it('an enhanced 50px up-wheel inside bottom tolerance stays reading after its final async scroll event', () => {
    state.prefs = { scrollFeel: 'soft', scrollDistance: 0.5, motion: 'system' };
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observers.push(callback); } observe() {} disconnect() {} unobserve() {} });
    const view = render(<ChatTranscript sessionId="small-wheel" messages={messages} busy={false} model={model} />);
    const list = view.container.querySelector<HTMLElement>('.chat-list')!, geometry = metrics(list, 2000);
    fireEvent.scroll(list); fireEvent.wheel(list, { deltaY: -100 }); frame(200);
    expect(list.scrollTop).toBe(1950); expect(frames.size).toBe(0);
    fireEvent.scroll(list); // native scroll delivery occurs after the final rAF
    geometry.height(2450);
    act(() => observers.forEach(callback => callback([], {} as ResizeObserver)));
    expect(list.scrollTop).toBe(1950); expect(frames.size).toBe(0);
    view.rerender(<ChatTranscript sessionId="small-wheel" messages={[{ ...messages[0]!, content: 'hello appended' }]} busy={false} model={model} />);
    expect(list.scrollTop).toBe(1950); expect(frames.size).toBe(0);
    fireEvent.wheel(list, { deltaMode: 1, deltaY: 6 }); frame(200); fireEvent.scroll(list);
    expect(list.scrollTop).toBe(2050); // a deliberate down-wheel reaches the actual bottom
    geometry.height(2550); act(() => observers.forEach(callback => callback([], {} as ResizeObserver)));
    settleFrames(); expect(list.scrollTop).toBe(2150); view.unmount();
  });

  it('find and mounted history reveal share bounded cancellable positioning', () => {
    const { view, list } = transcript();
    const message = list.querySelector<HTMLElement>('[data-mid="u"]')!;
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 100, width: 500, height: 400 } as DOMRect);
    vi.spyOn(message, 'getBoundingClientRect').mockImplementation(() => ({ top: 1500 - list.scrollTop, height: 80 } as DOMRect));
    act(() => list.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'u' })));
    frame(200); expect(list.scrollTop).toBe(1392); // 600 + 900 - 100 - 8
    list.scrollTop = 600;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('mark.chat-find-hit') ? { top: 1500 - list.scrollTop, height: 20 } as DOMRect : { top: 100, width: 500, height: 400 } as DOMRect;
    });
    view.rerender(<ChatTranscript sessionId="controlled" messages={messages} busy={false} model={model} findQuery="hello" findActive={{ messageId: 'u', indexInMessage: 0 }} />);
    const queries = vi.spyOn(list, 'querySelector');
    frame(20); frame(20);
    expect(queries).not.toHaveBeenCalled(); // ordinary frames reuse the connected exact hit
    frame(160); expect(list.scrollTop).toBe(1210); // exact mark centered: 600 + 800 - 190
    measure.mockRestore(); view.unmount();
  });

  it('a stable message/index hit still navigates after changing session identity', () => {
    const { view, list } = transcript();
    const hit = { messageId: 'u', indexInMessage: 0 };
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 100, width: 500, height: 400 } as DOMRect);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('mark.chat-find-hit') ? { top: 1500 - list.scrollTop, height: 20 } as DOMRect : { top: 100, width: 500, height: 400 } as DOMRect;
    });
    view.rerender(<ChatTranscript sessionId="controlled" messages={messages} busy={false} model={model} findQuery="hello" findActive={hit} />);
    frame(200); expect(list.scrollTop).toBe(1210);
    list.scrollTop = 300;
    view.rerender(<ChatTranscript sessionId="copy" messages={messages} busy={false} model={model} findQuery="hello" findActive={hit} />);
    expect(list.querySelector('mark.chat-find-hit.is-active')).toBeTruthy();
    frame(200); expect(list.scrollTop).toBe(1210); view.unmount();
  });

  it('an in-flight find jump survives debounced mark replacement and still centers the exact hit', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { view, list } = transcript();
      vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 100, width: 500, height: 400 } as DOMRect);
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return this.matches('mark.chat-find-hit') ? { top: 1500 - list.scrollTop, height: 20 } as DOMRect : { top: 100, width: 500, height: 400 } as DOMRect;
      });
      view.rerender(<ChatTranscript sessionId="controlled" messages={messages} busy={false} model={model} findQuery="hello" findActive={{ messageId: 'u', indexInMessage: 0 }} />);
      const first = list.querySelector('mark.chat-find-hit.is-active'); expect(first).toBeTruthy();
      frame(20);
      act(() => vi.advanceTimersByTime(160)); // repaint(false), replacing mark DOM during the jump
      expect(first!.isConnected).toBe(false);
      expect(list.querySelector('mark.chat-find-hit.is-active')).toBeTruthy();
      frame(180); expect(list.scrollTop).toBe(1210); expect(frames.size).toBe(0);
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it.each(['pointerdown', 'touchstart', 'keydown', 'wheel'])('%s cancels a jump without swallowing native input or restarting following', kind => {
    const { view, list } = transcript();
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' }));
    frame(20); const before = list.scrollTop;
    const event = kind === 'keydown' ? new KeyboardEvent(kind, { key: 'ArrowUp', bubbles: true, cancelable: true }) :
      kind === 'wheel' ? new WheelEvent(kind, { deltaY: 0.5, bubbles: true, cancelable: true }) : new Event(kind, { bubbles: true, cancelable: true });
    act(() => list.dispatchEvent(event)); frame(300);
    expect(event.defaultPrevented).toBe(false); expect(list.scrollTop).toBe(before);
    view.unmount(); expect(frames.size).toBe(0);
  });

  it('hidden activity and unmount remove enhanced handling and cancel all queued work', () => {
    state.prefs.scrollFeel = 'soft'; const { view, list } = transcript();
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' })); frame(20);
    const subscriptions = state.listeners.size;
    view.rerender(<ChatTranscript interactionActive={false} sessionId="controlled" messages={messages} busy={false} model={model} />);
    expect(frames.size).toBe(0); expect(state.listeners.size).toBe(subscriptions - 1); // motion presence stays subscribed
    const event = new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true });
    list.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    view.unmount(); expect(frames.size).toBe(0); expect(state.listeners.size).toBe(0);
  });

  it('hidden snapshots do not write scrollTop; showing a stable snapshot follows once without new messages', () => {
    state.prefs.scrollFeel = 'soft';
    const view = render(<ChatTranscript interactionActive={false} sessionId="hidden" messages={messages} busy={false} model={model} />);
    const list = view.container.querySelector<HTMLElement>('.chat-list')!; metrics(list, 800);
    const newer = [...messages, { id: 'next', role: 'user' as const, content: 'next' }];
    view.rerender(<ChatTranscript interactionActive={false} sessionId="hidden" messages={newer} busy={false} model={model} />);
    expect(list.scrollTop).toBe(800); expect(frames.size).toBe(0);
    view.rerender(<ChatTranscript interactionActive sessionId="hidden" messages={newer} busy={false} model={model} />);
    expect(list.scrollTop).toBe(2000); // Initial positioning is still instant, even in soft mode.
    expect(list.querySelector('.chat-positioning-row')).not.toBeNull();
    expect(frames.size).toBe(1); // Only the bounded initial-layout cleanup, no follow animation.
    frame(); expect(frames.size).toBe(1); expect(list.scrollTop).toBe(2000);
    frame(); expect(frames.size).toBe(0); expect(list.scrollTop).toBe(2000);
    expect(list.querySelector('.chat-positioning-row')).toBeNull();
    view.unmount();
  });

  it('live system/user reduced motion finishes a jump immediately at its correct target', () => {
    const { view, list } = transcript();
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' })); frame(20);
    // The preferences subscription also reports OS matchMedia changes.
    act(() => { state.reduced = true; for (const fn of state.listeners) fn(); });
    expect(list.scrollTop).toBe(2000); expect(frames.size).toBe(0);
    state.reduced = false; list.scrollTop = 600; fireEvent.wheel(list, { deltaY: -1 }); fireEvent.scroll(list);
    fireEvent.click(screen.getByRole('button', { name: '滚动到底部' })); frame(20);
    act(() => { state.prefs.motion = 'reduced'; for (const fn of state.listeners) fn(); });
    expect(list.scrollTop).toBe(2000); expect(frames.size).toBe(0); view.unmount();
  });
});

describe('real scroll hook input ownership', () => {
  function Pane({ id, ready, onUserScroll, onAction }: { id: string; ready: (controller: TranscriptScrollController) => void; onUserScroll: (delta: number) => void; onAction?: () => void }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const controller = useTranscriptScrollController(ref, true, { onWrite: () => {}, onUserScroll, onUserInput: () => {} });
    React.useLayoutEffect(() => ready(controller), [controller, ready]);
    return <section><div ref={ref} data-hook-pane={id} tabIndex={0}>
      <span data-body={id}>body</span><input data-inline={id} /><div contentEditable suppressContentEditableWarning data-editable={id}>edit</div><button data-action={id} onClick={onAction}>action</button>
    </div><textarea data-composer={id} /><select data-select={id}><option>option</option></select></section>;
  }
  it('composer spaces, editable selection, IME and the other pane never cancel this pane following', () => {
    state.prefs.scrollFeel = 'soft'; let a!: TranscriptScrollController, b!: TranscriptScrollController;
    const onA = vi.fn(), onB = vi.fn();
    const view = render(<><Pane id="a" ready={value => { a = value; }} onUserScroll={onA} /><Pane id="b" ready={value => { b = value; }} onUserScroll={onB} /></>);
    const elA = view.container.querySelector<HTMLElement>('[data-hook-pane="a"]')!, elB = view.container.querySelector<HTMLElement>('[data-hook-pane="b"]')!;
    metrics(elA, 1900); metrics(elB, 1900); a.followBottom(); b.followBottom(); frame(20);
    for (const selector of ['[data-composer="a"]', '[data-inline="a"]', '[data-editable="a"]', '[data-select="a"]']) {
      for (const key of [' ', 'ArrowUp', 'Home']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        view.container.querySelector(selector)!.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
      }
    }
    elA.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', isComposing: true, bubbles: true }));
    expect(a.isAnimating()).toBe(true); expect(b.isAnimating()).toBe(true); expect(onA).not.toHaveBeenCalled(); expect(onB).not.toHaveBeenCalled();
    const handled = (event: KeyboardEvent) => event.preventDefault(); elA.addEventListener('keydown', handled);
    elA.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }));
    expect(onA).not.toHaveBeenCalled(); expect(a.isAnimating()).toBe(true); elA.removeEventListener('keydown', handled);
    elB.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(b.isAnimating()).toBe(false); expect(onB).toHaveBeenCalledWith(-1);
    expect(a.isAnimating()).toBe(true); expect(onA).not.toHaveBeenCalled(); view.unmount();
  });

  it('Space still activates an in-transcript button and never revokes following', async () => {
    state.prefs.scrollFeel = 'soft'; let control!: TranscriptScrollController; const onUserScroll = vi.fn(), onAction = vi.fn();
    const view = render(<Pane id="button" ready={value => { control = value; }} onUserScroll={onUserScroll} onAction={onAction} />);
    const el = view.container.querySelector<HTMLElement>('[data-hook-pane="button"]')!; metrics(el, 1900); control.followBottom(); frame(20);
    const button = view.container.querySelector<HTMLButtonElement>('[data-action="button"]')!; button.focus();
    await userEvent.setup().keyboard(' ');
    expect(onAction).toHaveBeenCalledTimes(1); expect(onUserScroll).not.toHaveBeenCalled();
    control.followBottom(); settleFrames(); expect(el.scrollTop).toBe(2000); view.unmount();
  });

  it('pointer selection cancels only animation; a real drag scroll owns following, and pointerup clears the gesture', () => {
    state.prefs.scrollFeel = 'soft'; let control!: TranscriptScrollController; const onUserScroll = vi.fn();
    const view = render(<Pane id="p" ready={value => { control = value; }} onUserScroll={onUserScroll} />);
    const el = view.container.querySelector<HTMLElement>('[data-hook-pane="p"]')!; metrics(el, 1900);
    control.followBottom(); frame(20); fireEvent.pointerDown(el);
    expect(control.isAnimating()).toBe(false); expect(onUserScroll).not.toHaveBeenCalled();
    control.followBottom(); frame(20); fireEvent.scroll(el); // a controller write is not manual movement
    expect(onUserScroll).not.toHaveBeenCalled();
    fireEvent.pointerUp(document.body); el.scrollTop -= 10; fireEvent.scroll(el);
    expect(onUserScroll).not.toHaveBeenCalled(); // later layout/native anchor scroll is not the old gesture
    fireEvent.pointerDown(el); el.scrollTop -= 30; fireEvent.scroll(el);
    expect(onUserScroll).toHaveBeenCalledTimes(1); expect(onUserScroll).toHaveBeenCalledWith(-1);
    view.unmount();
  });
});

describe('bounded visible anchor capture', () => {
  it('wide centered reading columns are sampled inside their content rather than the empty gutter', () => {
    const root = document.createElement('div'), row = document.createElement('div'); row.dataset.mid = 'wide'; root.append(row); document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 100, width: 1600, height: 800 } as DOMRect);
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: 80 } as DOMRect);
    const point = vi.fn((x: number) => x >= 420 && x <= 1180 ? row : root); // actual 760px column, margin:auto
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: point });
    expect(visibleTranscriptAnchor(root)).toEqual({ node: row, offset: 20 });
    expect(point).toHaveBeenCalledWith(800, 108);
  });
  it('hit-tests at most three points without walking or measuring skipped message rows', () => {
    const root = document.createElement('div'), row = document.createElement('div'); row.dataset.mid = 'visible'; root.append(row); document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ top: 100, left: 10, width: 500, height: 400 } as DOMRect);
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: 70 } as DOMRect);
    const point = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValueOnce(row);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: point });
    const scan = vi.spyOn(root, 'querySelectorAll');
    expect(visibleTranscriptAnchor(root)).toEqual({ node: row, offset: 30 });
    expect(point).toHaveBeenCalledTimes(3); expect(scan).not.toHaveBeenCalled();
  });

  function prepend() {
    const history = Array.from({ length: 600 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, content: `c${i}` }));
    const view = render(<ChatTranscript sessionId="anchor" messages={history} busy={false} model={model} />);
    const list = view.container.querySelector<HTMLElement>('.chat-list')!;
    let top = 2000, drift = 0;
    const count = () => list.querySelectorAll('[data-mid]').length;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, get: () => count() * 100 },
      clientHeight: { configurable: true, get: () => 400 },
      scrollTop: { configurable: true, get: () => top, set: value => { top = Number(value); } }
    });
    const row = list.querySelector<HTMLElement>('[data-mid="m500"]')!;
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 100, left: 0, width: 500, height: 400 } as DOMRect);
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 + 2000 + (count() - 120) * 100 + drift - top } as DOMRect));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => row });
    fireEvent.wheel(list, { deltaY: -1 }); fireEvent.scroll(list);
    fireEvent.click(view.container.querySelector('.chat-clip-more-btn')!);
    return { view, list, history, drift: (value: number) => { drift = value; } };
  }

  it('prepend preserves a visible anchor and corrects content-visibility settlement for only two frames', () => {
    const h = prepend(); expect(h.list.scrollTop).toBe(26000);
    h.drift(64); frame(); expect(h.list.scrollTop).toBe(26064);
    h.drift(20); frame(); expect(h.list.scrollTop).toBe(26020);
    h.drift(90); frame(); expect(h.list.scrollTop).toBe(26020); // bounded, no permanent anchoring loop
    h.view.unmount();
  });

  it.each(['wheel', 'navigation', 'session'])('new %s owns the view and invalidates pending anchor corrections', kind => {
    const h = prepend(); h.drift(64);
    if (kind === 'wheel') {
      fireEvent.wheel(h.list, { deltaY: -1 }); h.list.scrollTop = 25000;
    } else if (kind === 'navigation') {
      act(() => h.list.dispatchEvent(new CustomEvent('chat-clip:reveal', { detail: 'm590' })));
    } else {
      h.view.rerender(<ChatTranscript sessionId="new-anchor" messages={h.history} busy={false} model={model} />);
    }
    const owned = h.list.scrollTop; frame(300); frame(300);
    if (kind === 'wheel' || kind === 'session') expect(h.list.scrollTop).toBe(owned);
    else expect(h.list.scrollTop).not.toBe(26064);
    h.view.unmount();
  });
});
