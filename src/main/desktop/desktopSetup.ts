import type { AppContext } from '../context';
import { DESKTOP_SETUP_PERMISSIONS, type DesktopSettingsOpenResult, type DesktopSetupIssue,
  type DesktopSetupPermission, type DesktopSetupStatus } from '../../shared/desktopSetup';
import { CuaDriverUnavailableError } from './cuaDriverPath';
import { unavailableDesktopCapabilities, type DesktopRuntime } from './runtime';

const permissionSettings: Record<DesktopSetupPermission, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
};

export async function openDesktopPermissionSettings(platform: NodeJS.Platform, permission: unknown,
  openExternal: (url: string) => Promise<void>): Promise<DesktopSettingsOpenResult> {
  if (platform !== 'darwin') return { ok: false, code: 'unsupported_platform' };
  if (permission !== 'screenRecording' && permission !== 'accessibility') return { ok: false, code: 'invalid_permission' };
  try {
    await openExternal(permissionSettings[permission]);
    return { ok: true };
  } catch (error) {
    console.error('[desktop setup] could not open System Settings:', error);
    return { ok: false, code: 'open_failed' };
  }
}

export function desktopSetupMacApp(isPackaged: boolean): NonNullable<DesktopSetupStatus['macApp']> {
  return isPackaged ? 'muster' : 'electron';
}

export type DesktopSetupHost = Pick<AppContext, 'desktopScreen' | 'desktopTurns' | 'desktopWindowList' |
  'desktopSemanticControl' | 'desktopUnavailableReason'> & {
    desktopMac?: Pick<NonNullable<AppContext['desktopMac']>, 'status' | 'checkDriverPermissions'>;
  };

/** Read current host and driver state without capturing pixels or requesting OS permission. */
export async function readDesktopSetup(ctx: DesktopSetupHost, runtime: DesktopRuntime, isPackaged: boolean,
  resolveDriver: () => string): Promise<DesktopSetupStatus> {
  const mac = runtime === 'macos';
  const issues: DesktopSetupIssue[] = [];
  const result = { ...(mac ? { macApp: desktopSetupMacApp(isPackaged) } : {}), issues };
  if (!ctx.desktopScreen || !ctx.desktopTurns || !ctx.desktopWindowList || !ctx.desktopSemanticControl ||
      (mac && !ctx.desktopMac)) {
    issues.push({ code: 'capability_unsupported', detail: ctx.desktopUnavailableReason ??
      unavailableDesktopCapabilities(runtime).capture.remediation });
    return result;
  }
  if (!mac) {
    try { resolveDriver(); }
    catch (error) { issues.push({ code: 'dependency_missing', detail: error instanceof Error ? error.message : undefined }); }
    return result;
  }

  const host = ctx.desktopMac!;
  const status = host.status();
  if (status.driverError) issues.push({ code: 'dependency_missing', detail: status.driverError });
  if (status.targetError) issues.push({ code: 'capability_unsupported', detail: status.targetError });
  if (status.screenLocked) issues.push({ code: 'screen_locked' });
  if (status.sessionError) issues.push({ code: 'desktop_session_unavailable', detail: status.sessionError });
  const permissions = status.permissions;
  if (!permissions) issues.push({ code: 'permission_check_failed', detail: status.permissionError });
  else {
    let missing = DESKTOP_SETUP_PERMISSIONS.filter(permission => !permissions[permission]);
    // As in the operation path, first check the host. The embedded driver may
    // still reject a grant that the host can already see.
    if (!missing.length && !issues.length) {
      try {
        const driverPermissions = await host.checkDriverPermissions();
        missing = DESKTOP_SETUP_PERMISSIONS.filter(permission => !driverPermissions[permission]);
      } catch (error) {
        console.error('[desktop setup] could not check Cua permissions:', error);
        if (error instanceof CuaDriverUnavailableError) issues.push({ code: error.code, detail: error.message });
        else issues.push({ code: 'permission_check_failed' });
      }
    }
    if (missing.length) issues.push({ code: 'permission_required', permissions: missing });
  }
  return result;
}

/** Only project known host outcomes; metadata capability hints do not trigger the card. */
export function desktopSetupIssue(result: unknown, platform: NodeJS.Platform): DesktopSetupIssue | undefined {
  if (!result || typeof result !== 'object') return;
  const output = result as { ok?: unknown; code?: unknown; message?: unknown; permissions?: unknown; windowsCode?: unknown };
  const mac = platform === 'darwin';
  if (output.ok !== false) {
    // A display screenshot can succeed while its optional window selections lack AX access.
    if (mac && output.windowsCode === 'permission_required') return { code: 'permission_required', permissions: ['accessibility'] };
    return;
  }
  const detail = typeof output.message === 'string' ? output.message.slice(0, 500) : undefined;
  switch (output.code) {
    case 'permission_required': {
      if (!mac) return;
      const reported = Array.isArray(output.permissions) ? output.permissions : [];
      const permissions = DESKTOP_SETUP_PERMISSIONS.filter(permission => reported.includes(permission));
      if (permissions.length) return { code: 'permission_required', permissions };
      return { code: 'permission_check_failed' };
    }
    case 'permission_check_failed':
    case 'screen_locked':
    case 'desktop_session_unavailable':
      if (mac) return { code: output.code, detail };
      return;
    case 'capability_unsupported':
    case 'dependency_missing':
      return { code: output.code, detail };
  }
}
