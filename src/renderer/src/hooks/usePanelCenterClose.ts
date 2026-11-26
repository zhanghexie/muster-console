import { useEffect, useRef } from 'react';
import { isWorkspaceFileClosePending } from '../workspaceFileClose';
import { getCenterSplitPaneRefs, samePaneRef, type SplitPaneRef } from '../../../shared/centerSplit';
import { centerSplitCloseAgentPane, getCenterSplitState } from '../centerSplitStore';
import { readFileEditorStates } from '../fileEditorState';
import { panelNavigationCurrent } from '../panelNavigationIdentity';
import { panelFilesCurrent } from '../panelFileIdentity';
import type { ExtensionNavigationSnapshot } from '../../../shared/extension';

interface Options {
  workspaceId: string | null | undefined;
  rootsRevision: number;
  switching: boolean;
  transitioning: boolean;
  settingsBlocked: boolean;
  navigation?: ExtensionNavigationSnapshot;
  primary(): SplitPaneRef;
}

/** Close only the verified pane and confirm the resulting layout without stopping a session. */
export function usePanelCenterClose(options: Options): void {
  const latest = useRef(options); latest.current = options;
  const pending = useRef<{ requestId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    const stopRequest = window.api.on('panel:close-center-request', request => {
      const view = latest.current;
      if (pending.current) { window.api.panel.replyCloseCenter(request.requestId, { ok: false, error: 'A center close is already in progress' }); return; }
      if (isWorkspaceFileClosePending(request.workspaceId) || view.workspaceId !== request.workspaceId || view.rootsRevision !== request.rootsRevision || view.switching || view.transitioning || view.settingsBlocked) {
        window.api.panel.replyCloseCenter(request.requestId, { ok: false, error: 'Requested workspace or settings are not available' }); return;
      }
      if (readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved)) {
        window.api.panel.replyCloseCenter(request.requestId, { ok: false, error: 'Cannot close a pane while the active editor has unsaved changes' }); return;
      }
      if (!panelNavigationCurrent(request.workspaceId, request.panes, request.navigation, view.navigation)) {
        window.api.panel.replyCloseCenter(request.requestId, { ok: false, error: 'Center navigation changed' }); return;
      }
      if (!panelFilesCurrent(request.workspaceId, request.panes, request.files)) {
        window.api.panel.replyCloseCenter(request.requestId, { ok: false, error: 'Center file changed' }); return;
      }
      const refs = getCenterSplitPaneRefs(view.primary(), getCenterSplitState());
      const target = refs[request.slot];
      if (!target || target.kind === 'empty' || refs.filter(ref => ref.kind !== 'empty').length < 2 ||
          !Array.isArray(request.panes) || refs.length !== request.panes.length || refs.some((ref, index) => !samePaneRef(ref, request.panes[index]))) {
        window.api.panel.replyCloseCenter(request.requestId, { ok: false, error: 'Center layout or target changed' }); return;
      }
      const expected = refs.filter((ref, index) => index !== request.slot && ref.kind !== 'empty');
      const timer = setTimeout(() => {
        if (pending.current?.requestId !== request.requestId) return;
        pending.current = null;
        window.api.panel.replyCloseCenter(request.requestId, { ok: false, outcome: 'unknown', error: 'Center close outcome is unknown; inspect before retrying' });
      }, 4000);
      const item = { requestId: request.requestId, timer }; pending.current = item;
      const current = (): boolean => {
        const now = latest.current;
        return !isWorkspaceFileClosePending(request.workspaceId) && pending.current === item && now.workspaceId === request.workspaceId && now.rootsRevision === request.rootsRevision &&
          !now.switching && !now.transitioning && !now.settingsBlocked &&
          panelNavigationCurrent(request.workspaceId, request.panes, request.navigation, now.navigation) &&
          panelFilesCurrent(request.workspaceId, request.panes, request.files) &&
          !readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved);
      };
      void centerSplitCloseAgentPane(request.slot, current).then(result => {
        if (pending.current !== item) return;
        const now = latest.current, actual = getCenterSplitPaneRefs(now.primary(), getCenterSplitState()).filter(ref => ref.kind !== 'empty');
        const confirmed = current() && result === 'applied' && actual.length === expected.length &&
          expected.every(ref => actual.some(candidate => samePaneRef(ref, candidate)));
        clearTimeout(timer); pending.current = null;
        window.api.panel.replyCloseCenter(request.requestId, confirmed ? { ok: true, target, closed: true } :
          { ok: false, outcome: 'unknown', error: 'Center close outcome is unknown; inspect before retrying' });
      }).catch(error => {
        if (pending.current !== item) return;
        clearTimeout(timer); pending.current = null;
        window.api.panel.replyCloseCenter(request.requestId, { ok: false, outcome: 'unknown', error: `Center close outcome is unknown: ${String(error)}` });
      });
    });
    const stopClosed = window.api.on('panel:close-center-closed', ({ requestId }) => {
      if (pending.current?.requestId !== requestId) return;
      clearTimeout(pending.current.timer); pending.current = null;
    });
    return () => { stopRequest(); stopClosed(); if (pending.current) clearTimeout(pending.current.timer); pending.current = null; };
  }, []);
}
