import { DesktopInputCleanupError, DesktopInputSeat } from './inputSeat';
import { DesktopRun, DesktopRunRegistry } from './desktopRun';
import { PreDispatchFailure } from './preDispatchFailure';

/** Shared per desktop seat, rather than per Worker or task. */
export class DesktopCoordinator {
  private readonly runs: DesktopRunRegistry;
  private readonly seat: DesktopInputSeat;
  private paused = false;
  private stopPromise: Promise<void> | undefined;
  private stopEpoch = 0;

  constructor(releaseAll: () => Promise<void>, changed: (owner: string, state: 'active' | 'finishing' | 'stopping' | 'stopped' | 'unknown') => void,
    private readonly stopBackend: () => Promise<void> = async () => {}) {
    this.runs = new DesktopRunRegistry(changed);
    this.seat = new DesktopInputSeat(releaseAll, 0);
  }

  /** Only the trusted host may initiate a run in response to a new instruction. */
  async start(owner: string): Promise<DesktopRun> {
    const epoch = this.stopEpoch;
    if (this.stopPromise) await this.stopPromise;
    if (epoch !== this.stopEpoch) throw new Error('Desktop restart was stopped');
    if (this.paused) throw new Error('A new user instruction is required to resume desktop use');
    const run = this.runs.start(owner);
    if (epoch !== this.stopEpoch || this.paused) {
      run.stop();
      throw new Error('Desktop startup was stopped');
    }
    return run;
  }

  /** Call only after the host receives a new explicit instruction from the user. */
  async resumeForUserInstruction(owner?: string): Promise<void> {
    const epoch = this.stopEpoch;
    if (this.stopPromise) await this.stopPromise;
    if (epoch !== this.stopEpoch) throw new Error('Desktop restart was stopped');
    if (this.paused) await this.seat.resume();
    if (epoch !== this.stopEpoch) { await this.seat.userTakeover(); throw new Error('Desktop restart was stopped'); }
    // This retires only the old in-memory run. A durable receipt can prevent
    // replay of the same scoped request ID; it does not inspect an unknown
    // effect or identify a semantically equivalent request with a new ID.
    if (owner) this.runs.get(owner)?.retireUnknown();
    if (epoch !== this.stopEpoch) { await this.seat.userTakeover(); throw new Error('Desktop restart was stopped'); }
    this.paused = false;
    this.stopPromise = undefined;
  }

  execute<T>(owner: string, expectedRun: DesktopRun, action: (signal: AbortSignal) => Promise<T>, mutation = true): Promise<T> {
    const run = this.runs.get(owner);
    if (!run || run !== expectedRun || this.paused) return Promise.reject(new Error('Desktop run is not active'));
    const done = run.begin();
    let started = false;
    return this.seat.run(signal => { started = true; return action(signal); }, run.signal).then(
      result => { done(); return result; },
      error => {
        const uncertain = error instanceof DesktopInputCleanupError || (started && mutation && !(error instanceof PreDispatchFailure));
        try { done(uncertain); }
        finally { if (uncertain) void this.stop().catch(() => undefined); }
        throw error;
      }
    );
  }

  finish(owner: string, expectedRun: DesktopRun): void {
    if (this.runs.get(owner) === expectedRun) expectedRun.finish();
  }

  /** Abort active and queued work; a fresh run requires an explicit host start. */
  stop(): Promise<void> {
    this.stopEpoch++;
    if (this.stopPromise) return this.stopPromise;
    this.paused = true;
    // Install the stop barrier before notifying UI callbacks, which can re-enter.
    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    const stopping = new Promise<void>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    this.stopPromise = stopping;
    const stopNow = async () => {
      const holds = this.runs.holdActive();
      let failure: Error | undefined;
      const remember = (error: unknown): void => { failure ??= error instanceof Error ? error : new Error(String(error)); };
      try { this.runs.stopAll(); } catch (error) { remember(error); }
      try {
        // A failed key release does not mean the in-flight backend has
        // exited. Keep its visibility lease until the backend actually settles.
        try { await this.seat.userTakeover(); } catch (error) { remember(error); }
        try { await this.seat.waitForIdle(); } catch (error) { remember(error); }
        try { await this.stopBackend(); } catch (error) { remember(error); }
        if (failure) throw failure;
        for (const done of holds) done();
      } catch (error) {
        for (const done of holds) { try { done(true); } catch { /* continue marking the other runs */ } }
        throw error;
      }
    };
    // Run synchronously through userTakeover before yielding so a different
    // owner's already queued call cannot overtake an uncertain result.
    void stopNow().then(resolveStop, rejectStop);
    return stopping;
  }
}
