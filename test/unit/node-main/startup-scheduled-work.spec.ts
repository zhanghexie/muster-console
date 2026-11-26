// @vitest-environment node
import {afterEach, expect, it, vi} from 'vitest';
import type {HostCore} from '../../../src/main/agentSession/host/internal';
import {ScheduledWork} from '../../../src/main/runtimeKernel/scheduledWork';
vi.mock('electron', () => ({app: {getPath: () => ''}}));
import {sweepEngineOrphans} from '../../../src/main/agentSession/host/lifecycle';
vi.stubGlobal('window', globalThis);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve}; }

it('cancels pending startup and recurring timers before they can write again', async () => {
  vi.useFakeTimers();
  const callback = vi.fn(), error = vi.fn(), owner = new ScheduledWork(error);
  owner.schedule(15_000, callback); owner.schedule(300_000, callback, true);
  await owner.shutdown(); await vi.advanceTimersByTimeAsync(600_000);
  expect(callback).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(() => owner.schedule(1, callback)).toThrow('stopping');
});

it('registers before callback reentry and waits for the real in-flight cleanup after abort', async () => {
  vi.useFakeTimers();
  const held = deferred(), owner = new ScheduledWork(vi.fn());
  let shutdown: Promise<void> | undefined, done = false, signal: AbortSignal | undefined;
  owner.schedule(1, async current => {
    signal = current; shutdown = owner.shutdown(); void shutdown.then(() => {done = true;});
    await held.promise;
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true); expect(done).toBe(false);
  held.resolve(); await shutdown; expect(done).toBe(true);
});

it('stops a busy-engine wait immediately without starting the deferred sweep', async () => {
  vi.useFakeTimers();
  const sweep = vi.fn(async () => {}), controller = new AbortController();
  const host = {ctx: {sessions: {engineSweepRoster: () => []}}, store: {sweepOrphans: () => 0},
    entries: new Map([['busy', {runtimeId: 'pi', busy: true}]]),
    drivers: new Map([['pi', {runtimeId: 'pi', purgeDefersOnBusy: true, sweepOrphans: sweep}]])} as unknown as HostCore;
  const pending = sweepEngineOrphans(host, controller.signal);
  expect(vi.getTimerCount()).toBe(1);
  controller.abort(); await pending;
  expect(sweep).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('waits for an already-started driver sweep and skips later drivers after cancellation', async () => {
  vi.useFakeTimers();
  const held = deferred(), later = vi.fn(), owner = new ScheduledWork(vi.fn());
  const host = {ctx: {sessions: {engineSweepRoster: () => []}}, store: {sweepOrphans: () => 0}, entries: new Map(),
    drivers: new Map([['first', {runtimeId: 'first', sweepOrphans: () => held.promise}],
      ['later', {runtimeId: 'later', sweepOrphans: later}]])} as unknown as HostCore;
  owner.schedule(1, signal => sweepEngineOrphans(host, signal));
  await vi.advanceTimersByTimeAsync(1);
  let done = false; const closed = owner.shutdown().then(() => {done = true;});
  await Promise.resolve(); expect(done).toBe(false);
  held.resolve(); await closed; expect(later).not.toHaveBeenCalled();
});
