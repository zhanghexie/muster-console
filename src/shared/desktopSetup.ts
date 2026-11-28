export const DESKTOP_SETUP_PERMISSIONS = ['screenRecording', 'accessibility'] as const;
export type DesktopSetupPermission = typeof DESKTOP_SETUP_PERMISSIONS[number];
export type DesktopPermissionSource = 'host' | 'driver';

export type DesktopSetupIssue =
  | { code: 'permission_required'; permissions: DesktopSetupPermission[]; source?: DesktopPermissionSource }
  | { code: 'permission_check_failed'; detail?: string; source?: DesktopPermissionSource }
  | { code: 'capability_unsupported' | 'dependency_missing' |
      'screen_locked' | 'desktop_session_unavailable' | 'secure_input_active'; detail?: string };

export interface DesktopSetupStatus {
  macApp?: 'electron' | 'muster';
  issues: DesktopSetupIssue[];
}

export type DesktopSettingsOpenResult = { ok: true } |
  { ok: false; code: 'unsupported_platform' | 'invalid_permission' | 'open_failed' };

export type DesktopPermissionRequestResult = { ok: true; granted: boolean } |
  { ok: false; code: 'unsupported_platform' | 'invalid_permission' | 'request_in_progress' | 'request_failed' };

export type DesktopAppRevealResult = { ok: true } |
  { ok: false; code: 'unsupported_platform' | 'reveal_failed' };
