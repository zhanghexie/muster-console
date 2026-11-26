/** A desktop-use run remains visible and stoppable between tool calls. */
export class DesktopRun {
  private state: 'active' | 'finishing' | 'stopping' | 'stopped' | 'unknown' = 'active';
  private readonly controller = new AbortController();
  private inFlight = 0;
  private announced = false;

  constructor(private readonly changed: (state: 'active' | 'finishing' | 'stopping' | 'stopped' | 'unknown') => void,
    announce = true) {
    if (announce) this.announce();
  }

  announce(): void {
    if (this.announced || this.state !== 'active') return;
    this.announced = true;
    this.changed('active');
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get status(): 'active' | 'finishing' | 'stopping' | 'stopped' | 'unknown' { return this.state; }

  /** Each dispatched call holds a lease until the backend has actually returned. */
  begin(): (uncertain?: boolean) => void {
    if (this.state !== 'active') throw new Error('Desktop run has been stopped');
    return this.hold();
  }

  holdForStop(): (uncertain?: boolean) => void {
    if (this.state !== 'active' && this.state !== 'finishing') throw new Error('Desktop run has been stopped');
    return this.hold();
  }

  private hold(): (uncertain?: boolean) => void {
    this.inFlight++;
    let ended = false;
    return (uncertain = false) => {
      if (ended) return;
      ended = true;
      this.inFlight--;
      if (uncertain && this.state !== 'unknown') {
        // Queued work already holds a lease. Latch the run before notifying any
        // observer so those calls cannot dispatch after an uncertain outcome.
        this.state = 'unknown';
        this.controller.abort(new Error('Desktop action outcome is unknown'));
        this.changed('unknown');
      }
      else if ((this.state === 'stopping' || this.state === 'finishing') && this.inFlight === 0) this.setState('stopped');
    };
  }

  stop(): void {
    if (this.state !== 'active' && this.state !== 'finishing') return;
    // Cancellation must happen even if a UI notification throws.
    this.state = 'stopping';
    this.controller.abort(new Error('Desktop run stopped by user'));
    try { this.changed('stopping'); }
    finally { if (this.inFlight === 0) this.setState('stopped'); }
  }

  /** Host turn ended normally; retain visibility until all backend calls settle. */
  finish(): void {
    if (this.state !== 'active') return;
    this.setState('finishing');
    if (this.inFlight === 0) this.setState('stopped');
  }

  /** A trusted host may retire the in-memory lease after backend cleanup. This does not reconcile a durable action result. */
  retireUnknown(): void {
    if (this.state !== 'unknown') return;
    if (this.inFlight !== 0) throw new Error('Desktop run still has in-flight work');
    this.setState('stopped');
  }

  private setState(state: 'finishing' | 'stopping' | 'stopped' | 'unknown'): void {
    this.state = state;
    this.changed(state);
  }
}

/** The host owns this registry; model-supplied task identifiers are not authority. */
export class DesktopRunRegistry {
  private readonly runs = new Map<string, DesktopRun>();

  constructor(private readonly changed: (owner: string, state: 'active' | 'finishing' | 'stopping' | 'stopped' | 'unknown') => void) {}

  /** Only a trusted host lifecycle may start a new run after a stop. */
  start(owner: string): DesktopRun {
    if (!owner.trim()) throw new Error('Desktop run owner is required');
    const existing = this.runs.get(owner);
    if (existing && existing.status !== 'stopped') throw new Error('Desktop run is still active');
    if (!existing && this.runs.size >= 256) {
      for (const [key, run] of this.runs) {
        if (run.status === 'stopped') this.runs.delete(key);
        if (this.runs.size < 256) break;
      }
      if (this.runs.size >= 256) throw new Error('Desktop run capacity exceeded');
    }
    const run = new DesktopRun(state => this.changed(owner, state), false);
    this.runs.set(owner, run);
    try { run.announce(); }
    catch (error) {
      try { run.stop(); } catch { /* retain original notification error */ }
      throw error;
    }
    return run;
  }

  get(owner: string): DesktopRun | undefined { return this.runs.get(owner); }

  /** Keep visible runs stopping until seat cleanup has been confirmed. */
  holdActive(): Array<(uncertain?: boolean) => void> {
    return [...this.runs.values()].filter(run => run.status === 'active' || run.status === 'finishing').map(run => run.holdForStop());
  }

  stopAll(): void {
    const errors: unknown[] = [];
    for (const run of this.runs.values()) {
      try { run.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Desktop run stop notification failed');
  }
}
