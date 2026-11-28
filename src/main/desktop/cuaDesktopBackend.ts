import { CuaAppDiscovery } from './cuaAppDiscovery';
import { CuaSemanticRuntime, type CuaSemanticActor, type CuaSemanticConnection, type CuaSemanticTarget } from './cuaSemanticRuntime';
import { CuaTransport } from './cuaTransport';
import { CuaVisibleBridge } from './cuaVisibleBridge';
import { createCuaVisibleAction } from './cuaVisibleAction';
import { CuaWindowList } from './cuaWindowList';
import type { DesktopActivityRuntime } from './desktopActivityRuntime';
import { captureInvocationCuaSlot } from './desktopDeliveryInvocation';
import type { createDesktopDeliverySelector } from './desktopDeliverySelector';
import { desktopRuntime } from './runtime';
import type { VisibleActionDispatcher } from './visibleActionDispatcher';

type ResolvedTarget = CuaSemanticTarget & { surfaceId?: string };

/** Compose the same window observation, click, discovery and cleanup on every host. */
export function createCuaDesktopBackend(options: {
  platform: 'win32' | 'darwin' | 'linux';
  driverPath(): string;
  activity: DesktopActivityRuntime;
  dispatcher: Pick<VisibleActionDispatcher, 'run'>;
  selector: ReturnType<typeof createDesktopDeliverySelector>;
  resolveDisplayWindow?(actor: CuaSemanticActor, id: string): ResolvedTarget;
  reportStopError(error: unknown): void;
  assertInputAllowed?(): void;
  createConnection?: () => CuaSemanticConnection;
  env?: NodeJS.ProcessEnv;
}) {
  const env = options.env ?? process.env;
  const fingerprint = () => [desktopRuntime(options.platform, env), env.DISPLAY, env.WAYLAND_DISPLAY,
    env.XDG_RUNTIME_DIR, env.XAUTHORITY, env.DBUS_SESSION_BUS_ADDRESS].join('\0');
  const session = fingerprint();
  const current = () => options.platform !== 'linux' || fingerprint() === session;
  const connect = options.createConnection ?? (() => {
    if (!current()) throw new Error('The Linux graphical session changed. Restart Muster in the active session.');
    return new CuaTransport(options.driverPath(), env, undefined, { embedded: options.platform === 'darwin' });
  });
  const windows = new CuaWindowList(connect, current);
  let runtime: CuaSemanticRuntime | undefined, bridge: CuaVisibleBridge | undefined, discovery: CuaAppDiscovery | undefined;
  const resolve = (actor: CuaSemanticActor, id: string): ResolvedTarget => {
    const target = windows.resolve(actor, id) ?? options.resolveDisplayWindow?.(actor, id);
    if (!target) throw new Error('The window selection is unavailable. List windows again.');
    return target;
  };
  const shutdown = async (close: boolean) => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => windows.clear()),
      Promise.resolve().then(() => close ? runtime?.close() : runtime?.stopAll()),
      Promise.resolve().then(() => close ? discovery?.close() : discovery?.stopAll())
    ]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Cua desktop driver cleanup failed');
  };
  return {
    windows,
    semanticControl() {
      if (bridge) return bridge;
      runtime = new CuaSemanticRuntime({ platform: options.platform, createConnection: connect, resolveTarget: resolve,
        onCleanupError: options.reportStopError,
        runPersistedAction: createCuaVisibleAction(options.dispatcher, request => captureInvocationCuaSlot(options.selector, request),
          options.assertInputAllowed) });
      return bridge = new CuaVisibleBridge({ runtime, activity: options.activity, resolveTarget: resolve, reportStopError: options.reportStopError });
    },
    appDiscovery() {
      return discovery ??= new CuaAppDiscovery({ platform: options.platform, env, createConnection: connect, onCleanupError: options.reportStopError });
    },
    stop: () => shutdown(false),
    close: () => shutdown(true)
  };
}
