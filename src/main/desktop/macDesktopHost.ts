import { createCuaDesktopBackend } from './cuaDesktopBackend';
import { CuaTransport } from './cuaTransport';
import { DesktopActivityRuntime } from './desktopActivityRuntime';
import type { createIdempotentDesktopComposition } from './idempotentDesktopComposition';
import { createLocalDesktopDeliverySelector } from './localDesktopDeliverySelector';
import { createMacPermissionReader, createMacScreenLockReader } from './macPermissions';
import { MacTargetRegistry } from './macTargetRegistry';
import { MacVisibleControl } from './macVisibleControl';
import { createMacWindowNative } from './macWindowNative';
import { PtyDesktopTurns } from './ptyDesktopTurns';
import type { MacDesktopStatus } from './runtime';

type ActivityOptions = ConstructorParameters<typeof DesktopActivityRuntime>[0];
interface Options extends Pick<ActivityOptions, 'labels' | 'theme' | 'createIndicator' | 'createEscapeMonitor' | 'resumeState' | 'reportMonitorFailure'> {
  composition: ReturnType<typeof createIdempotentDesktopComposition>;
  driverPath(): string;
  reportStopError(error: unknown): void;
}

/** macOS uses the same seat and receipts, with a private embedded Cua driver for writes. */
export function createMacDesktopHost(options: Options) {
  let targets: MacTargetRegistry | undefined;
  let readPermissions: ReturnType<typeof createMacPermissionReader> | undefined;
  let readScreenLock: ReturnType<typeof createMacScreenLockReader> | undefined;
  let closing: Promise<void> | undefined;
  const permissions = () => (readPermissions ??= createMacPermissionReader())();
  const screenLocked = () => (readScreenLock ??= createMacScreenLockReader())();
  const assertOpen = () => { if (closing) throw new Error('macOS desktop host is closed'); };
  const getTargets = () => {
    assertOpen();
    return targets ??= new MacTargetRegistry(createMacWindowNative(permissions));
  };
  const connect = () => new CuaTransport(options.driverPath(), process.env, undefined, { embedded: true });

  // Cua owns complete gestures. The seat waits for each provider call and its
  // child-process cleanup before releasing the desktop or hiding the indicator.
  const activity = new DesktopActivityRuntime({ ...options, releaseAll: async (): Promise<void> => { control.assertClean(); }, stopBackend: () => cua.stop() });
  const visibilityEpoch = () => activity.visibilityEpoch();
  const control = new MacVisibleControl(getTargets, connect, visibilityEpoch, options.composition.dispatcher, screenLocked);
  const ptyTurns = new PtyDesktopTurns(activity.turns);
  const cua = createCuaDesktopBackend({ ...options, platform: 'darwin', activity, dispatcher: options.composition.dispatcher,
    selector: createLocalDesktopDeliverySelector(), createConnection: connect, resolveDisplayWindow: (actor, id) => {
      const target = getTargets().resolve(actor, id);
      return { surfaceId: target.frame.surfaceId, pid: target.window.pid, windowId: target.window.windowId,
        generation: target.generation, isCurrent: target.isCurrent };
    } });

  return {
    platform: 'darwin' as const,
    visibilityEpoch,
    desktopTurns: () => { assertOpen(); return activity.turns; },
    desktopPtyTurns: () => { assertOpen(); return ptyTurns; },
    desktopMac: {
      status(): MacDesktopStatus {
        const status: MacDesktopStatus = {};
        try { status.permissions = permissions(); }
        catch { status.permissionError = 'Could not check macOS desktop permissions; restart Muster and try again.'; }
        try { status.screenLocked = screenLocked(); }
        catch (error) { status.sessionError = error instanceof Error ? error.message : 'macOS desktop session status is unavailable.'; }
        try { options.driverPath(); }
        catch (error) { status.driverError = error instanceof Error ? error.message : 'The pinned desktop driver is unavailable.'; }
        try { getTargets(); }
        catch { status.targetError = 'This macOS build cannot resolve exact Accessibility window identities; update Muster or use display capture.'; }
        return status;
      },
      permissions,
      screenLocked,
      targets: getTargets,
      control
    },
    desktopAppDiscovery: () => { assertOpen(); return cua.appDiscovery(); },
    desktopSemanticControl: () => { assertOpen(); return cua.semanticControl(); },
    desktopWindowList: () => { assertOpen(); return cua.windows; },
    close(): Promise<void> {
      return closing ??= (async () => {
        await activity.dispose();
        await cua.close();
        try { targets?.close(); } finally { await options.composition.close(); }
      })();
    }
  };
}
