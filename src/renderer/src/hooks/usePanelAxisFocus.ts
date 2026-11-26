import { useEffect, useRef } from 'react';
import { isWorkspaceFileClosePending } from '../workspaceFileClose';
import { readFileEditorStates } from '../fileEditorState';

type Page = 'terminal' | 'git';
interface AxisOptions {
  workspaceId: string | null | undefined;
  rootsRevision: number;
  switching: boolean;
  transitioning: boolean;
  page: Page;
  pendingPage?(): Page;
  prepare?(): void;
  virtualScreen: boolean;
  focusMode: boolean;
  narrow: boolean;
  rightDrawerOpen: boolean;
  settingsModal: boolean;
  settingsDirtyDocked?: boolean;
  closeDrawer: () => void;
  revealRight: (id: string, workspaceId: string, rootsRevision: number, stillSelected: () => boolean) => Promise<void>;
  showTerminal: () => void;
  settleTerminal: () => Promise<void>;
}

export function usePanelAxisFocus(options: AxisOptions): void {
  const latest = useRef(options); latest.current = options;
  const pending = useRef(new Map<string, { workspaceId: string; rootsRevision: number; timer: ReturnType<typeof setTimeout>; settling: boolean }>());
  const check = (): void => {
    for (const [id, item] of pending.current) {
      const view = latest.current;
      const changed = isWorkspaceFileClosePending(item.workspaceId) || item.workspaceId !== view.workspaceId || item.rootsRevision !== view.rootsRevision || view.switching || view.transitioning || view.settingsModal || view.settingsDirtyDocked;
      const reached = !changed && view.page === 'terminal' && (!view.narrow || !view.rightDrawerOpen);
      if (changed) {
        clearTimeout(item.timer); pending.current.delete(id);
        window.api.panel.replyFocusAxis(id, { ok: false, outcome: 'unknown', error: 'Workspace changed; inspect before retrying' });
      } else if (reached && !item.settling) {
        item.settling = true;
        void Promise.resolve().then(() => view.settleTerminal()).then(() => {
          if (pending.current.get(id) !== item) return;
          const now = latest.current;
          const current = !isWorkspaceFileClosePending(item.workspaceId) && item.workspaceId === now.workspaceId && item.rootsRevision === now.rootsRevision && !now.switching &&
            !now.transitioning && !now.settingsModal && !now.settingsDirtyDocked && now.page === 'terminal' && (!now.narrow || !now.rightDrawerOpen);
          clearTimeout(item.timer); pending.current.delete(id);
          window.api.panel.replyFocusAxis(id, current ? { ok: true, page: 'terminal' } :
            { ok: false, outcome: 'unknown', error: 'Page selection changed; inspect before retrying' });
        }).catch(error => {
          if (pending.current.get(id) !== item) return;
          clearTimeout(item.timer); pending.current.delete(id);
          window.api.panel.replyFocusAxis(id, { ok: false, outcome: 'unknown', error: `Page selection outcome is unknown; ${String(error)}` });
        });
      }
    }
  };
  useEffect(() => window.api.on('panel:focus-axis-request', request => {
    const view = latest.current;
    if (isWorkspaceFileClosePending(request.workspaceId) || view.workspaceId !== request.workspaceId || view.switching || view.transitioning ||
        view.rootsRevision !== request.rootsRevision || !['terminal', 'git'].includes(request.page)) {
      window.api.panel.replyFocusAxis(request.requestId, { ok: false, error: 'Requested workspace, roots or page are invalid' });
      return;
    }
    if (view.settingsModal) {
      window.api.panel.replyFocusAxis(request.requestId, { ok: false, error: 'Cannot switch pages while the settings dialog is open' }); return;
    }
    if (view.settingsDirtyDocked) {
      window.api.panel.replyFocusAxis(request.requestId, { ok: false, error: 'Cannot switch pages while docked settings have unsaved changes' }); return;
    }
    try {
      if (request.page === 'git') {
        void view.revealRight(request.requestId, request.workspaceId, request.rootsRevision, () => !isWorkspaceFileClosePending(request.workspaceId)).then(() => {
          window.api.panel.replyFocusAxis(request.requestId, { ok: true, page: 'git' });
        }).catch(error => {
          window.api.panel.replyFocusAxis(request.requestId, { ok: false, outcome: 'unknown', error: error instanceof Error ? error.message : String(error) });
        });
        return;
      }
      const pendingAway = view.pendingPage && view.pendingPage() !== 'terminal';
      const needsChange = view.page !== 'terminal' || !!pendingAway || view.narrow && view.rightDrawerOpen;
      if (needsChange && readFileEditorStates(request.workspaceId).some(editor => editor.active && editor.unsaved)) {
        throw new Error('Cannot switch pages while the active editor has unsaved changes');
      }
      view.prepare?.();
      const timer = setTimeout(() => {
        pending.current.delete(request.requestId);
        window.api.panel.replyFocusAxis(request.requestId, { ok: false, outcome: 'unknown', error: 'Page selection outcome is unknown; inspect before retrying' });
      }, 4000);
      pending.current.set(request.requestId, { workspaceId: request.workspaceId, rootsRevision: request.rootsRevision, timer, settling: false });
      if (view.narrow && view.rightDrawerOpen) view.closeDrawer();
      if (view.page !== 'terminal' || pendingAway) view.showTerminal();
      if (view.page === 'terminal' && (!view.narrow || !view.rightDrawerOpen)) queueMicrotask(check);
    } catch (error) {
      const item = pending.current.get(request.requestId);
      if (item) { clearTimeout(item.timer); pending.current.delete(request.requestId); }
      window.api.panel.replyFocusAxis(request.requestId, { ok: false, error: error instanceof Error ? error.message : String(error),
        ...(item ? { outcome: 'unknown' as const } : {}) });
    }
  }), []);
  useEffect(() => window.api.on('panel:focus-axis-closed', ({ requestId }) => {
    const item = pending.current.get(requestId); if (!item) return;
    clearTimeout(item.timer); pending.current.delete(requestId);
  }), []);
  useEffect(() => {
    check();
  }, [options.workspaceId, options.rootsRevision, options.switching, options.transitioning, options.page, options.virtualScreen, options.focusMode, options.narrow, options.rightDrawerOpen, options.settingsModal, options.settingsDirtyDocked]);
  useEffect(() => () => { for (const item of pending.current.values()) clearTimeout(item.timer); pending.current.clear(); }, []);
}
