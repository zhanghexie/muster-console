import { useCallback, useEffect, useRef } from 'react';
import { readFileEditorStates } from '../fileEditorState';

interface Options {
  workspaceId: string | null | undefined;
  rootsRevision: number;
  switching: boolean;
  transitioning: boolean;
  narrow: boolean;
  rightDrawerOpen: boolean;
  focusMode: boolean;
  settingsBlocked: boolean;
  virtualScreen: boolean;
  page: 'terminal' | 'git';
  pendingPage?(): 'terminal' | 'git';
  prepare?(): void;
  openDrawer(): void;
  showGit(): void;
  enableGit(): void;
  settle(): Promise<void>;
}

const isVisible = (view: Options): boolean => view.narrow ? view.rightDrawerOpen && view.page === 'git'
  : view.focusMode || view.virtualScreen && view.page === 'git';

/** Resolve only when the right workspace is actually foreground, including narrow drawers. */
export function usePanelRightReveal(options: Options): (id: string, workspaceId: string, rootsRevision: number, stillSelected: () => boolean) => Promise<void> {
  const latest = useRef(options); latest.current = options;
  const pending = useRef(new Map<string, { workspaceId: string; rootsRevision: number; stillSelected: () => boolean;
    resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; settling: boolean }>());
  const check = (): void => {
    for (const [id, item] of pending.current) {
      const view = latest.current;
      let selected = false;
      try { selected = item.stillSelected(); } catch { /* A missing surface is not confirmation. */ }
      const changed = view.workspaceId !== item.workspaceId || view.rootsRevision !== item.rootsRevision || view.switching || view.transitioning || view.settingsBlocked || !selected;
      if (changed) {
        clearTimeout(item.timer); pending.current.delete(id);
        item.reject(new Error('Panel focus outcome is unknown; workspace or target changed'));
      } else if (item.settling && !isVisible(view) && !(!view.narrow && !view.focusMode && view.virtualScreen && view.pendingPage?.() === 'git')) {
        clearTimeout(item.timer); pending.current.delete(id);
        item.reject(new Error('Panel focus outcome is unknown; workspace visibility changed'));
      } else if (isVisible(view) && !item.settling) {
        item.settling = true;
        void Promise.resolve().then(() => view.settle()).then(() => {
          if (pending.current.get(id) !== item) return;
          const now = latest.current;
          let current = false;
          try { current = item.stillSelected(); } catch { /* Fail closed. */ }
          clearTimeout(item.timer); pending.current.delete(id);
          if (now.workspaceId !== item.workspaceId || now.rootsRevision !== item.rootsRevision || now.switching || now.transitioning || now.settingsBlocked || !isVisible(now) || (!now.focusMode && now.pendingPage && now.pendingPage() !== 'git') || !current) {
            const reason = now.workspaceId !== item.workspaceId ? 'workspace' : now.rootsRevision !== item.rootsRevision ? 'roots' :
              now.switching || now.transitioning ? 'workspace transition' : now.settingsBlocked ? 'settings' : !isVisible(now) ? 'visibility' :
                !now.focusMode && now.pendingPage && now.pendingPage() !== 'git' ? 'page intent' : 'target';
            item.reject(new Error(`Panel focus outcome is unknown; workspace or target changed (${reason})`));
          } else item.resolve();
        }).catch(error => {
          if (pending.current.get(id) !== item) return;
          clearTimeout(item.timer); pending.current.delete(id);
          item.reject(new Error(`Panel focus outcome is unknown; ${String(error)}`));
        });
      }
    }
  };
  const reveal = useCallback((id: string, workspaceId: string, rootsRevision: number, stillSelected: () => boolean): Promise<void> => {
    const view = latest.current;
    if (view.workspaceId !== workspaceId || view.rootsRevision !== rootsRevision || view.switching || view.transitioning || view.settingsBlocked || !stillSelected()) {
      return Promise.reject(new Error('Panel focus outcome is unknown; workspace or target changed'));
    }
    const pendingAway = (view.narrow || !view.focusMode) && view.pendingPage && view.pendingPage() !== 'git';
    if ((!isVisible(view) || pendingAway) && readFileEditorStates(workspaceId).some(editor => editor.active && editor.unsaved)) {
      return Promise.reject(new Error('Panel focus outcome is unknown; active editor has unsaved changes'));
    }
    if (pending.current.has(id)) return Promise.reject(new Error('Panel focus outcome is unknown; request is already pending'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.current.delete(id); reject(new Error('Panel focus outcome is unknown; right workspace did not become visible')); }, 4000);
      pending.current.set(id, { workspaceId, rootsRevision, stillSelected, resolve, reject, timer, settling: false });
      try {
        view.prepare?.();
        if (isVisible(view) && !pendingAway) queueMicrotask(check);
        else if (view.narrow) view.openDrawer();
        else if (!view.virtualScreen && !view.focusMode) view.enableGit();
        else view.showGit();
        if (pendingAway) queueMicrotask(check);
      } catch (error) {
        clearTimeout(timer); pending.current.delete(id);
        reject(new Error(`Panel focus outcome is unknown; ${String(error)}`));
      }
    });
  }, []);
  useEffect(() => {
    check();
  }, [options.workspaceId, options.rootsRevision, options.switching, options.transitioning, options.narrow,
    options.rightDrawerOpen, options.focusMode, options.virtualScreen, options.page, options.settingsBlocked]);
  useEffect(() => {
    const cancel = ({ requestId }: { requestId: string }): void => {
      const item = pending.current.get(requestId); if (!item) return;
      clearTimeout(item.timer); pending.current.delete(requestId);
      item.reject(new Error('Panel focus outcome is unknown; request was closed'));
    };
    const offOpen = window.api.on('panel:open-content-closed', cancel);
    const offFocus = window.api.on('panel:focus-tab-closed', cancel);
    const offAxis = window.api.on('panel:focus-axis-closed', cancel);
    const offLayout = window.api.on('panel:right-layout-closed', cancel);
    return () => {
      offOpen(); offFocus(); offAxis(); offLayout();
      for (const item of pending.current.values()) { clearTimeout(item.timer); item.reject(new Error('Panel focus outcome is unknown; window closed')); }
      pending.current.clear();
    };
  }, []);
  return reveal;
}
