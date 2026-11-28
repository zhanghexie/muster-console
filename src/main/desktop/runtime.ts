import type { MacDesktopPermission, MacDesktopPermissions } from './macPermissions';
import type { DesktopPermissionSource } from '../../shared/desktopSetup';
import { PreDispatchFailure } from './preDispatchFailure';

export type DesktopRuntime = 'windows' | 'macos' | 'linux-x11' | 'linux-wayland' | 'linux-unknown' | 'unsupported';
export type DesktopCapability = 'semanticRead' | 'semanticAct' | 'capture' | 'windowCapture' | 'foregroundInput' | 'backgroundInput' | 'activate';
export interface DesktopCapabilityStatus {
  available: boolean;
  backend: string | null;
  grant: 'unknown' | 'not-required' | 'required' | 'granted' | 'denied';
  limitation: string;
  remediation: string;
  source?: DesktopPermissionSource;
  displayActions?: Record<'type' | 'key' | 'scroll' | 'drag' | 'move' | 'hover', boolean>;
}

export interface MacDesktopStatus {
  permissions?: MacDesktopPermissions;
  permissionError?: string;
  driverPermissions?: MacDesktopPermissions;
  driverPermissionError?: string;
  driverError?: string;
  targetError?: string;
  screenLocked?: boolean;
  sessionError?: string;
  secureInput?: boolean;
}

export const macScreenLockedMessage = 'Wake and unlock the Mac, then capture the display again before using windows or input.';
export const macSecureInputMessage = 'macOS Secure Input is active. Finish or dismiss the protected input prompt, then capture the display again before retrying. Use the visible Stop button if needed.';
export const macDriverPermissionReadError = 'The embedded Cua driver could not check macOS permissions. Recheck in General settings, then fully quit and reopen the current app if the check still fails.';

export class MacSecureInputActiveError extends PreDispatchFailure {
  constructor() { super(macSecureInputMessage); }
}

const permissionNames: Record<MacDesktopPermission, string> = { screenRecording: 'Screen & System Audio Recording', accessibility: 'Accessibility' };
export function macPermissionMessage(permissions: readonly MacDesktopPermission[], source: DesktopPermissionSource = 'host'): string {
  if (source === 'driver') return `The embedded Cua driver reports missing ${permissions.map(permission => permissionNames[permission]).join(' and ')}. Check the grant for the current app bundle in System Settings → Privacy & Security, fully quit and reopen that copy, then recheck in General settings.`;
  return `Enable ${permissions.map(permission => permissionNames[permission]).join(' and ')} for the app running Muster in System Settings → Privacy & Security, then restart it if macOS requests a restart.`;
}

export function desktopOperationFailure(runtime: DesktopRuntime, action: string, code: string, message: string) {
  return { ok: false as const, runtime, action, code, message };
}

export function macPermissionFailure(action: string, required: readonly MacDesktopPermission[], source: DesktopPermissionSource,
  permissions: MacDesktopPermissions | undefined, error?: string) {
  if (!permissions) return { ...desktopOperationFailure('macos', action, 'permission_check_failed', error ??
    'Could not check the current app’s macOS permissions; restart Muster and try again.'), source };
  const missing = required.filter(permission => !permissions[permission]);
  if (missing.length) return { ...desktopOperationFailure('macos', action, 'permission_required', macPermissionMessage(missing, source)),
    permissions: missing, source };
}

/** Distinguish Wayland sessions from an XWayland DISPLAY; no OS permission is requested. */
export function desktopRuntime(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): DesktopRuntime {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform !== 'linux') return 'unsupported';
  const type = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (type === 'x11' && !!env.WAYLAND_DISPLAY?.trim()) return 'linux-unknown';
  if (type === 'wayland' || !!env.WAYLAND_DISPLAY?.trim()) return 'linux-wayland';
  if (type === 'x11' || !!env.DISPLAY?.trim()) return 'linux-x11';
  return 'linux-unknown';
}

/** Fail closed when no backend has been wired; callers must not report simulated support. */
export function unavailableDesktopCapabilities(runtime: DesktopRuntime): Record<DesktopCapability, DesktopCapabilityStatus> {
  const remediation: Record<DesktopRuntime, string> = {
    windows: 'The Windows desktop backend is not available in this build.',
    macos: 'The macOS desktop backend is not available in this build; Screen Recording and Accessibility permissions alone do not enable it.',
    'linux-x11': 'The X11 desktop backend is not available in this build; verify an X11 session and the required adapter.',
    'linux-wayland': 'The Wayland desktop backend is not available in this build; a portal-capable adapter is required. XWayland is limited to X11 clients.',
    'linux-unknown': 'No graphical session was detected; start a supported graphical session and desktop adapter.',
    unsupported: 'This operating system has no desktop adapter in this build.'
  };
  const keys: DesktopCapability[] = ['semanticRead', 'semanticAct', 'capture', 'windowCapture', 'foregroundInput', 'backgroundInput', 'activate'];
  return Object.fromEntries(keys.map(key => [key, { available: false, backend: null, grant: 'unknown',
    limitation: 'capability_unsupported', remediation: runtime === 'linux-wayland' &&
      (key === 'semanticAct' || key === 'foregroundInput' || key === 'backgroundInput')
      ? 'Native Wayland input is unavailable in this build. A compositor-compatible desktop backend and visible stop control are required; XWayland only applies to X11 clients.'
      : remediation[runtime] }])) as Record<DesktopCapability, DesktopCapabilityStatus>;
}

/** Public operation availability is distinct from observation identity and user consent. */
export function desktopOperationCapabilities(runtime: DesktopRuntime, wired: { capture: boolean; control: boolean; visible?: boolean; semantic?: boolean;
  windowCapture?: boolean; mac?: MacDesktopStatus }): Record<DesktopCapability, DesktopCapabilityStatus> {
  const capabilities = unavailableDesktopCapabilities(runtime);
  if (runtime === 'macos' && wired.mac && wired.capture) {
    const mac = wired.mac;
    const status = (backend: 'cua-driver' | 'electron', limitation: string, required: MacDesktopPermission[], input = false): DesktopCapabilityStatus => {
      if (backend === 'cua-driver' && (mac.driverError || mac.targetError)) {
        return { available: false, backend, grant: 'unknown', limitation: mac.driverError ? 'dependency_missing' : 'capability_unsupported',
          remediation: mac.driverError ?? mac.targetError! };
      }
      const hostFailure = macPermissionFailure('', required, 'host', mac.permissions, mac.permissionError);
      if (hostFailure) return { available: false, backend, grant: 'permissions' in hostFailure ? 'required' : 'unknown',
        source: hostFailure.source, limitation: hostFailure.code, remediation: hostFailure.message };
      if (backend === 'cua-driver' && (mac.screenLocked || mac.sessionError)) {
        return { available: false, backend, grant: 'unknown', limitation: mac.screenLocked ? 'screen_locked' : 'desktop_session_unavailable',
          remediation: mac.screenLocked ? macScreenLockedMessage : mac.sessionError! };
      }
      if (input && mac.secureInput) return { available: false, backend, grant: 'unknown', limitation: 'secure_input_active', remediation: macSecureInputMessage };
      if (backend === 'cua-driver') {
        if (!mac.driverPermissions && !mac.driverPermissionError) return { available: false, backend, grant: 'unknown', source: 'driver',
          limitation: 'permission_not_checked', remediation: 'Run desktop.list or check computer control in General settings.' };
        const driverFailure = macPermissionFailure('', required, 'driver', mac.driverPermissions, mac.driverPermissionError);
        if (driverFailure) return { available: false, backend, grant: 'permissions' in driverFailure ? 'required' : 'unknown',
          source: driverFailure.source, limitation: driverFailure.code, remediation: driverFailure.message };
      }
      return { available: true, backend, grant: 'granted', limitation, remediation: 'Requires a visible desktop run and a current desktop target.' };
    };
    capabilities.capture = status('electron', 'capture_reads_all_displays', ['screenRecording']);
    const targetPermissions: MacDesktopPermission[] = ['screenRecording', 'accessibility'];
    if (wired.control) {
      capabilities.foregroundInput = { ...status('cua-driver', 'requires_capture_window; move_and_hover_unavailable', targetPermissions, true),
        displayActions: { type: true, key: true, scroll: true, drag: true, move: false, hover: false } };
      capabilities.activate = status('cua-driver', 'requires_capture_window', targetPermissions, true);
    }
    if (wired.semantic) {
      capabilities.semanticRead = status('cua-driver', 'bounded_tree; values_may_be_redacted', targetPermissions);
      capabilities.semanticAct = status('cua-driver', 'requires_current_semantic_ref; backend_effect_may_be_unverifiable', targetPermissions, true);
    }
    if (wired.windowCapture) capabilities.windowCapture = status('cua-driver', 'window_capture_and_click', targetPermissions);
    return capabilities;
  }
  if (runtime === 'linux-x11' || runtime === 'linux-wayland') {
    const status = (backend: string, limitation: string): DesktopCapabilityStatus => ({ available: true, backend, grant: 'unknown',
      limitation, remediation: runtime === 'linux-wayland'
        ? 'Requires a supported compositor and a visible Stop control. Check the active Wayland adapter or portal when a capture is refused.'
        : 'Requires an accessible X11 display, the pinned driver for window operations, and a visible Stop control.' });
    if (wired.capture) capabilities.capture = status('electron', 'requires_uniquely_matched_display_source');
    if (wired.semantic) {
      capabilities.semanticRead = status('cua-driver', 'requires_accessible_window_tree');
      capabilities.semanticAct = status('cua-driver', 'requires_current_semantic_ref');
    }
    if (wired.windowCapture) {
      capabilities.windowCapture = status('cua-driver', 'requires_proven_window_capture');
      capabilities.foregroundInput = { ...status('cua-driver', 'capture_bound_click_only'),
        displayActions: { type: false, key: false, scroll: false, drag: false, move: false, hover: false } };
    }
    return capabilities;
  }
  if (runtime !== 'windows') return capabilities;
  const available = (limitation: string): DesktopCapabilityStatus => ({ available: true, backend: 'win32', grant: 'required', limitation, remediation: 'Requires host authorization and a current desktop target.' });
  if (wired.capture) capabilities.capture = available('capture_reads_all_displays');
  if (wired.capture && wired.control) {
    capabilities.foregroundInput = available('requires_capture_window; no_physical_takeover_detection');
    capabilities.activate = available('requires_capture_window');
  }
  if (wired.capture && wired.control && wired.visible) {
    const visible = (limitation: string): DesktopCapabilityStatus => ({ available: true, backend: 'win32', grant: 'not-required',
      limitation, remediation: 'Requires a visible desktop run and a current captured target.' });
    capabilities.capture = visible('capture_reads_all_displays');
    capabilities.foregroundInput = visible('requires_capture_window');
    capabilities.activate = visible('requires_capture_window');
  }
  if (wired.capture && wired.semantic) {
    const semantic = (limitation: string): DesktopCapabilityStatus => ({ available: true, backend: 'cua-driver', grant: 'not-required',
      limitation, remediation: 'Requires a visible desktop run, an available driver and a current captured target.' });
    capabilities.semanticRead = semantic('bounded_tree; values_may_be_redacted');
    capabilities.semanticAct = semantic('requires_current_semantic_ref; backend_effect_may_be_unverifiable');
  }
  if (wired.windowCapture) capabilities.windowCapture = { available: true, backend: 'cua-driver', grant: 'not-required',
    limitation: 'window_capture_and_click', remediation: 'Requires the pinned Cua driver, a visible desktop run and a current window.' };
  if (capabilities.foregroundInput.available) {
    capabilities.foregroundInput.displayActions = { type: true, key: true, scroll: true, drag: true, move: true, hover: true };
  }
  return capabilities;
}
