import { useLayoutEffect } from 'react';
import { workspaceAccent, workspaceAccentEnabled } from '../../shared/workspaceAccent';
import { useWorkspaceStore } from './store';
import { useWorkspaceAccentVersion } from './useWorkspaceAccents';
import { setWorkspaceAppearance } from './theme';

/** Publish before paint for both desktop and mobile; components never tint again. */
export function useWorkspaceAppearance(): void {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  const version = useWorkspaceAccentVersion();
  const enabled = workspaceAccentEnabled(activeWorkspaceId);
  useLayoutEffect(() => {
    setWorkspaceAppearance({ workspaceId: activeWorkspaceId, accent: workspaceAccent(activeWorkspaceId), enabled });
  }, [activeWorkspaceId, workspaces, version, enabled]);
}
