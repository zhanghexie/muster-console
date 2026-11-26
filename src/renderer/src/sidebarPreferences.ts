import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react';

export type SidebarSection = 'utilities' | 'sessions' | 'terminals' | 'workspaces';
const WIDTH_KEY = 'muster.leftColumnWidth.v1';
const LEGACY_WORKSPACE_STACK_KEY = 'muster.wsStackCollapsed.v1';
const subscribers = new Set<() => void>();
const volatile = new Map<string, boolean>();
export const sidebarCollapsedKey = (workspaceId: string, section: SidebarSection): string =>
  `muster.sidebarCollapsed.v1:${encodeURIComponent(workspaceId)}:${section}`;

function readCollapsed(workspaceId: string | null, section: SidebarSection): boolean {
  if (!workspaceId) return false;
  const key = sidebarCollapsedKey(workspaceId, section);
  if (volatile.has(key)) return volatile.get(key)!;
  try {
    const value = localStorage.getItem(key);
    if (value === '1') return true;
    if (value === '0') return false;
    return section === 'workspaces' && localStorage.getItem(LEGACY_WORKSPACE_STACK_KEY) === '1';
  } catch { return false; }
}
function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  window.addEventListener('storage', listener);
  return () => { subscribers.delete(listener); window.removeEventListener('storage', listener); };
}

/** Workspace changes read their own snapshot immediately, without a hydration write-back race. */
export function useWorkspaceSidebarCollapsed(workspaceId: string | null, section: SidebarSection):
  [boolean, (next: SetStateAction<boolean>) => void] {
  const snapshot = useCallback(() => readCollapsed(workspaceId, section), [workspaceId, section]);
  const collapsed = useSyncExternalStore(subscribe, snapshot, () => false);
  const setCollapsed = useCallback((next: SetStateAction<boolean>) => {
    if (!workspaceId) return;
    const value = typeof next === 'function' ? next(readCollapsed(workspaceId, section)) : next;
    const key = sidebarCollapsedKey(workspaceId, section);
    try { localStorage.setItem(key, value ? '1' : '0'); volatile.delete(key); }
    catch { volatile.set(key, value); }
    subscribers.forEach(listener => listener());
  }, [workspaceId, section]);
  return [collapsed, setCollapsed];
}

export function loadSidebarWidth(): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw == null) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width > 0 ? Math.round(width) : null;
  } catch { return null; }
}
function saveSidebarWidth(width: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(width))); } catch { /* keep live state */ }
}

/** Global width: migrate the first ready workspace once, and persist only on drag completion. */
export function useGlobalSidebarWidth(legacyWidth: number | undefined, workspaceReady: boolean) {
  const [width, setWidth] = useState<number | null>(loadSidebarWidth);
  const migrated = useRef(width != null);
  useEffect(() => {
    if (!workspaceReady || migrated.current) return;
    migrated.current = true;
    if (typeof legacyWidth === 'number' && Number.isFinite(legacyWidth) && legacyWidth > 0) {
      const value = Math.round(legacyWidth);
      setWidth(value);
      saveSidebarWidth(value);
    }
  }, [workspaceReady, legacyWidth]);
  const updateWidth = useCallback((value: SetStateAction<number | null>) => { migrated.current = true; setWidth(value); }, []);
  const commit = useCallback((value: number) => { migrated.current = true; setWidth(value); saveSidebarWidth(value); }, []);
  return { width, setWidth: updateWidth, commit };
}
