import { expect, it, vi } from 'vitest';
import { createFeedbackAiRechecker, FEEDBACK_RECHECK_PROMPT } from '../../../src/main/feedback/aiRecheck';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

it('defers checking while busy, then wakes the scheduler without creating an issue', async () => {
  let busy = true, needs = true;
  const send = vi.fn(async (_prompt: string, _workspace: string, _images: undefined, _options: { host: true; requireIdle: true; beforeStart(): boolean; onSkipped(): void }) => {});
  const incomplete = vi.fn(), onError = vi.fn();
  const rechecker = createFeedbackAiRechecker({ needsCheck: () => needs,
    scheduler: () => ({ isBusy: () => busy, send }), workspace: () => 'ws', incomplete, onError });
  rechecker.request(); await settle(); expect(send).not.toHaveBeenCalled();
  busy = false; rechecker.request(); rechecker.request(); await settle();
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(FEEDBACK_RECHECK_PROMPT, 'ws', undefined, expect.objectContaining({ host: true, requireIdle: true }));
  rechecker.onIdle('ws'); // The gate has not started the turn yet.
  expect(incomplete).not.toHaveBeenCalled();
  expect(send.mock.calls[0]![3].beforeStart()).toBe(true);
  busy = true; rechecker.onIdle('ws'); expect(incomplete).not.toHaveBeenCalled();
  needs = false; busy = false; rechecker.onIdle('ws');
  expect(FEEDBACK_RECHECK_PROMPT).toContain('不要创建 Issue');
  expect(FEEDBACK_RECHECK_PROMPT).toContain('host.feedback.history');
  expect(FEEDBACK_RECHECK_PROMPT).toContain('host.feedback.assess');
  expect(incomplete).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
});

it('reports incomplete only after a queued AI turn actually becomes idle', async () => {
  const incomplete = vi.fn();
  const send = vi.fn(async (_prompt: string, _workspace: string, _images: undefined, _options: { host: true; requireIdle: true; beforeStart(): boolean; onSkipped(): void }) => {});
  const rechecker = createFeedbackAiRechecker({ needsCheck: () => true,
    scheduler: () => ({ isBusy: () => false, send }), workspace: () => 'ws', incomplete, onError: vi.fn() });
  rechecker.request(); await settle();
  expect(incomplete).not.toHaveBeenCalled();
  expect(send.mock.calls[0]![3].beforeStart()).toBe(true);
  rechecker.onIdle('other'); expect(incomplete).not.toHaveBeenCalled();
  rechecker.onIdle('ws'); expect(incomplete).toHaveBeenCalledOnce();
});

it('can reschedule immediately if an idle-only gated turn is skipped', async () => {
  const send = vi.fn(async (_prompt: string, _workspace: string, _images: undefined, _options: { host: true; requireIdle: true; beforeStart(): boolean; onSkipped(): void }) => {});
  const rechecker = createFeedbackAiRechecker({ needsCheck: () => true,
    scheduler: () => ({ isBusy: () => false, send }), workspace: () => 'ws', incomplete: vi.fn(), onError: vi.fn() });
  rechecker.request(); await settle();
  send.mock.calls[0]![3].onSkipped();
  rechecker.request(); await settle();
  expect(send).toHaveBeenCalledTimes(2);
});

it('reports incomplete or failed AI checks rather than assuming they succeeded', async () => {
  const incomplete = vi.fn(), onError = vi.fn();
  const rechecker = createFeedbackAiRechecker({ needsCheck: () => true,
    scheduler: () => ({ isBusy: () => false, send: async () => { throw new Error('model unavailable'); } }),
    workspace: () => 'ws', incomplete, onError });
  rechecker.request(); await settle();
  expect(incomplete).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'model unavailable' }));
});
