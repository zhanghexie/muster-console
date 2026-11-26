import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { SplitPaneRef } from '../../../shared/centerSplit';
import { t } from '../../../shared/i18n';
import { createCenterSplitSelectionGuard } from '../centerSplitSelectionGuard';
import { jumpToSession } from '../sessionJump';

interface SelectionOptions<T extends string> {
  workspaceId: string | null;
  setUtilityPanel: (selection: T | null) => void;
  ensureWorkspaceVisible: () => void;
  revealSession: () => void;
  reportError: (error: unknown) => void;
}

/** App's real bridge selection/reveal path, shared with component regression tests. */
export function useCenterSplitSelection<T extends string>(options: SelectionOptions<T>) {
  const latest = useRef(options);
  latest.current = options;
  const utilityRevision = useRef(0);
  const guard = useRef(createCenterSplitSelectionGuard());

  const setUtilityPanel = useCallback((selection: T | null): void => {
    // A user selection invalidates in-flight requests before React commits it.
    utilityRevision.current++;
    guard.current.invalidate();
    latest.current.setUtilityPanel(selection);
  }, []);

  useLayoutEffect(() => { guard.current.invalidate(); }, [options.workspaceId]);
  useEffect(() => {
    const stop = window.api.on('sessions:reveal', payload => {
      if (!guard.current.shouldHandleReveal(payload.sessionId, {
        workspaceId: latest.current.workspaceId, utilityRevision: utilityRevision.current
      })) return;
      const deferReveal = guard.current.shouldDeferReveal(payload.sessionId, {
        workspaceId: latest.current.workspaceId, utilityRevision: utilityRevision.current
      });
      setUtilityPanel(null);
      if (!deferReveal) latest.current.revealSession();
    });
    return () => { stop(); guard.current.invalidate(); };
  }, [setUtilityPanel]);

  const selectRef = useCallback((ref: SplitPaneRef, selectionOptions?: { deferReveal?: boolean }): void | Promise<void> => {
    const current = latest.current;
    if (ref.kind === 'session') {
      if (!selectionOptions?.deferReveal) current.ensureWorkspaceVisible();
      const request = guard.current.begin(ref.sessionId, {
        workspaceId: current.workspaceId, utilityRevision: utilityRevision.current
      }, selectionOptions?.deferReveal);
      return jumpToSession({ sessionId: ref.sessionId }).then(result => {
        if (!result.ok) throw new Error(result.message ?? t('操作失败'));
        // Main normally emits reveal first; successful selection also has a
        // guarded fallback so a missing reveal listener does not leave the tool.
        if (guard.current.isCurrent(request, {
          workspaceId: latest.current.workspaceId, utilityRevision: utilityRevision.current
        })) setUtilityPanel(null);
      }).catch(error => {
        current.reportError(error);
        throw error;
      }).finally(() => guard.current.finish(request));
    }
    if (ref.kind === 'utility') {
      if (!selectionOptions?.deferReveal) current.ensureWorkspaceVisible();
      setUtilityPanel(ref.sel as T);
    } else setUtilityPanel(null);
  }, [setUtilityPanel]);

  return { setUtilityPanel, selectRef };
}
