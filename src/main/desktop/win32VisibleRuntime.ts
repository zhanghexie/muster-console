import { DesktopActivityRuntime } from './desktopActivityRuntime';
import { TrackedWin32Input } from './trackedWin32Input';
import { createWin32Input, type Win32Input } from './win32Input';
import { createWin32WindowApi, type Win32WindowApi } from './win32Applications';
import { createWin32PointHitTest, Win32VisibleControl, type Win32VisibleDeliverySlot } from './win32VisibleControl';
import { Win32VisibleBridge } from './win32VisibleBridge';
import type { CuaSemanticConnection } from './cuaSemanticRuntime';
import { createCuaDesktopBackend } from './cuaDesktopBackend';
import type { createDesktopDeliverySelector } from './desktopDeliverySelector';
import type { VisibleActionDispatcher } from './visibleActionDispatcher';
import type { Win32TargetRegistry } from './win32TargetRegistry';

type ActivityOptions = ConstructorParameters<typeof DesktopActivityRuntime>[0];
type Selector = ReturnType<typeof createDesktopDeliverySelector>;
type Point = { x: number; y: number };
interface Options extends Pick<ActivityOptions, 'labels' | 'theme' | 'createIndicator' | 'createEscapeMonitor' | 'reportMonitorFailure' | 'resumeState'> {
  dispatcher: Pick<VisibleActionDispatcher, 'run'>;
  selector: Selector;
  targets(): Win32TargetRegistry;
  dipToPhysical(point: Point): Point;
  driverPath(): string;
  reportStopError(error: unknown): void;
  /** Optional host-owned dependencies for deterministic tests. */
  createInput?: () => Win32Input;
  createWindowApi?: () => Win32WindowApi;
  createPointHitTest?: () => NonNullable<Win32VisibleDeliverySlot['isPointOnTarget']>;
  createCuaConnection?: () => CuaSemanticConnection;
}

/** Shared Windows seat, input cleanup, screenshot-selected targets and Cua sessions. */
export class Win32VisibleRuntime {
  readonly activity: DesktopActivityRuntime;
  private input?: TrackedWin32Input;
  private windows?: Win32VisibleBridge;
  private readonly cua: ReturnType<typeof createCuaDesktopBackend>;
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(private readonly options: Options) {
    if (!options || typeof options.dispatcher?.run !== 'function' || typeof options.selector?.win32 !== 'function' ||
        typeof options.selector?.cua !== 'function' || typeof options.targets !== 'function' || typeof options.dipToPhysical !== 'function' ||
        typeof options.driverPath !== 'function' || typeof options.reportStopError !== 'function') throw new Error('Windows visible runtime dependencies are unavailable');
    this.activity = new DesktopActivityRuntime({ labels: options.labels, theme: options.theme,
      createIndicator: options.createIndicator, createEscapeMonitor: options.createEscapeMonitor, reportMonitorFailure: options.reportMonitorFailure,
      resumeState: options.resumeState,
      releaseAll: async () => { await this.input?.releaseAll(); }, stopBackend: () => this.cua.stop() });
    this.cua = createCuaDesktopBackend({ ...options, platform: 'win32', activity: this.activity,
      createConnection: options.createCuaConnection, resolveDisplayWindow: (actor, id) => {
        const targets = this.options.targets();
        const selection = targets.visibleTarget(actor, id);
        return { ...targets.semanticTarget(actor, id), surfaceId: selection.frame.surfaceId };
      } });
  }

  windowsControl(): Win32VisibleBridge {
    this.assertOpen();
    if (!this.windows) {
      const input = { move: (x: number, y: number) => this.trackedInput().move(x, y),
        send: (events: Parameters<Win32Input['send']>[0]) => this.trackedInput().send(events),
        releaseAll: async () => { await this.input?.releaseAll(); } };
      const control = new Win32VisibleControl({ dispatcher: this.options.dispatcher, input,
        windowApi: (this.options.createWindowApi ?? createWin32WindowApi)(),
        resolveTarget: (actor, id) => this.options.targets().visibleTarget(actor, id), dipToPhysical: this.options.dipToPhysical });
      this.windows = new Win32VisibleBridge({ control, selector: this.options.selector, activity: this.activity,
        resolveTarget: (actor, id) => this.options.targets().visibleTarget(actor, id),
        isPointOnTarget: (this.options.createPointHitTest ?? createWin32PointHitTest)(), reportStopError: this.options.reportStopError });
    }
    return this.windows;
  }

  semanticControl() { this.assertOpen(); return this.cua.semanticControl(); }
  appDiscovery() { this.assertOpen(); return this.cua.appDiscovery(); }
  windowList() { this.assertOpen(); return this.cua.windows; }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      const failures: unknown[] = [];
      try { await this.activity.dispose(); } catch (error) { failures.push(error); }
      try { await this.cua.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Windows visible desktop runtime cleanup failed');
    })();
    return this.disposal;
  }

  private trackedInput(): TrackedWin32Input { return this.input ??= new TrackedWin32Input((this.options.createInput ?? createWin32Input)()); }
  private assertOpen(): void { if (this.disposed) throw new Error('Windows visible desktop runtime is closed'); }
}
