export class DesktopInputCleanupError extends Error {
  constructor(cause: unknown) {
    super(`Desktop input cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'DesktopInputCleanupError';
  }
}

/** Cooperative seat lease. Backends must stop dispatching as soon as signal aborts. */
export class DesktopInputSeat {
  private tail: Promise<void> = Promise.resolve();
  private active: AbortController | undefined;
  private paused = false;
  private lastStart = -Infinity;
  private releaseInFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly releaseAll: () => Promise<void>,
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new Error('Invalid desktop input rate limit');
  }

  /** Called only for independently verified physical user input, never injected input. */
  userTakeover(): Promise<void> {
    if (this.paused) return this.releaseInFlight;
    this.paused = true;
    this.active?.abort(new Error('Desktop input interrupted by user'));
    // Start release immediately, rather than waiting for the operation queue.
    try { this.releaseInFlight = Promise.resolve(this.releaseAll()); }
    catch (error) { this.releaseInFlight = Promise.reject(error); }
    // The backend may fail before a caller starts awaiting takeover.
    void this.releaseInFlight.catch(() => undefined);
    return this.releaseInFlight;
  }

  /** Resume requires an explicit host decision, never a model claim of user consent. */
  async resume(): Promise<void> {
    await this.releaseInFlight;
    this.paused = false;
  }

  /** Resolve only after active and queued operations have actually settled. */
  async waitForIdle(): Promise<void> {
    await this.tail;
    await this.releaseInFlight;
  }

  run<T>(operation: (signal: AbortSignal) => Promise<T>, taskSignal?: AbortSignal): Promise<T> {
    const run = this.tail.then(async () => {
      taskSignal?.throwIfAborted();
      if (this.paused) throw new Error('Desktop input paused after user takeover');
      const elapsed = this.now() - this.lastStart;
      if (elapsed < this.minIntervalMs) throw new Error('Desktop input rate limit exceeded');
      const controller = new AbortController();
      const abortTask = (): void => controller.abort(taskSignal?.reason);
      taskSignal?.addEventListener('abort', abortTask, { once: true });
      if (taskSignal?.aborted) abortTask();
      this.active = controller;
      this.lastStart = this.now();
      try {
        controller.signal.throwIfAborted();
        const result = await operation(controller.signal);
        controller.signal.throwIfAborted();
        return result;
      } finally {
        taskSignal?.removeEventListener('abort', abortTask);
        if (this.active === controller) this.active = undefined;
        // Always release held keys/buttons, including failures and task cancellation.
        try { await this.releaseInFlight; await this.releaseAll(); }
        catch (error) {
          // A failed cleanup leaves physical input state unknown. Do not allow
          // another action or an automatic resume to assume the seat is clear.
          const failure = new DesktopInputCleanupError(error);
          this.paused = true;
          this.releaseInFlight = Promise.reject(failure);
          void this.releaseInFlight.catch(() => undefined);
          throw failure;
        }
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
