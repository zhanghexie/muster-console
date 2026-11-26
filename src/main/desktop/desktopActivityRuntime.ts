import type { DesktopIndicatorSnapshot } from '../../shared/desktopIndicator';
import { DesktopActivity } from './desktopActivity';
import { DesktopTurns } from './desktopTurns';
import type { DesktopResumeState } from './desktopResumeState';

interface Indicator {
  show(snapshot: DesktopIndicatorSnapshot): Promise<void>;
  close(): void;
  /** Optional synchronous health check for non-Electron indicator backends. */
  isCurrent?(): boolean;
  /** Process-backed indicators can finish cleanup asynchronously. */
  whenClosed?(): Promise<void>;
}
interface EscapeMonitor { start(): Promise<void>; stop(): Promise<void> }
interface Options {
  createIndicator(stop: () => Promise<void>, unavailable: (reason: string) => void): Indicator;
  createEscapeMonitor?: (onEscape: () => void, onFailure: (reason: string) => void) => EscapeMonitor;
  /** The selected backend must provide a real held-input cleanup operation. */
  releaseAll(): Promise<void>;
  /** Reclaim idle and active backend helpers before the indicator closes on stop. */
  stopBackend?(): Promise<void>;
  labels: DesktopIndicatorSnapshot['labels'];
  theme?: DesktopIndicatorSnapshot['theme'];
  reportMonitorFailure?(reason: string): void;
  resumeState?: DesktopResumeState;
}

/** Host composition; an indicator failure prevents dispatch, a monitor failure leaves the stop button available. */
export class DesktopActivityRuntime {
  readonly activity: DesktopActivity;
  readonly turns: DesktopTurns;
  private readonly indicator: Indicator;
  private monitor?: EscapeMonitor;
  private monitorState: 'idle' | 'starting' | 'ready' | 'failed' = 'idle';
  private monitorGeneration = 0;
  private monitorStop: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposing = false;
  private disposal?: Promise<void>;
  private visible = false;
  private visibilityGeneration = 0;

  constructor(private readonly options: Options) {
    this.indicator = options.createIndicator(() => this.stop(), reason => {
      this.visible = false;
      this.visibilityGeneration++;
      this.activity.unavailable(reason);
      this.suspendMonitor();
    });
    this.activity = new DesktopActivity({ show: snapshot => this.show(snapshot), close: () => this.closeIndicator() },
      options.releaseAll, options.labels, options.theme, options.stopBackend?.bind(options), options.resumeState, error => this.report(error));
    this.turns = new DesktopTurns(this.activity);
  }

  /** True only after the host indicator reported a visible mounted window. */
  isVisible(): boolean {
    if (this.disposed || !this.visible) return false;
    if (this.indicator.isCurrent) {
      let current = false;
      try { current = this.indicator.isCurrent() === true; } catch { /* an unreliable indicator is unavailable */ }
      if (!current) {
        this.visible = false;
        this.visibilityGeneration++;
        this.activity.unavailable('Desktop indicator is unavailable');
        this.suspendMonitor();
        return false;
      }
    }
    return true;
  }

  /** A hidden/crashed and then recreated indicator never revives an old capture proof. */
  visibilityEpoch(): number | undefined { return this.isVisible() ? this.visibilityGeneration : undefined; }

  stop(persist = true): Promise<void> {
    // turn cancellation runs synchronously up to its first await; retire the
    // listener at the same time and report cleanup failure to the caller.
    const stopping = this.turns.stop(persist);
    this.suspendMonitor();
    return Promise.allSettled([stopping, this.monitorStop]).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Desktop activity stop failed');
    });
  }

  dispose(): Promise<void> { return this.disposal ??= this.disposeOnce(); }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    this.disposing = true;
    const failures: Error[] = [];
    let stopped = false;
    const remember = (error: unknown): void => {
      const value = error instanceof Error ? error : new Error(String(error));
      if (!failures.includes(value)) failures.push(value);
    };
    try { await this.stop(false); stopped = true; } catch (error) { remember(error); }
    // Let the stopped/unknown state reach the already-mounted indicator before
    // deciding whether to close it. A failed backend cleanup is not evidence
    // that the executor has stopped, so keep the warning visible in that case.
    try { await this.activity.flushRendering(); }
    catch (error) { if (stopped) this.report(error); else remember(error); }
    if (stopped) {
      try { this.closeIndicator(); } catch (error) { remember(error); }
      try { await this.indicator.whenClosed?.(); } catch (error) { remember(error); }
    }
    try { await this.monitorStop; } catch (error) { remember(error); }
    this.disposing = false;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Desktop activity cleanup failed');
  }

  private async show(snapshot: DesktopIndicatorSnapshot): Promise<void> {
    if (this.disposing) {
      // Rendering a stop or unknown status is allowed during shutdown, but it
      // must never revive visibility authority or start another listener.
      await this.indicator.show({ ...snapshot, escapeAvailable: false });
      return;
    }
    if (this.disposed) throw new Error('Desktop activity runtime is closed');
    // The clickable stop must actually be mounted before listening or dispatch.
    const visibilityGeneration = this.visibilityGeneration;
    try { await this.indicator.show(snapshot); }
    catch (error) { this.visible = false; this.visibilityGeneration++; this.suspendMonitor(); throw error; }
    if (this.disposed || visibilityGeneration !== this.visibilityGeneration) throw new Error('Desktop indicator became unavailable');
    this.visible = true;
    if (!this.options.createEscapeMonitor || this.monitorState !== 'idle') return;
    const generation = this.monitorGeneration;
    this.monitorState = 'starting';
    try {
      await this.monitorStop;
      if (generation !== this.monitorGeneration || this.disposed) return;
      const monitor = this.options.createEscapeMonitor(
        () => { void this.stop().catch(error => this.report(error)); },
        reason => this.monitorFailed(generation, reason)
      );
      this.monitor = monitor;
      if (this.monitorState !== 'starting' || generation !== this.monitorGeneration || this.disposed) {
        this.monitor = undefined;
        this.queueMonitorStop(monitor);
        return;
      }
      await monitor.start();
      if (generation !== this.monitorGeneration || this.disposed || this.monitorState !== 'starting') return;
      this.monitorState = 'ready';
      this.activity.setEscapeAvailable(true);
    } catch (error) {
      this.monitorFailed(generation, error instanceof Error ? error.message : String(error));
    }
  }

  private monitorFailed(generation: number, reason: string): void {
    if (generation !== this.monitorGeneration || this.disposed || this.monitorState === 'failed') return;
    this.monitorState = 'failed';
    this.activity.setEscapeAvailable(false);
    this.report(reason);
    const monitor = this.monitor;
    this.monitor = undefined;
    if (monitor) this.queueMonitorStop(monitor);
  }

  private closeIndicator(): void {
    this.monitorGeneration++;
    this.visible = false;
    this.visibilityGeneration++;
    try { this.indicator.close(); }
    finally {
      this.activity.setEscapeAvailable(false);
      const monitor = this.monitor;
      this.monitor = undefined;
      this.monitorState = 'idle';
      if (monitor) this.queueMonitorStop(monitor);
    }
  }

  private suspendMonitor(): void {
    this.monitorGeneration++;
    const monitor = this.monitor;
    this.monitor = undefined;
    this.monitorState = 'failed';
    this.activity.setEscapeAvailable(false);
    if (monitor) this.queueMonitorStop(monitor);
  }

  private queueMonitorStop(monitor: EscapeMonitor): void {
    // Never start a later listener until the prior listener's exit is confirmed.
    this.monitorStop = this.monitorStop.then(() => monitor.stop());
    void this.monitorStop.catch(error => this.report(error));
  }

  private report(error: unknown): void {
    try { this.options.reportMonitorFailure?.(error instanceof Error ? error.message : String(error)); } catch { /* diagnostic only */ }
  }
}
