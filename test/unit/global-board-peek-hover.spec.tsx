/** 探出态整条点击/键盘展开，不再右缘专用按钮或文字跳会话。 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { SessionMeta } from '../../src/shared/types';
import { GlobalBoard } from '../../src/renderer/src/panels/GlobalBoard';
import { MOTION } from '../../src/renderer/src/components/motion';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';

const state = vi.hoisted(() => ({ sessions: [] as SessionMeta[] }));
vi.mock('../../src/renderer/src/store', () => ({ useSessionStore: () => state }));
vi.mock('../../src/renderer/src/panels/BoardPanel', () => ({
  BoardPanel: () => <div>看板内容</div>
}));

const session = (needs: boolean): SessionMeta => ({
  id: 'hover-session', type: 'terminal', name: '悬停验收', createdAt: 1, lastUsedAt: 1,
  launchKind: 'agent', runtime: 'cursor', workspaceId: 'ws-a', status: 'running', lifecycle: 'idle',
  ...(needs ? { phase: { value: 'needs_you' as const, source: 'model' as const, ts: 1 } } : {})
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.useFakeTimers(); state.sessions = [session(false)];
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('关闭看板且没有新广播，90 秒无信号边沿仍会探出', () => {
  state.sessions = [{ ...session(false), createdAt: Date.now(), lifecycle: 'starting', status: 'starting' }];
  const view = render(<GlobalBoard open={false} onOpen={() => {}} onClose={() => {}} />);
  expect(view.container.querySelector('.g-board-peek-trigger')).toBeNull();
  act(() => vi.advanceTimersByTime(95_001));
  expect(view.container.querySelector('.g-board-peek-trigger')).toBeTruthy();
});

it('只有子代理进入需要你时，不触发全局看板探出', () => {
  state.sessions = [{ ...session(false), parentSessionId: 'parent' }];
  const props = { open: false, onOpen: () => {}, onClose: () => {} };
  const view = render(<GlobalBoard {...props} />);
  state.sessions = [{ ...session(true), parentSessionId: 'parent' }];
  view.rerender(<GlobalBoard {...props} />);
  act(() => vi.advanceTimersByTime(1_000));
  expect(view.container.querySelector('.g-board-peek-trigger')).toBeNull();
});

it('展开看板时挂磨砂，收回通知条时让已有磨砂淡出，重开可反转', () => {
  const { container, rerender, onOpen, onClose } = peek();
  const root = container.querySelector('.g-board-overlay')!;
  const backdrop = () => root.querySelector<HTMLElement>(':scope > .backdrop-blur-overlay.mp-scrim');
  expect(backdrop()).toBeNull();
  rerender(<GlobalBoard open onOpen={onOpen} onClose={onClose} />);
  const scrim = backdrop();
  expect(scrim?.dataset.mpStage).toBe('in');
  rerender(<GlobalBoard open={false} onOpen={onOpen} onClose={onClose} />);
  expect(root.querySelector('.g-board-peek-trigger')).toBeTruthy();
  expect(backdrop()).toBe(scrim);
  expect(scrim?.dataset.mpStage).toBe('out');
  rerender(<GlobalBoard open onOpen={onOpen} onClose={onClose} />);
  expect(backdrop()).toBe(scrim);
  expect(scrim?.dataset.mpStage).toBe('in');

  rerender(<GlobalBoard open={false} onOpen={onOpen} onClose={onClose} />);
  act(() => vi.advanceTimersByTime(MOTION.exitMs + 81));
  expect(backdrop()).toBeNull();
  expect(root.querySelector('.g-board-peek-trigger')).toBeTruthy();
});

it('开合可中途反向，退出不依赖 animationend', () => {
  const props = { onOpen: () => {}, onClose: () => {} };
  const view = render(<GlobalBoard {...props} open />);
  view.rerender(<GlobalBoard {...props} open={false} />);
  expect(view.container.querySelector('.g-board-content')?.hasAttribute('inert')).toBe(true);
  act(() => vi.advanceTimersByTime(80));
  view.rerender(<GlobalBoard {...props} open />);
  act(() => vi.advanceTimersByTime(500));
  expect(view.container.querySelector('.g-board-sheet.is-open')).toBeTruthy();
  view.rerender(<GlobalBoard {...props} open={false} />);
  act(() => vi.advanceTimersByTime(500));
  expect(view.container.querySelector('.g-board-overlay')?.hasAttribute('hidden')).toBe(true);
  expect(view.container.querySelector('.g-board-overlay')?.hasAttribute('inert')).toBe(true);
  expect(view.container.querySelector('.g-board-content')?.textContent).toBe('');
});

function peek() {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const view = render(<GlobalBoard open={false} onOpen={onOpen} onClose={onClose} />);
  state.sessions = [session(true)];
  view.rerender(<GlobalBoard open={false} onOpen={onOpen} onClose={onClose} />);
  return { ...view, onOpen, onClose };
}

it.each([[151, 20], [600, 25], [1049, 39], [600, 450], [600, 0]])(
  '探出态指针悬停 (%i, %i) 不再自动展开（悬停唤出已下线）',
  (x, y) => {
    const { onOpen } = peek();
    fireEvent.pointerMove(document.body, { clientX: x, clientY: y });
    act(() => vi.advanceTimersByTime(5_000));
    expect(onOpen).not.toHaveBeenCalled();
  }
);

it('整条探出区域统一展开，没有右缘箭头；隐藏内容不再可聚焦', () => {
  const { container, onOpen } = peek();
  const btn = container.querySelector<HTMLButtonElement>('.g-board-peek-trigger')!;
  expect(btn).toBeTruthy();
  expect(btn.tagName).toBe('BUTTON');
  expect(btn.getAttribute('aria-label')).toContain('悬停验收');
  expect(btn.querySelector('svg')).toBeNull();
  expect(container.querySelector('.g-board-peek-expand')).toBeNull();
  expect(container.querySelector('.g-board-content')?.hasAttribute('inert')).toBe(true);
  fireEvent.click(btn);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('整条入口支持 Enter 和 Space，展开后内容恢复交互', async () => {
  vi.useRealTimers();
  const user = userEvent.setup();
  const view = peek();
  const btn = view.container.querySelector<HTMLButtonElement>('.g-board-peek-trigger')!;
  expect(btn).toBeTruthy();
  btn.focus();
  await user.keyboard('{Enter} ');
  expect(view.onOpen).toHaveBeenCalledTimes(2);
  view.rerender(<GlobalBoard open onOpen={view.onOpen} onClose={view.onClose} />);
  expect(view.container.querySelector('.g-board-peek-trigger')).toBeNull();
  expect(view.container.querySelector('.g-board-content')?.hasAttribute('inert')).toBe(false);
});

it('探出态入口只认本帧：已读清空后入口随探条收回', () => {
  const view = peek();
  expect(view.container.querySelector('.g-board-peek-trigger')).toBeTruthy();
  state.sessions = [session(false)];
  view.rerender(<GlobalBoard open={false} onOpen={view.onOpen} onClose={view.onClose} />);
  act(() => vi.advanceTimersByTime(600));
  expect(view.container.querySelector('.g-board-peek-trigger')).toBeNull();
  expect(view.onOpen).not.toHaveBeenCalled();
});

it('新提醒启用真实 Beam，展开或提醒清空立即停止装饰，容器保持挂载', () => {
  const view = peek();
  expect(view.container.querySelector('.g-board-peek-beam[data-board-beam-active]')).toBeTruthy();
  expect(view.container.querySelector('.g-board-peek-beam')?.getAttribute('aria-hidden')).toBe('true');
  view.rerender(<GlobalBoard open onOpen={view.onOpen} onClose={view.onClose} />);
  expect(view.container.querySelector('[data-board-beam-active]')).toBeNull();
  expect(view.container.querySelector('[data-beam]')?.getAttribute('style')).toContain('--beam-strength: 0');
  view.rerender(<GlobalBoard open={false} onOpen={view.onOpen} onClose={view.onClose} />);
  expect(view.container.querySelector('[data-board-beam-active]')).toBeTruthy();
  state.sessions = [session(false)];
  view.rerender(<GlobalBoard open={false} onOpen={view.onOpen} onClose={view.onClose} />);
  expect(view.container.querySelector('[data-board-beam-active]')).toBeNull();
});

it('光效直接包住整张面板内容，展开与收起保持同一容器和内容节点', () => {
  const view = peek();
  const beam = view.container.querySelector('.g-board-content[data-beam]');
  expect(beam).toBeTruthy();
  const content = beam!.firstElementChild;
  expect(content?.textContent).toBe('看板内容');
  expect(beam?.querySelector('.g-board-peek-beam-surface')).toBeNull();
  view.rerender(<GlobalBoard open onOpen={view.onOpen} onClose={view.onClose} />);
  expect(view.container.querySelector('.g-board-content[data-beam]')).toBe(beam);
  expect(beam!.firstElementChild).toBe(content);
  view.rerender(<GlobalBoard open={false} onOpen={view.onOpen} onClose={view.onClose} />);
  expect(view.container.querySelector('.g-board-content[data-beam]')).toBe(beam);
  expect(beam!.firstElementChild).toBe(content);
});

it('提醒中的 Beam 跟随应用主题切换，不取操作系统深浅主题', () => {
  act(() => applyTheme(builtinTheme('light')!));
  const view = peek();
  const beamStyle = () => view.container.querySelector('.g-board-peek-beam')!.previousElementSibling!.textContent;
  const lightStyle = beamStyle();
  expect(lightStyle).toContain('beam-travel-');
  act(() => applyTheme(builtinTheme('dark')!));
  expect(beamStyle()).not.toBe(lightStyle);
  expect(view.container.querySelector('.g-board-peek-beam')?.getAttribute('style')).toContain('--beam-strength: 1');
});
