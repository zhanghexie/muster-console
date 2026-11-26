import type { SplitPaneRef } from '../../shared/centerSplit';
import type { CenterFileBinding } from '../../shared/panelState';
import { readAgentCenterFile, type AgentCenterFileState } from './rightPanelState';

/** File references are valid only while the exact scoped instance and ownership remain current. */
export function panelFilesCurrent(workspaceId: string, panes: readonly SplitPaneRef[],
  bindings: readonly CenterFileBinding[] | undefined,
  read: (workspaceId: string, tabId: string) => AgentCenterFileState | null = readAgentCenterFile): boolean {
  if (!Array.isArray(panes) || (bindings !== undefined && !Array.isArray(bindings)) || panes.some(pane => !pane || typeof pane !== 'object' ||
      (pane.kind === 'utility' && typeof pane.sel !== 'string'))) return false;
  const sels = panes.flatMap(pane => pane.kind === 'utility' && pane.sel.startsWith('center-file:') ? [pane.sel] : []);
  if (!sels.length) return !bindings?.length;
  if (!bindings || bindings.length !== sels.length || new Set(sels).size !== sels.length || bindings.some(item => !item || typeof item !== 'object')) return false;
  try {
    return sels.every(sel => {
      const found = bindings.filter(item => item.sel === sel), binding = found[0];
      if (found.length !== 1 || !binding || !binding.tabId || sel !== `center-file:${binding.tabId}`) return false;
      const state = read(workspaceId, binding.tabId);
      return !!state && state.tabId === binding.tabId && state.centerOnly === binding.centerOnly && state.pinned === binding.pinned &&
        JSON.stringify(state.content) === binding.content;
    });
  } catch { return false; }
}
