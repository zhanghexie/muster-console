import { createCuaDesktopBackend } from './cuaDesktopBackend';
import type { CuaSemanticConnection } from './cuaSemanticRuntime';
import { DesktopActivityRuntime } from './desktopActivityRuntime';
import type { createIdempotentDesktopComposition } from './idempotentDesktopComposition';
import { createLocalDesktopDeliverySelector } from './localDesktopDeliverySelector';
import { PtyDesktopTurns } from './ptyDesktopTurns';
import { desktopRuntime } from './runtime';

type ActivityOptions = ConstructorParameters<typeof DesktopActivityRuntime>[0];
type Options = Omit<ActivityOptions, 'releaseAll' | 'stopBackend'> & {
  composition: ReturnType<typeof createIdempotentDesktopComposition>;
  driverPath(): string;
  reportStopError(error: unknown): void;
  env?: NodeJS.ProcessEnv;
  createConnection?: () => CuaSemanticConnection;
};

export function createLinuxDesktopHost(options: Options) {
  const env = options.env ?? process.env;
  const runtime = desktopRuntime('linux', env);
  if ((runtime !== 'linux-x11' && runtime !== 'linux-wayland') ||
      (runtime === 'linux-x11' && !env.DISPLAY?.trim())) throw new Error('Start Muster in a supported X11 or native Wayland desktop session.');
  // Native Wayland has a compositor-owned Stop button. X11 can use its passive Escape helper.
  const activity = new DesktopActivityRuntime({ ...options, createEscapeMonitor: runtime === 'linux-x11' ? options.createEscapeMonitor : undefined,
    releaseAll: async () => {}, stopBackend: () => cua.stop() });
  const cua = createCuaDesktopBackend({ ...options, platform: 'linux', activity, dispatcher: options.composition.dispatcher,
    selector: createLocalDesktopDeliverySelector() });
  const pty = new PtyDesktopTurns(activity.turns);
  let closing: Promise<void> | undefined;
  const assertOpen = () => { if (closing) throw new Error('Linux desktop host is closed'); };
  return {
    platform: 'linux' as const,
    visibilityEpoch: () => activity.visibilityEpoch(),
    desktopTurns: () => { assertOpen(); return activity.turns; },
    desktopPtyTurns: () => { assertOpen(); return pty; },
    desktopSemanticControl: () => { assertOpen(); return cua.semanticControl(); },
    desktopAppDiscovery: () => { assertOpen(); return cua.appDiscovery(); },
    desktopWindowList: () => { assertOpen(); return cua.windows; },
    close: () => closing ??= (async () => {
      await activity.dispose();
      await cua.close();
      await options.composition.close();
    })()
  };
}
