import type { SplitPaneRef } from '../../shared/centerSplit';
import type { ExtensionNavigationNode } from '../../shared/extensionNavigation';
import type { SessionMeta } from '../../shared/types';

type SplitSession = Pick<SessionMeta, 'id' | 'type'>;
export interface CenterSplitSources {
  sessions: readonly SplitSession[];
  navigation: readonly ExtensionNavigationNode[];
  /** Already validated file backing IDs from the active workspace and session. */
  centerFileIds?: readonly string[];
}

/** Both CLI terminals and GUI chat use terminal sessions; scheduled ServiceView does not. */
export function isCenterSplitSession<T extends Pick<SessionMeta, 'type'>>(
  session: T | null | undefined
): session is T & { type: 'terminal' } {
  return session?.type === 'terminal';
}

/** Empty slots are legal. Other references must resolve to a central view the app can render. */
export function supportsCenterSplitRef(ref: SplitPaneRef, sources: CenterSplitSources): boolean {
  if (ref.kind === 'empty') return true;
  if (ref.kind === 'session') return isCenterSplitSession(sources.sessions.find(session => session.id === ref.sessionId));
  if (['tasks', 'usage', 'memory', 'ext-manager', 'settings'].includes(ref.sel)) return true;
  if (ref.sel.startsWith('center-file:')) return !!ref.sel.slice(12) && !!sources.centerFileIds?.includes(ref.sel.slice(12));
  if (ref.sel.startsWith('nav:')) return sources.navigation.some(node => node.id === ref.sel.slice(4) && node.kind !== 'web');
  return false;
}

/** Actual App navigation may select scheduled sessions that cannot enter a split. */
export function resolveActualCenterSelection(
  utilityPanel: string | null, displayActiveId: string | null, sources: CenterSplitSources
): SplitPaneRef {
  if (utilityPanel != null) {
    const ref: SplitPaneRef = { kind: 'utility', sel: utilityPanel };
    return supportsCenterSplitRef(ref, sources) ? ref : { kind: 'empty' };
  }
  return displayActiveId && sources.sessions.some(session => session.id === displayActiveId)
    ? { kind: 'session', sessionId: displayActiveId } : { kind: 'empty' };
}

/** Shortcut eligibility and render support are separate from actual navigation. */
export function resolveCenterSplitPrimary(
  utilityPanel: string | null, displayActiveId: string | null, sources: CenterSplitSources
): SplitPaneRef {
  const ref = resolveActualCenterSelection(utilityPanel, displayActiveId, sources);
  return supportsCenterSplitRef(ref, sources) ? ref : { kind: 'empty' };
}
