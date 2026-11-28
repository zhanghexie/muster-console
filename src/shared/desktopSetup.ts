export const DESKTOP_SETUP_PERMISSIONS = ['screenRecording', 'accessibility'] as const;
export type DesktopSetupPermission = typeof DESKTOP_SETUP_PERMISSIONS[number];

export type DesktopSetupIssue =
  | { code: 'permission_required'; permissions: DesktopSetupPermission[] }
  | { code: 'permission_check_failed' | 'capability_unsupported' | 'dependency_missing' |
      'screen_locked' | 'desktop_session_unavailable'; detail?: string };

export interface DesktopSetupStatus {
  macApp?: 'electron' | 'muster';
  issues: DesktopSetupIssue[];
}

export type DesktopSettingsOpenResult = { ok: true } |
  { ok: false; code: 'unsupported_platform' | 'invalid_permission' | 'open_failed' };
