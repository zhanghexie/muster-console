import type { WorkbenchTheme } from './theme';

export interface DesktopIndicatorSnapshot {
  revision: number;
  state: 'active' | 'stopping' | 'unknown';
  theme?: WorkbenchTheme;
  target?: string;
  escapeAvailable: boolean;
  labels: { active: string; stopping: string; unknown: string; escape: string; stop: string; escapeUnavailable: string };
}
