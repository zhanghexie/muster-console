import { useEffect, useRef } from 'react';
import { isWorkspaceFileClosePending } from '../workspaceFileClose';
import { getCenterSplitPaneRefs, samePaneRef, type SplitPaneRef } from '../../../shared/centerSplit';
import { centerSplitApplyAgentLayout, getCenterSplitState, useCenterSplit } from '../centerSplitStore';
import { readFileEditorStates } from '../fileEditorState';
import { panelNavigationCurrent } from '../panelNavigationIdentity';
import { panelFilesCurrent } from '../panelFileIdentity';
import type { ExtensionNavigationSnapshot } from '../../../shared/extension';
import type { CenterFileBinding, CenterNavigationBinding } from '../../../shared/panelState';

interface SplitOptions {
  workspaceId: string | null | undefined;
  rootsRevision: number;
  switching: boolean;
  transitioning: boolean;
  page: 'terminal' | 'git';
  virtualScreen: boolean;
  focusMode: boolean;
  navigation?: ExtensionNavigationSnapshot;
  primary: () => SplitPaneRef;
  ensureWorkspaceVisible: () => void;
  targetsVisible?: (panes: readonly SplitPaneRef[]) => boolean;
}

export function usePanelSplit(options: SplitOptions): void {
  const latest = useRef(options); latest.current = options;
  const split = useCenterSplit();
  const pending = useRef<{ requestId: string; workspaceId: string; rootsRevision: number;
    panes: Exclude<SplitPaneRef, { kind: 'empty' }>[]; layoutId: NonNullable<typeof split.layoutId>;
    navigation?: CenterNavigationBinding[]; files?: CenterFileBinding[];
    phase: 'layout' | 'visible'; timer: ReturnType<typeof setTimeout> } | null>(null);
  const check = (): void => {
    const item = pending.current, view = latest.current;
    if (!item || item.phase !== 'visible') return;
    const changed = isWorkspaceFileClosePending(item.workspaceId) || view.workspaceId !== item.workspaceId || view.rootsRevision !== item.rootsRevision || view.switching || view.transitioning ||
      !panelNavigationCurrent(item.workspaceId, item.panes, item.navigation, view.navigation) || !panelFilesCurrent(item.workspaceId, item.panes, item.files);
    const state = getCenterSplitState();
    const actual = getCenterSplitPaneRefs(view.primary(), state);
    const matches = state.open && !state.pendingLayout && state.layoutId === item.layoutId &&
      actual.length === item.panes.length && actual.every((ref, index) => samePaneRef(ref, item.panes[index]));
    const visible = !view.virtualScreen || view.focusMode || view.page === 'terminal';
    if (!changed && matches && (!visible || (view.targetsVisible && !view.targetsVisible(item.panes)))) return;
    clearTimeout(item.timer); pending.current = null;
    window.api.panel.replySplit(item.requestId, changed || !matches
      ? { ok: false, outcome: 'unknown', error: 'Layout or workspace changed; inspect before retrying' }
      : { ok: true, panes: item.panes, layoutId: item.layoutId });
  };
  const checkRef = useRef(check); checkRef.current = check;
  useEffect(() => window.api.on('panel:split-request', request => {
    const view = latest.current;
    if (pending.current) { window.api.panel.replySplit(request.requestId, { ok: false, error: 'A panel split is already in progress' }); return; }
    if (isWorkspaceFileClosePending(request.workspaceId) || view.workspaceId !== request.workspaceId || view.rootsRevision !== request.rootsRevision || view.switching || view.transitioning) {
      window.api.panel.replySplit(request.requestId, { ok: false, error: 'Requested workspace or roots are no longer current' }); return;
    }
    if (!panelNavigationCurrent(request.workspaceId, request.panes, request.navigation, view.navigation)) {
      window.api.panel.replySplit(request.requestId, { ok: false, error: 'Center navigation changed' }); return;
    }
    if (!panelFilesCurrent(request.workspaceId, request.panes, request.files)) {
      window.api.panel.replySplit(request.requestId, { ok: false, error: 'Center file changed' }); return;
    }
    if (readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved)) {
      window.api.panel.replySplit(request.requestId, { ok: false, error: 'Cannot split while the active editor has unsaved changes' }); return;
    }
    const timer = setTimeout(() => {
      if (pending.current?.requestId !== request.requestId) return;
      pending.current = null;
      window.api.panel.replySplit(request.requestId, { ok: false, outcome: 'unknown', error: 'Panel split outcome is unknown; inspect before retrying' });
    }, 4000);
    pending.current = { requestId: request.requestId, workspaceId: request.workspaceId, rootsRevision: request.rootsRevision,
      panes: request.panes, navigation: request.navigation, files: request.files, layoutId: request.layoutId, phase: 'layout', timer };
    const canCommit = (): boolean => {
      const current = latest.current;
      return !isWorkspaceFileClosePending(request.workspaceId) && pending.current?.requestId === request.requestId && current.workspaceId === request.workspaceId &&
        current.rootsRevision === request.rootsRevision && !current.switching && !current.transitioning &&
        panelNavigationCurrent(request.workspaceId, request.panes, request.navigation, current.navigation) &&
        panelFilesCurrent(request.workspaceId, request.panes, request.files) &&
        !readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved);
    };
    void centerSplitApplyAgentLayout(request.workspaceId, request.panes, request.layoutId, canCommit).then(result => {
      const item = pending.current;
      if (!item || item.requestId !== request.requestId) return;
      if (result !== 'applied') {
        clearTimeout(item.timer); pending.current = null;
        window.api.panel.replySplit(request.requestId, { ok: false, outcome: 'unknown', error: `Panel split ${result}; inspect before retrying` });
        return;
      }
      item.phase = 'visible';
      checkRef.current();
      if (pending.current === item) { latest.current.ensureWorkspaceVisible(); checkRef.current(); }
    }).catch(error => {
      const item = pending.current;
      if (!item || item.requestId !== request.requestId) return;
      clearTimeout(item.timer); pending.current = null;
      window.api.panel.replySplit(request.requestId, { ok: false, outcome: 'unknown', error: `${error instanceof Error ? error.message : String(error)}; inspect before retrying` });
    });
  }), []);
  useEffect(() => { checkRef.current(); }, [split, options.workspaceId, options.rootsRevision, options.switching,
    options.transitioning, options.page, options.virtualScreen, options.focusMode, options.navigation, options.targetsVisible]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current.timer); pending.current = null; }, []);
}
