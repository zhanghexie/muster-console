/** Keep the real library stylesheet stable while preserving BoardPanel's complete-close reset. */
import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GlobalBoard } from '../../src/renderer/src/panels/GlobalBoard';
import { MOTION } from '../../src/renderer/src/components/motion';

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('../../src/renderer/src/store', () => ({ useSessionStore: () => ({ sessions: [] }) }));
vi.mock('../../src/renderer/src/panels/BoardPanel', () => ({
  BoardPanel: function StatefulBoard() {
    const [count, setCount] = useState(0);
    useEffect(() => { lifecycle.mounts++; return () => { lifecycle.unmounts++; }; }, []);
    return <button type="button" onClick={() => setCount(value => value + 1)}>业务草稿 {count}</button>;
  }
}));

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.useFakeTimers(); lifecycle.mounts = 0; lifecycle.unmounts = 0;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const props = { onOpen: () => {}, onClose: () => {} };
const finishExit = () => act(() => { vi.advanceTimersByTime(MOTION.exitMs + 81); });

it('不启动预挂，首次展示后保留同一真实 Beam/style，完全关闭销毁业务状态，重开重新初始化', () => {
  const view = render(<GlobalBoard {...props} open={false} />);
  expect(view.container.querySelector('[data-beam]')).toBeNull();
  expect(view.container.querySelector('style')).toBeNull();
  expect(lifecycle.mounts).toBe(0);
  view.rerender(<GlobalBoard {...props} open />);
  const root = view.container.querySelector<HTMLElement>('.g-board-overlay')!;
  const beam = view.container.querySelector<HTMLElement>('[data-beam]')!;
  const style = beam.previousElementSibling!;
  expect(style.tagName).toBe('STYLE');
  expect(style.textContent).toContain('@property --beam-x-');
  fireEvent.click(screen.getByRole('button', { name: '业务草稿 0' }));
  expect(screen.getByRole('button', { name: '业务草稿 1' })).toBeTruthy();
  view.rerender(<GlobalBoard {...props} open={false} />);
  expect(root.dataset.mpStage).toBe('out');
  expect(lifecycle.unmounts).toBe(0);
  finishExit();
  expect(root.hidden).toBe(true);
  expect(root.hasAttribute('inert')).toBe(true);
  expect(root.getAttribute('aria-hidden')).toBe('true');
  expect(beam.getAttribute('aria-hidden')).toBe('true');
  expect(beam.style.getPropertyValue('--beam-strength')).toBe('0');
  expect(beam.hasAttribute('data-board-beam-active')).toBe(false);
  expect(beam.querySelector('button')).toBeNull();
  expect(beam.querySelector('.board-utility-panel')).toBeNull();
  expect(lifecycle.unmounts).toBe(1);
  expect(view.container.querySelector('[data-beam]')).toBe(beam);
  expect(beam.previousElementSibling).toBe(style);
  view.rerender(<GlobalBoard {...props} open />);
  expect(root.hidden).toBe(false);
  expect(root.hasAttribute('inert')).toBe(false);
  expect(root.hasAttribute('aria-hidden')).toBe(false);
  expect(view.container.querySelector('[data-beam]')).toBe(beam);
  expect(beam.previousElementSibling).toBe(style);
  expect(screen.getByRole('button', { name: '业务草稿 0' })).toBeTruthy();
  expect(lifecycle.mounts).toBe(2);
});

it('out 中途重开保持原业务实例与状态，之后完全关闭才销毁', () => {
  const view = render(<GlobalBoard {...props} open />);
  const root = view.container.querySelector<HTMLElement>('.g-board-overlay')!;
  const button = screen.getByRole('button', { name: '业务草稿 0' });
  fireEvent.click(button);
  view.rerender(<GlobalBoard {...props} open={false} />);
  act(() => vi.advanceTimersByTime(80));
  view.rerender(<GlobalBoard {...props} open />);
  finishExit();
  expect(root.hidden).toBe(false);
  expect(root.dataset.mpStage).toBe('in');
  expect(screen.getByRole('button', { name: '业务草稿 1' })).toBe(button);
  expect(lifecycle.mounts).toBe(1);
  expect(lifecycle.unmounts).toBe(0);
  view.rerender(<GlobalBoard {...props} open={false} />); finishExit();
  expect(lifecycle.unmounts).toBe(1);
});
