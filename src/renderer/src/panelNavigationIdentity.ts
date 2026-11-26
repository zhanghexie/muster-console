import type { SplitPaneRef } from '../../shared/centerSplit';
import type { CenterNavigationBinding } from '../../shared/panelState';
import type { ExtensionNavigationSnapshot } from '../../shared/extension';

/** Every central navigation reference must have exactly one host-bound current identity. */
export function panelNavigationCurrent(workspaceId: string, panes: readonly SplitPaneRef[],
  bindings: readonly CenterNavigationBinding[] | undefined, nav: ExtensionNavigationSnapshot | undefined): boolean {
  if (!Array.isArray(panes) || (bindings !== undefined && !Array.isArray(bindings)) || panes.some(pane => !pane || typeof pane !== 'object' ||
      (pane.kind === 'utility' && typeof pane.sel !== 'string'))) return false;
  const ids = panes.flatMap(pane => pane.kind === 'utility' && pane.sel.startsWith('nav:') ? [pane.sel] : []);
  if (!ids.length) return !bindings?.length;
  if (!nav || nav.workspaceId !== workspaceId || !bindings || bindings.length !== ids.length ||
      bindings.some(binding => !binding || typeof binding !== 'object') || new Set(ids).size !== ids.length) return false;
  return ids.every(sel => {
    const matches = bindings.filter(binding => binding.sel === sel);
    const binding = matches[0], node = nav.nodes.find(item => item.id === sel.slice(4) && item.kind !== 'web');
    return matches.length === 1 && !!binding && nav.sourceRootId === binding.sourceRootId &&
      nav.selectionRevision === binding.selectionRevision && nav.revision === binding.revision && JSON.stringify(node) === binding.node;
  });
}
