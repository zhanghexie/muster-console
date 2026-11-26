import { describe, expect, it, vi } from 'vitest';
import { schedulerIsClosing, shutdownScheduler, trackSchedulerCleanup, trackSchedulerWork } from '../../src/main/agent/orchestrator/lifecycle';
import { TurnGate, TurnGateQueue } from '../../src/shared/turnGate';
import { drainRetirements, retirePendingConnection } from '../../src/main/agentSession/host/retirement';
import type { HostCore, SessionEntry } from '../../src/main/agentSession/host/internal';
import type { GuiRuntimeConnection } from '../../src/main/agentSession/types';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('scheduler shutdown ownership', () => {
  it('stops admission synchronously and waits for turns, detached cleanup and flush', async () => {
    const owner = {}, turn = deferred(), cleanup = deferred(), written = deferred();
    const sequence: string[] = [];
    const work = trackSchedulerWork(owner, () => turn.promise);
    trackSchedulerCleanup(owner, cleanup.promise);
    const stop = vi.fn(() => { sequence.push('stop'); });
    const close = () => { sequence.push('close'); };
    const flush = () => { sequence.push('flush'); return written.promise; };
    const done = shutdownScheduler(owner, stop, close, flush);
    expect(shutdownScheduler(owner, stop, close, flush)).toBe(done);
    expect(schedulerIsClosing(owner)).toBe(true);
    await expect(trackSchedulerWork(owner, async () => {})).rejects.toThrow('shutting down');
    await Promise.resolve(); expect(sequence).toEqual(['stop']);
    turn.resolve(); await work; await Promise.resolve(); await Promise.resolve();
    expect(sequence).toEqual(['stop', 'close']);
    cleanup.resolve(); await cleanup.promise; await Promise.resolve(); await Promise.resolve();
    written.resolve(); await done;
    expect(sequence).toEqual(['stop', 'close', 'flush']); expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reports cleanup failures after still flushing', async () => {
    const owner = {}, flush = vi.fn(async () => {});
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      trackSchedulerCleanup(owner, Promise.reject(new Error('engine failed')));
      await expect(shutdownScheduler(owner, () => { throw new Error('stop failed'); }, () => {}, flush)).rejects.toThrow('Scheduler shutdown failed');
      expect(flush).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it('cancels gate retry and never delivers a stale scheduled callback', () => {
    let scheduled = () => {}; const cancel = vi.fn(), skipped = vi.fn(), deliver = vi.fn();
    const gate = new TurnGate(() => ({ enabled: true, cap: 1, leaseMs: 60000 }), Date.now);
    gate.tryAcquire();
    const queue = new TurnGateQueue({ gate, deliver, schedule: fn => { scheduled = fn; return 42; }, cancel });
    queue.submit({ workspaceId: 'ws', text: 'pending', onSkipped: skipped });
    queue.dispose(); queue.dispose(); scheduled();
    expect(cancel).toHaveBeenCalledWith(42); expect(skipped).toHaveBeenCalledOnce(); expect(deliver).not.toHaveBeenCalled();
    expect(queue.pendingCount).toBe(0);
  });

  it('GUI shutdown waits for a pending connection even after its entry was removed', async () => {
    const host = {} as HostCore, connected = deferred(), closed = deferred();
    const connection = { close: vi.fn(() => closed.promise) } as unknown as GuiRuntimeConnection;
    retirePendingConnection(host, { sessionId: 'removed' } as SessionEntry, connected.promise.then(() => connection), null);
    let finished = false; const done = drainRetirements(host).then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    connected.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(connection.close).toHaveBeenCalledOnce(); expect(finished).toBe(false);
    closed.resolve(); await done; expect(finished).toBe(true);
  });
});
