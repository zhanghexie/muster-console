import { useEffect, useRef } from 'react';
import { isWorkspaceFileClosePending } from '../workspaceFileClose';
import type { SplitPaneRef, CenterPaneSlot } from '../../../shared/centerSplit';
import type { ExtensionNavigationSnapshot } from '../../../shared/extension';
import { panelNavigationCurrent } from '../panelNavigationIdentity';
import { panelFilesCurrent } from '../panelFileIdentity';

interface State {
  workspaceId: string | null;
  rootsRevision: number;
  switching: boolean;
  transitioning: boolean;
  visible: boolean;
  navigation: ExtensionNavigationSnapshot;
  canFocus(target: Exclude<SplitPaneRef, { kind: 'empty' }>): boolean;
  focus(target: Exclude<SplitPaneRef, { kind: 'empty' }>, isCurrent: () => boolean): CenterPaneSlot | Promise<CenterPaneSlot>;
}

export function usePanelCenterFocus(read: () => State): void {
  const latest = useRef(read); latest.current = read;
  const pending = useRef(new Map<string, object>());
  useEffect(() => window.api.on('panel:focus-center-request', request => {
    const state = latest.current();
    if (isWorkspaceFileClosePending(request.workspaceId) || state.workspaceId !== request.workspaceId || state.switching || state.transitioning || state.rootsRevision !== request.rootsRevision) {
      window.api.panel.replyFocusCenter(request.requestId, { ok: false, error: 'Requested workspace or roots are no longer current' });
      return;
    }
    try {
      if (!request.target || (request.target.kind !== 'session' && request.target.kind !== 'utility')) throw new Error('Invalid center target');
      if (!state.visible || !state.canFocus(request.target)) throw new Error('Center target is not safely visible; inspect the panel before focusing');
      if (!panelFilesCurrent(request.workspaceId, [request.target], request.file ? [request.file] : undefined)) throw new Error('Center file changed');
      if (request.target.kind === 'utility' && request.target.sel.startsWith('nav:')) {
        const bindings = request.navigation ? [{ ...request.navigation, sel: request.target.sel }] : undefined;
        if (!panelNavigationCurrent(request.workspaceId, [request.target], bindings, state.navigation)) {
          throw new Error('Center navigation changed');
        }
      }
      const target = request.target, token = {};
      pending.current.set(request.requestId, token);
      const pendingCurrent = (): boolean => pending.current.get(request.requestId) === token;
      const current = (): boolean => !isWorkspaceFileClosePending(request.workspaceId) && pendingCurrent() && panelFilesCurrent(request.workspaceId, [target], request.file ? [request.file] : undefined);
      const finish = (slot: CenterPaneSlot): void => {
        if (!pendingCurrent()) return;
        pending.current.delete(request.requestId);
        const now = latest.current();
        const navigation = target.kind === 'utility' && target.sel.startsWith('nav:')
          ? panelNavigationCurrent(request.workspaceId, [target], request.navigation ? [{ ...request.navigation, sel: target.sel }] : undefined, now.navigation) : true;
        if (isWorkspaceFileClosePending(request.workspaceId) || now.workspaceId !== request.workspaceId || now.rootsRevision !== request.rootsRevision || now.switching || now.transitioning || !now.visible || !now.canFocus(target) || !navigation ||
            !panelFilesCurrent(request.workspaceId, [target], request.file ? [request.file] : undefined)) {
          window.api.panel.replyFocusCenter(request.requestId, { ok: false, outcome: 'unknown', error: 'Center target changed; inspect the panel before retrying' });
          return;
        }
        window.api.panel.replyFocusCenter(request.requestId, { ok: true, target, slot });
      };
      const fail = (error: unknown): void => {
        if (!pendingCurrent()) return;
        pending.current.delete(request.requestId);
        window.api.panel.replyFocusCenter(request.requestId, { ok: false, outcome: 'unknown', error: error instanceof Error ? error.message : String(error) });
      };
      const result = state.focus(target, current);
      if (typeof result === 'number') finish(result); else void result.then(finish, fail);
    } catch (error) {
      pending.current.delete(request.requestId);
      const message = error instanceof Error ? error.message : String(error);
      window.api.panel.replyFocusCenter(request.requestId, { ok: false, error: message,
        ...(message.includes('outcome is unknown') ? { outcome: 'unknown' as const } : {}) });
    }
  }), []);
  useEffect(() => window.api.on('panel:focus-center-closed', ({ requestId }) => { pending.current.delete(requestId); }), []);
  useEffect(() => () => { pending.current.clear(); }, []);
}
