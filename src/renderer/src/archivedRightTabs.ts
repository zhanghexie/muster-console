import { validateRightWorkspaceSaved, type RightTab, type RightWorkspaceModel } from '../../shared/rightWorkspace';

const KEY = 'muster.right-workspace.archived-tabs.v1';

/** Recover archive-backed tab descriptors even when their workspace is not active. */
export function readArchivedRightTabs(): { tabs: RightTab[]; error?: string } {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { tabs: [] };
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || (saved as { version?: unknown }).version !== 1 || !Array.isArray((saved as { tabs?: unknown }).tabs)) {
      throw new Error('invalid archived tab record');
    }
    const rawTabs = (saved as { tabs: RightTab[] }).tabs;
    if (rawTabs.some(tab => !tab || typeof tab.workspaceId !== 'string' || tab.archiveBacked !== true)) throw new Error('invalid archived tab entry');
    const workspaces = [...new Set(rawTabs.flatMap(tab => typeof tab?.workspaceId === 'string' ? [tab.workspaceId] : []))];
    const tabs = workspaces.flatMap(workspaceId => {
      const own = rawTabs.filter(tab => tab.workspaceId === workspaceId);
      const result: RightTab[] = [];
      for (let index = 0; index < own.length; index += 200) {
        result.push(...(validateRightWorkspaceSaved({
          version: 1, tabs: own.slice(index, index + 200), selected: {}, panel: 'files', collapsed: false, bookmarks: []
        }, workspaceId)?.tabs ?? []));
      }
      return result;
    });
    if (tabs.length !== rawTabs.length) throw new Error('invalid archived tab entry');
    return { tabs: tabs.filter(tab => tab.archiveBacked).map(tab => ({ ...tab, content: tab.content.kind === 'web' ? { ...tab.content, browserId: '' } : tab.content })) };
  } catch (error) {
    return { tabs: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function serializeArchivedRightTabs(model: RightWorkspaceModel): string {
  return JSON.stringify({ version: 1, tabs: model.tabs.filter(tab => tab.archiveBacked).map(({ webHistoryKey: _key, replayOf: _preview, ...tab }) => ({
    ...tab, content: tab.content.kind === 'web' ? { ...tab.content, browserId: '' } : tab.content
  })) });
}

export function writeArchivedRightTabs(value: string): void {
  localStorage.setItem(KEY, value);
}
