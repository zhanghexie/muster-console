import { parseHDock, type HDockPage } from '../../shared/workspaceUiPersist';

export const virtualScreenPageKey = (workspaceId: string): string =>
  `muster.virtualScreenPage.v1:${encodeURIComponent(workspaceId)}`;

const unsavedPages = new Map<string, HDockPage>();

export function loadVirtualScreenPage(workspaceId: string | null, legacy: unknown): HDockPage {
  if (workspaceId) {
    const pending = unsavedPages.get(workspaceId);
    if (pending) return pending;
    try {
      const value = localStorage.getItem(virtualScreenPageKey(workspaceId));
      if (value === 'left') return 'terminal';
      if (value === 'right') return 'git';
    } catch { /* fall back to the legacy workspace preference */ }
  }
  return parseHDock(legacy);
}

export function saveVirtualScreenPage(workspaceId: string, dock: HDockPage): boolean {
  try {
    const key = virtualScreenPageKey(workspaceId);
    const value = dock === 'git' ? 'right' : 'left';
    if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
    unsavedPages.delete(workspaceId);
    return true;
  } catch {
    unsavedPages.set(workspaceId, dock);
    return false;
  }
}
