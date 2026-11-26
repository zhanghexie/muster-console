import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvelopeSendStudy, envelopeDuration, envelopePlaybackRate, envelopeTiming } from '../../docs/prototypes/envelope-send/envelope-send';
import { MOTION } from '../../src/renderer/src/components/motion';
import { setInteractionPreferences } from '../../src/renderer/src/interactionPreferences';

describe('continuous page-to-envelope animation preview', () => {
  beforeEach(() => { vi.useFakeTimers(); setInteractionPreferences({ motion: 'system' }); });
  afterEach(() => { vi.useRealTimers(); act(() => setInteractionPreferences({ motion: 'system' })); });
  const root = () => document.getElementById('envelope-send-study')!;
  const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const normalDuration = envelopeDuration / envelopePlaybackRate;

  it('slows normal playback slightly while keeping the native and progress clocks aligned', () => {
    render(<EnvelopeSendStudy/>);
    fireEvent.click(screen.getByRole('button', {name:'寄出这页'}));
    tick(envelopeDuration + 20);
    expect(root().dataset.phase).toBe('sending');
    tick(normalDuration - envelopeDuration + 40);
    expect(root().dataset.phase).toBe('sent');
  });

  it('overlaps folding, inserting, closing and ascent instead of stopping after each action', () => {
    const t = envelopeTiming;
    expect(t.bottom).toEqual(t.top);
    expect(t.flight.delay).toBeGreaterThan(t.insert.delay);
    expect(t.flight.delay).toBeLessThan(t.insert.delay + t.insert.duration);
    expect(t.lid.delay).toBeGreaterThan(t.flight.delay);
    expect(t.lid.delay).toBeLessThan(t.insert.delay + t.insert.duration);
    expect(t.lid.delay + t.lid.duration).toBeLessThan(envelopeDuration);
    expect(envelopeDuration).toBeLessThan(MOTION.breathMs);
  });
  it('keeps the page ahead of the fixed pocket until folding clears the mouth', () => {
    render(<EnvelopeSendStudy/>);
    fireEvent.change(screen.getByRole('slider'), {target:{value:'140'}});
    expect(root().dataset.paperLayer).toBe('front');
    fireEvent.change(screen.getByRole('slider'), {target:{value:String(Math.ceil(MOTION.panelMs / envelopeDuration * 1000))}});
    expect(root().dataset.paperLayer).toBe('front');
    fireEvent.change(screen.getByRole('slider'), {target:{value:String(Math.ceil(envelopeTiming.top.duration / envelopeDuration * 1000))}});
    expect(root().dataset.paperLayer).toBe('inside');
    fireEvent.change(screen.getByRole('slider'), {target:{value:'140'}});
    expect(root().dataset.paperLayer).toBe('front');
  });
  it('keeps the envelope separate from the page, finishes on one clock, and replays', () => {
    render(<EnvelopeSendStudy/>);
    expect(document.querySelector('.es-paper .es-envelope-rear')).toBeNull();
    expect(document.querySelector('.es-envelope-rear')).not.toBeNull();
    expect(document.querySelectorAll('.es-letter-content')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', {name: '寄出这页'}));
    expect(root().dataset.playing).toBe('true');
    tick(normalDuration / 2);
    expect(root().dataset.phase).toBe('sending');
    tick(normalDuration / 2 + 30);
    expect(root().dataset.phase).toBe('sent');
    tick(MOTION.microMs + 100);
    expect(document.querySelector('.es-presence')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: '再寄一次'}));
    expect(root().dataset.phase).toBe('sending');
    expect(document.querySelector('.es-presence')).not.toBeNull();
  });
  it('preserves elapsed time while paused and cancels playback on reset', () => {
    render(<EnvelopeSendStudy/>);
    fireEvent.click(screen.getByRole('button', {name: '寄出这页'}));
    tick(200);
    fireEvent.click(screen.getByRole('button', {name: '暂停'}));
    const progress = (screen.getByRole('slider') as HTMLInputElement).value;
    tick(5000);
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe(progress);
    fireEvent.click(screen.getByRole('button', {name: '继续'}));
    tick(100);
    expect(Number((screen.getByRole('slider') as HTMLInputElement).value)).toBeGreaterThan(Number(progress));
    fireEvent.click(screen.getByRole('button', {name: '还原'}));
    tick(5000);
    expect(root().dataset.phase).toBe('ready');
    expect(root().dataset.playing).toBe('false');
  });
  it('slows the shared clock and prevents duplicate sends', () => {
    render(<EnvelopeSendStudy/>);
    fireEvent.click(screen.getByLabelText('慢放'));
    fireEvent.click(screen.getByRole('button', {name: '寄出这页'}));
    tick(normalDuration);
    expect(root().dataset.phase).toBe('sending');
    expect(Number((screen.getByRole('slider') as HTMLInputElement).value)).toBeLessThan(400);
    expect(screen.getByRole('button', {name: '寄出这页'}).hasAttribute('disabled')).toBe(true);
    tick(normalDuration * 2 + 40);
    expect(root().dataset.phase).toBe('sent');
  });
  it('seeks to an exact shared time and remains paused until resumed', () => {
    render(<EnvelopeSendStudy/>);
    fireEvent.change(screen.getByRole('slider'), {target:{value:'500'}});
    expect(root().dataset.phase).toBe('sending');
    expect(root().dataset.paused).toBe('true');
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('500');
    tick(1000);
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('500');
    fireEvent.click(screen.getByRole('button', {name:'继续'}));
    tick(normalDuration / 2 + 40);
    expect(root().dataset.phase).toBe('sent');
  });
  it('finishes immediately on a live reduced-motion change', () => {
    render(<EnvelopeSendStudy/>);
    fireEvent.click(screen.getByRole('button', {name: '寄出这页'}));
    tick(200);
    act(() => setInteractionPreferences({motion: 'reduced'}));
    expect(root().dataset.phase).toBe('sent');
    expect(document.querySelector('.es-presence')).toBeNull();
    expect(screen.getByRole('slider').hasAttribute('disabled')).toBe(true);
  });
  it('cancels its frame clock when unmounted', () => {
    const view = render(<EnvelopeSendStudy/>);
    fireEvent.click(screen.getByRole('button', {name: '寄出这页'}));
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
