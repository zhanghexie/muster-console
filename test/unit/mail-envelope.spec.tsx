import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailEnvelopeViewport } from '../../src/renderer/src/components/MailEnvelopeViewport';
import { envelopeDuration, envelopePlaybackRate, envelopeTiming } from '../../src/renderer/src/components/envelope/EnvelopePaper';
import { envelopeTiming as studyTiming } from '../../docs/prototypes/envelope-send/envelope-send';
import { emptyMailEnvelopeState, mailEnvelopeReducer, MAIL_READ_MS, MAIL_STACK_MAX } from '../../src/renderer/src/components/envelope/mailEnvelopeQueue';
import { MOTION } from '../../src/renderer/src/components/motion';
import { setInteractionPreferences } from '../../src/renderer/src/interactionPreferences';
import { MAIL_COLLECT_MS, MAIL_SEND_PREVIEW_MS, type MailActivity } from '../../src/shared/mailActivity';
import { currentApiMock } from './helpers/api-mock';

const letter = (id = 'one', extra: Partial<MailActivity> = {}): MailActivity => ({
  id, mailboxWorkspaceId: 'ws', from: 'a', to: 'b', fromName: '设计师', toName: '工程师',
  subject: '按钮布局检查', text: '已完成布局核对，正在继续协作。\n无需用户回复。', totalChars: 30, ts: Date.now(), ...extra
});
const emit = (value = letter()) => act(() => currentApiMock().emit('messages:activity', value));
const offer = (value = letter()) => {
  const registration = currentApiMock().mockOf('mailPresentation.setViewport').mock.calls
    .filter(([, id, active]) => id === value.from && active).at(-1);
  act(() => currentApiMock().emit('messages:departure', {
    requestId: `departure-${value.id}`, viewportId: registration?.[0] ?? 'sender', letter: value
  }));
};
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const scene = () => document.querySelector<HTMLElement>('.mail-envelope-scene');
const animationMs = envelopeDuration / envelopePlaybackRate;
const flightAt = envelopeTiming.flight.delay / envelopePlaybackRate;
type Track = { currentTime: number; playbackRate: number; pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
let tracks: Track[];
let previousAnimations: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers(); setInteractionPreferences({ motion: 'system' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  currentApiMock().override('mailPresentation.depart', async () => ({ ok: true }));
  tracks = [];
  const byElement = new WeakMap<Element, Track>();
  previousAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: function (this: Element) {
    const existing = byElement.get(this);
    if (existing) return [existing] as unknown as Animation[];
    // Native play() auto-rewinds negative-rate short tracks to their own end.
    const track = { currentTime: 0, playbackRate: 1, pause: vi.fn(), play: vi.fn(() => {
      if (track.playbackRate < 0) track.currentTime = envelopeTiming.top.duration;
    }), cancel: vi.fn() };
    byElement.set(this, track);
    tracks.push(track); return [track] as unknown as Animation[];
  } });
});
afterEach(() => {
  act(() => setInteractionPreferences({ motion: 'system' }));
  vi.restoreAllMocks();
  if (previousAnimations) Object.defineProperty(Element.prototype, 'getAnimations', previousAnimations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.useRealTimers();
});

describe('前台会话的信纸收发展示', () => {
  it('starts folding after one second and requests the durable send at the flight boundary', async () => {
    expect(envelopeTiming).toBe(studyTiming);
    let stored!: (result: { ok: true }) => void;
    currentApiMock().override('mailPresentation.depart', () => new Promise<{ ok: true }>(resolve => { stored = resolve; }));
    render(<MailEnvelopeViewport mailboxId="a" />);
    offer();
    expect(screen.getByRole('status').textContent).toContain('寄信给 工程师');
    expect(document.querySelector('.mail-letter-body')?.textContent).toContain('无需用户回复');
    expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('button')).toBeNull();
    tick(MAIL_SEND_PREVIEW_MS - 1); expect(scene()?.dataset.phase).toBe('preview');
    tick(2); expect(scene()?.dataset.phase).toBe('motion');
    expect(tracks).toHaveLength(1); expect(tracks[0]!.playbackRate).toBe(envelopePlaybackRate);
    const departure = currentApiMock().mockOf('mailPresentation.depart');
    tick(flightAt - 100); expect(departure).not.toHaveBeenCalled();
    tick(150); expect(departure).toHaveBeenCalledWith(expect.any(String), ['departure-one']);
    tick(animationMs);
    expect(tracks[0]!.currentTime).toBe(envelopeTiming.flight.delay);
    expect(tracks[0]!.play).not.toHaveBeenCalled();
    expect(scene()?.dataset.phase).toBe('motion');
    await act(async () => { stored({ ok: true }); });
    expect(tracks[0]!.play).toHaveBeenCalledOnce();
    tick(animationMs + 40); expect(scene()?.dataset.phase).toBe('exit');
    tick(MOTION.exitMs + 100); expect(scene()).toBeNull();
    expect(currentApiMock().mockOf('sessions.sendMessage')).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('agentTasks.outbox')).not.toHaveBeenCalled();
  });

  it('adds at most half a second for a burst and commits every staged letter at one cue', async () => {
    render(<MailEnvelopeViewport mailboxId="a" />);
    offer(letter('1')); tick(800); offer(letter('2')); offer(letter('3'));
    tick(300); offer(letter('4')); offer(letter('5'));
    expect(scene()?.dataset.count).toBe('5'); expect(document.querySelectorAll('.es-flight')).toHaveLength(MAIL_STACK_MAX);
    tick(399); expect(scene()?.dataset.phase).toBe('preview');
    tick(2); expect(scene()?.dataset.phase).toBe('motion');
    expect(tracks).toHaveLength(MAIL_STACK_MAX);
    offer(letter('later')); expect(scene()?.dataset.count).toBe('5');
    const departure = currentApiMock().mockOf('mailPresentation.depart');
    expect(departure).toHaveBeenNthCalledWith(1, expect.any(String), ['departure-later']);
    await act(async () => { vi.advanceTimersByTime(flightAt + 50); });
    expect(departure).toHaveBeenNthCalledWith(2, expect.any(String), ['departure-1', 'departure-2', 'departure-3', 'departure-4', 'departure-5']);
    tick(animationMs); tick(MOTION.exitMs + 100); expect(scene()).toBeNull();
  });

  it('only schedules the other pane from committed activity, including its full half-second collection window', async () => {
    const incoming = () => document.querySelector<HTMLElement>('[data-mailbox-id="b"] .mail-envelope-scene');
    let committedAt = 0;
    currentApiMock().override('mailPresentation.depart', async () => {
      committedAt = Date.now();
      currentApiMock().emit('messages:activity', letter());
      return { ok: true };
    });
    render(<><MailEnvelopeViewport mailboxId="a" /><MailEnvelopeViewport mailboxId="b" /></>);
    offer();
    tick(MAIL_SEND_PREVIEW_MS + 1); tick(flightAt - 50);
    expect(incoming()).toBeNull();
    await act(async () => { vi.advanceTimersByTime(80); });
    expect(incoming()?.dataset.phase).toBe('collect');
    tick(committedAt + MAIL_COLLECT_MS - Date.now() - 1); expect(incoming()?.dataset.phase).toBe('collect');
    tick(2); expect(incoming()?.dataset.phase).toBe('motion');
  });

  it('dismisses the outgoing envelope if the durable commit fails', async () => {
    currentApiMock().override('mailPresentation.depart', async () => ({ ok: false, error: 'write failed' }));
    render(<MailEnvelopeViewport mailboxId="a" />); offer(); tick(MAIL_SEND_PREVIEW_MS + 1);
    await act(async () => { vi.advanceTimersByTime(flightAt + 50); });
    expect(tracks[0]!.play).not.toHaveBeenCalled();
    expect(scene()?.dataset.phase).toBe('exit');
  });

  it('incoming mail reverses the native transition clock, unfolds, then stays readable and disappears', () => {
    render(<MailEnvelopeViewport mailboxId="b" />); emit();
    expect(scene()?.dataset.phase).toBe('collect'); tick(MAIL_COLLECT_MS + 1);
    expect(scene()?.dataset.phase).toBe('motion');
    expect(tracks[0]!.currentTime).toBe(envelopeDuration); expect(tracks[0]!.playbackRate).toBe(-envelopePlaybackRate);
    expect(scene()?.dataset.paperLayer).toBe('inside');
    tick(animationMs / 2); expect(Number(scene()?.dataset.progress)).toBeLessThan(1);
    tick(animationMs / 2 + 40); expect(scene()?.dataset.phase).toBe('preview');
    expect(scene()?.dataset.playing).toBe('false'); expect(scene()?.dataset.paperLayer).toBe('front');
    tick(MAIL_READ_MS - 100); expect(scene()?.dataset.phase).toBe('preview');
    tick(150); tick(MOTION.exitMs + 100); expect(scene()).toBeNull();
  });

  it('does not replay receipt/index changes, irrelevant mail, self mail or duplicate committed events', () => {
    render(<MailEnvelopeViewport mailboxId="b" />);
    act(() => currentApiMock().emit('messages:changed', { at: Date.now() }));
    emit(letter('other', { from: 'c', to: 'd' })); emit(letter('self', { from: 'b' })); expect(scene()).toBeNull();
    emit(); emit(); expect(scene()?.dataset.count).toBe('1');
  });

  it('ignores background events and discards a visible batch on blur without replay on focus', () => {
    const focus = vi.mocked(document.hasFocus); focus.mockReturnValue(false);
    render(<MailEnvelopeViewport mailboxId="a" />); emit(); expect(scene()).toBeNull();
    focus.mockReturnValue(true); act(() => window.dispatchEvent(new Event('focus'))); expect(scene()).toBeNull();
    offer(letter('new')); expect(scene()).not.toBeNull();
    focus.mockReturnValue(false); act(() => window.dispatchEvent(new Event('blur'))); expect(scene()).toBeNull();
    expect(currentApiMock().mockOf('mailPresentation.setViewport')).toHaveBeenLastCalledWith(expect.any(String), 'a', false);
    focus.mockReturnValue(true); act(() => window.dispatchEvent(new Event('focus'))); tick(8000); expect(scene()).toBeNull();
  });

  it('disabled and switched mailboxes discard their pending batch and snapshots', () => {
    const view = render(<MailEnvelopeViewport mailboxId="a" />); offer();
    view.rerender(<MailEnvelopeViewport mailboxId="a" enabled={false} />); expect(scene()).toBeNull();
    emit(letter('hidden')); view.rerender(<MailEnvelopeViewport mailboxId="c" enabled />); expect(scene()).toBeNull();
    emit(letter('for-c', { to: 'c' })); expect(scene()?.dataset.direction).toBe('receive');
  });

  it('a hidden document clears queued motion and does not return it on visibility restore', () => {
    render(<MailEnvelopeViewport mailboxId="a" />); offer();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(scene()).toBeNull();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange'))); tick(8000); expect(scene()).toBeNull();
  });

  it('reduced motion keeps a static reading interval; changing the preference mid-flight cancels tracks', () => {
    act(() => setInteractionPreferences({ motion: 'reduced' }));
    const view = render(<MailEnvelopeViewport mailboxId="a" />); emit();
    expect(currentApiMock().mockOf('mailPresentation.setViewport')).not.toHaveBeenCalled();
    tick(MAIL_SEND_PREVIEW_MS - 1); expect(scene()?.dataset.phase).toBe('preview'); expect(tracks).toHaveLength(0);
    tick(3); tick(MOTION.exitMs + 50); expect(scene()).toBeNull();
    act(() => setInteractionPreferences({ motion: 'system' })); offer(letter('motion')); tick(MAIL_SEND_PREVIEW_MS + 1);
    expect(scene()?.dataset.phase).toBe('motion');
    act(() => setInteractionPreferences({ motion: 'reduced' })); tick(MOTION.exitMs + 50); expect(scene()).toBeNull();
    expect(tracks.every(track => track.cancel.mock.calls.length > 0)).toBe(true); view.unmount();
  });

  it('unmount cancels animation objects, timers, RAF and the mail subscription', () => {
    const view = render(<MailEnvelopeViewport mailboxId="a" />); offer(); tick(MAIL_SEND_PREVIEW_MS + 1);
    view.unmount(); expect(tracks[0]!.cancel).toHaveBeenCalled();
    emit(letter('after')); tick(10000); expect(scene()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });

  it('a long burst bounds visible pages and pending receipts while retaining the total count', () => {
    let state = emptyMailEnvelopeState();
    for (let i = 0; i < 100; i++) state = mailEnvelopeReducer(state, { type: 'arrive', direction: 'send', letter: letter(String(i)), now: i });
    expect(state.active?.count).toBe(100); expect(state.active?.letters).toHaveLength(MAIL_STACK_MAX);
    state = mailEnvelopeReducer(state, { type: 'begin' });
    for (let i = 0; i < 100; i++) state = mailEnvelopeReducer(state, { type: 'arrive', direction: i % 2 ? 'send' : 'receive', letter: letter(String(i)), now: i });
    expect(state.pendingReceive?.count).toBe(50);
    expect(state.pendingReceive?.letters).toHaveLength(MAIL_STACK_MAX);
  });
});
