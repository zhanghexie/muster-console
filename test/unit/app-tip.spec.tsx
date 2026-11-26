import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { ErrorTip } from '../../src/renderer/src/components/ErrorTip';
import { dismissTip, getTipSnapshot, showTip } from '../../src/renderer/src/tips';
import { StoreProvider, useChatStore, useUiActionsStore } from '../../src/renderer/src/store';

afterEach(() => { act(() => dismissTip()); vi.useRealTimers(); });

it('expires without taking focus and preserves text throughout the exit animation', () => {
  vi.useFakeTimers();
  render(<><input aria-label="composer" /><AppTipHost /></>);
  screen.getByRole('textbox').focus();
  act(() => showTip('Wait for the current turn', { tone: 'error' }));
  expect(screen.getByRole('status').textContent).toBe('Wait for the current turn');
  expect(document.activeElement).toBe(screen.getByRole('textbox'));
  act(() => vi.advanceTimersByTime(3500));
  expect(document.querySelector('.app-tip')?.getAttribute('aria-hidden')).toBe('true');
  const leaving = document.querySelector('.app-tip');
  expect(leaving?.textContent).toBe('Wait for the current turn');
  expect(leaving?.getAttribute('data-mp-stage')).toBe('out');
  act(() => vi.advanceTimersByTime(500));
  expect(document.querySelector('.app-tip')).toBeNull();
});

it('replaces older tips and restarts the timer even for identical text', () => {
  vi.useFakeTimers();
  render(<AppTipHost />);
  act(() => showTip('First'));
  const firstId = getTipSnapshot()!.id;
  act(() => vi.advanceTimersByTime(3000));
  act(() => showTip('Second'));
  act(() => { dismissTip(firstId); showTip('  '); });
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe('Second');
  act(() => vi.advanceTimersByTime(3000));
  act(() => showTip('Second'));
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole('status').textContent).toBe('Second');
  act(() => vi.advanceTimersByTime(2500));
  expect(document.querySelector('.app-tip')?.getAttribute('aria-hidden')).toBe('true');
});

it('publishes each committed error once to the existing live region', () => {
  const view = render(<><ErrorTip message="" /><AppTipHost /></>);
  const region = screen.getByRole('status');
  view.rerender(<><ErrorTip message="Configuration failed" /><AppTipHost /></>);
  expect(screen.getByRole('status')).toBe(region);
  expect(region.textContent).toBe('Configuration failed');
  act(() => dismissTip());
  view.rerender(<><ErrorTip message="Configuration failed" active={false} /><AppTipHost /></>);
  view.rerender(<><ErrorTip message="Configuration failed" /><AppTipHost /></>);
  expect(getTipSnapshot()).toBeNull();
  view.rerender(<><ErrorTip message="" /><AppTipHost /></>);
  view.rerender(<><ErrorTip message="Configuration failed" /><AppTipHost /></>);
  expect(getTipSnapshot()?.tone).toBe('error');
});

it('flashTip works without a workspace and never changes workspace status bubbles', async () => {
  let bubbles: unknown;
  function Probe() {
    const chat = useChatStore();
    const { flashTip } = useUiActionsStore();
    bubbles = chat.bubblesByWs;
    return <button onClick={() => flashTip('Saved')}>Save</button>;
  }
  await act(async () => { render(<StoreProvider><Probe /><AppTipHost /></StoreProvider>); });
  const before = bubbles;
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('status').textContent).toBe('Saved');
  expect(bubbles).toBe(before);
});

it('announces picker errors inside the active native modal', () => {
  const { rerender } = render(<><dialog open aria-modal="true" aria-label="Picker" /><AppTipHost /></>);
  act(() => showTip('Invalid model ID', { tone: 'error' }));
  expect(screen.getByRole('dialog').contains(screen.getByRole('status'))).toBe(true);
  rerender(<AppTipHost />);
  act(() => showTip('Saved'));
  expect(screen.getByRole('status').textContent).toBe('Saved');
});
