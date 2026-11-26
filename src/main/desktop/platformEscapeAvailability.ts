import { desktopRuntime, type DesktopRuntime } from './runtime';

/** Authorization belongs to the process that calls the native preflight. */
export type MacInputMonitoringPermission = 'granted' | 'required' | 'unknown';

export interface PlatformEscapeAvailability {
  runtime: DesktopRuntime;
  /** This module supplies neither an Escape listener nor a stop button. */
  escapeAvailable: false;
  listener: 'not-implemented' | 'handled-elsewhere';
  injectedInputFilter: 'unavailable';
  indicatorVisibility: 'not-checked';
  reason: string;
  remediation: string;
  macInputMonitoring?: {
    permission: MacInputMonitoringPermission;
    subject: 'calling-process';
  };
}

type MacInputPreflight = () => boolean | Promise<boolean>;
type MacNativeLibrary = { func(name: string, result: string, parameters: string[]): () => unknown };
type MacNativeLoader = (name: string) => MacNativeLibrary | Promise<MacNativeLibrary>;

/**
 * A read-only permission check; it does not prompt or create an event tap.
 * Do not use a granted result as evidence that a helper process is authorized,
 * that an event tap is running, or that injected events can be distinguished.
 */
export async function preflightMacInputMonitoring(platform: NodeJS.Platform = process.platform,
  preflight: MacInputPreflight = nativeMacInputPreflight): Promise<MacInputMonitoringPermission> {
  if (platform !== 'darwin') return 'unknown';
  try {
    const result: unknown = await preflight();
    return result === true ? 'granted' : result === false ? 'required' : 'unknown';
  } catch {
    // An absent symbol/framework or FFI error is not a user denial.
    return 'unknown';
  }
}

export async function nativeMacInputPreflight(load: MacNativeLoader = loadMacLibrary): Promise<boolean> {
  const coreGraphics = await load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const preflight = coreGraphics.func('CGPreflightListenEventAccess', 'bool', []);
  const result = preflight();
  if (typeof result !== 'boolean') throw new Error('Invalid Input Monitoring preflight response');
  return result;
}

async function loadMacLibrary(name: string): Promise<MacNativeLibrary> {
  const { default: koffi } = await import('koffi');
  return koffi.load(name);
}

/**
 * Reports the currently implemented non-Windows boundary, not a platform
 * feature claim. XWayland is never treated as a native Wayland listener.
 */
export async function platformEscapeAvailability(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  macInputPreflight?: MacInputPreflight;
} = {}): Promise<PlatformEscapeAvailability> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runtime = desktopRuntime(platform, env);
  const base = {
    runtime, escapeAvailable: false as const, injectedInputFilter: 'unavailable' as const,
    indicatorVisibility: 'not-checked' as const
  };
  switch (runtime) {
    case 'macos': {
      const permission = await preflightMacInputMonitoring(platform, options.macInputPreflight);
      return { ...base, listener: 'handled-elsewhere', reason: 'macos-listener-managed-separately',
        remediation: permission === 'required'
          ? 'Input Monitoring is required for a passive event tap. Verify authorization for the listener process and use the visible Stop button if the listener is unavailable.'
          : permission === 'unknown'
            ? 'The calling-process Input Monitoring preflight failed or is unavailable. Check the separate listener process and use the visible Stop button if needed.'
            : 'Input Monitoring is granted to the calling process; the separate listener and its permission still need verification. Synthetic input cannot be reliably distinguished.',
        macInputMonitoring: { permission, subject: 'calling-process' } };
    }
    case 'linux-x11':
      return { ...base, listener: 'handled-elsewhere',
        reason: env.DISPLAY?.trim() ? 'x11-listener-managed-separately' : 'x11-display-unavailable',
        remediation: env.DISPLAY?.trim()
          ? 'Verify the separate native X11 listener and use the visible Stop button if it is unavailable. Synthetic input cannot be reliably distinguished.'
          : 'An X11 DISPLAY is required. Verify the separate listener and use the visible Stop button if it is unavailable.' };
    case 'linux-wayland':
      return { ...base, listener: 'not-implemented', reason: 'wayland-listener-not-implemented',
        remediation: 'A portal shortcut does not establish input provenance. Verify a visible stop control separately; XWayland cannot establish native Wayland coverage.' };
    case 'linux-unknown':
      return { ...base, listener: 'not-implemented', reason: 'linux-session-unknown',
        remediation: 'Determine the active graphical session and verify an appropriate stop control.' };
    case 'windows':
      return { ...base, listener: 'handled-elsewhere', reason: 'windows-listener-managed-separately',
        remediation: 'Use the Windows Escape monitor; its availability and indicator visibility must be checked separately.' };
    default:
      return { ...base, listener: 'not-implemented', reason: 'platform-unsupported',
        remediation: 'This platform has no Escape listener in this build.' };
  }
}
