import React from 'react';
import { act, render } from '@testing-library/react';
import { SessionsFloatSurface } from '../../src/renderer/src/components/SessionsFloatSurface';
import { MOTION } from '../../src/renderer/src/components/motion';

describe('retained sidebar under a transparent frame', () => {
  afterEach(() => vi.useRealTimers());
  it('preserves its child through closing, then stops painting after the covering slide', () => {
    vi.useFakeTimers();
    const ui = (open: boolean) => <SessionsFloatSurface open={open} hidden={false}><input defaultValue="保留草稿" /></SessionsFloatSurface>;
    const { container, rerender } = render(ui(false));
    const sidebar = container.firstElementChild!, input = container.querySelector('input')!;
    expect(sidebar.classList.contains('is-retained')).toBe(false);
    rerender(ui(true));
    expect(sidebar.classList.contains('is-open')).toBe(true);
    expect(sidebar.classList.contains('is-retained')).toBe(true);
    rerender(ui(false));
    expect(sidebar.classList.contains('is-open')).toBe(false);
    expect(sidebar.classList.contains('is-retained')).toBe(true);
    act(() => vi.advanceTimersByTime(MOTION.exitMs + 80));
    expect(sidebar.classList.contains('is-retained')).toBe(false);
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('保留草稿');
  });
  it('cancels hiding on rapid reopening and supports workspace-transit hiding', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<SessionsFloatSurface open hidden={false}>会话</SessionsFloatSurface>);
    rerender(<SessionsFloatSurface open={false} hidden={false}>会话</SessionsFloatSurface>);
    act(() => vi.advanceTimersByTime(MOTION.exitMs / 2));
    rerender(<SessionsFloatSurface open hidden>会话</SessionsFloatSurface>);
    act(() => vi.advanceTimersByTime(MOTION.exitMs + 80));
    expect(container.firstElementChild!.className).toContain('is-retained');
    expect(container.firstElementChild!.className).toContain('is-hidden');
    rerender(<SessionsFloatSurface open hidden={false}>会话</SessionsFloatSurface>);
    expect(container.firstElementChild!.className).not.toContain('is-hidden');
  });
});
