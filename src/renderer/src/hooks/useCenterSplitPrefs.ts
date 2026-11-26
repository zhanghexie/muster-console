import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceFileConfig } from '../../../shared/metaAgent';
import type { SplitDir } from '../../../shared/centerSplit';
import type { WorkspaceFilePatchOutcome } from './useWorkspaceFile';

type SplitPrefs = { dir?: SplitDir; ratio?: number };
type Patch = (partial: Partial<WorkspaceFileConfig>, workspaceId: string) => Promise<WorkspaceFilePatchOutcome>;
type Pending = { workspaceId: string; values: Partial<WorkspaceFileConfig> };

/** Debounced split preferences belong to the workspace where they were changed.
 * Switching or reloading cancels an old pending write; it never migrates to the next workspace.
 */
export function useCenterSplitPrefs(
  workspaceId: string | null, ready: boolean, patch: Patch, onError: (error: unknown) => void
): (prefs: SplitPrefs) => void {
  const { t } = useTranslation();
  const owner = useRef({ workspaceId, ready, patch, onError, t });
  owner.current = { workspaceId, ready, patch, onError, t };
  const pending = useRef<Pending | null>(null);
  const timer = useRef<number | null>(null);
  const generation = useRef(0);
  const cancel = useCallback((): void => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }, []);
  useLayoutEffect(() => { generation.current++; cancel(); }, [workspaceId, ready, cancel]);
  useEffect(() => () => { generation.current++; cancel(); }, [cancel]);

  return useCallback((prefs: SplitPrefs): void => {
    const current = owner.current;
    if (!current.ready || !current.workspaceId) return;
    const values: Partial<WorkspaceFileConfig> = {
      ...(prefs.dir ? { centerSplitDir: prefs.dir } : {}),
      ...(prefs.ratio != null ? { centerSplitRatio: prefs.ratio } : {})
    };
    if (!Object.keys(values).length) return;
    pending.current = {
      workspaceId: current.workspaceId,
      values: { ...(pending.current?.workspaceId === current.workspaceId ? pending.current.values : {}), ...values }
    };
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const write = pending.current;
      pending.current = null;
      const latest = owner.current;
      if (!write || !latest.ready || latest.workspaceId !== write.workspaceId) return;
      const version = generation.current;
      const report = (error: unknown): void => {
        if (generation.current === version && owner.current.ready && owner.current.workspaceId === write.workspaceId) owner.current.onError(error);
      };
      void latest.patch(write.values, write.workspaceId).then(result => {
        if (!result.ok && result.reason !== 'not-ready' && result.reason !== 'stale-owner') report(new Error(latest.t('分屏偏好保存失败')));
      }).catch(report);
    }, 400);
  }, []);
}
