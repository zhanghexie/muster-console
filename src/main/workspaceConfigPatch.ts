import type { AppConfig } from '../shared/types';

/** Settings writes must not bypass workspace lifecycle, revisions or removal dependencies. */
export function assertConfigWorkspaceUnchanged(current: AppConfig, patch: Partial<AppConfig>): void {
  for (const key of ['workspaces', 'activeWorkspaceId', 'workspace'] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, key)
      && JSON.stringify(patch[key]) !== JSON.stringify(current[key])) {
      throw new Error('workspace changes require the workspaces API');
    }
  }
}
