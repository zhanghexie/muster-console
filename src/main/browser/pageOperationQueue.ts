/**
 * Serialize state-changing Agent operations for each browser tab without locking other tabs.
 * Observation/wait tools must stay outside this queue: a queued wait could block the action
 * that satisfies it. The owner supplies lifecycle checks; this class never resolves a new page.
 */
export interface PageOperationOptions {
  /** Check the tab/guest identity captured before enqueueing, including its generation. */
  assertCurrent?: () => void;
  /** Cancellation removes waiting work; an already-started action keeps the lane until settled. */
  signal?: AbortSignal;
}

interface QueueEntry {
  operation: () => unknown | Promise<unknown>;
  assertCurrent?: () => void;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

interface PageLane {
  running: boolean;
  pending: QueueEntry[];
}

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('Browser page operation cancelled before it started');
  error.name = 'AbortError';
  return error;
}

export class BrowserPageOperationQueue {
  private lanes = new Map<string, PageLane>();

  /** Number of tabs with running or waiting work; empty lanes are removed immediately. */
  get size(): number { return this.lanes.size; }

  run<T>(tabId: string, operation: () => T | Promise<T>, options: PageOperationOptions = {}): Promise<T> {
    const { assertCurrent, signal } = options;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    try { assertCurrent?.(); } catch (error) { return Promise.reject(error); }

    return new Promise<T>((resolve, reject) => {
      let lane = this.lanes.get(tabId);
      if (!lane) {
        lane = { running: false, pending: [] };
        this.lanes.set(tabId, lane);
      }
      const currentLane = lane;
      const entry: QueueEntry = {
        operation,
        assertCurrent,
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {}
      };
      if (signal) {
        const cancel = (): void => {
          const at = currentLane.pending.indexOf(entry);
          if (at < 0) return; // Running operations must settle before another operation may start.
          currentLane.pending.splice(at, 1);
          entry.cleanup();
          reject(abortError(signal));
        };
        entry.cleanup = () => signal.removeEventListener('abort', cancel);
        signal.addEventListener('abort', cancel, { once: true });
      }
      currentLane.pending.push(entry);
      if (!currentLane.running) void this.drain(tabId, currentLane);
    });
  }

  /** Close/detach/shutdown may reject waiting work immediately; running work is never replayed. */
  cancelPending(tabId: string, reason: unknown = new Error('Browser page is no longer available')): void {
    const lane = this.lanes.get(tabId);
    if (!lane) return;
    for (const entry of lane.pending.splice(0)) {
      entry.cleanup();
      entry.reject(reason);
    }
  }

  private async drain(tabId: string, lane: PageLane): Promise<void> {
    lane.running = true;
    try {
      while (lane.pending.length) {
        const entry = lane.pending.shift()!;
        entry.cleanup();
        try {
          // A tab may close or its guest may be replaced while the operation waits.
          entry.assertCurrent?.();
          entry.resolve(await entry.operation());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      lane.running = false;
      if (this.lanes.get(tabId) === lane) this.lanes.delete(tabId);
    }
  }
}
