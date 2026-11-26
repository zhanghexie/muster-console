import { useEffect, useSyncExternalStore } from 'react';
import type { ExtensionNavigationNode } from '../../shared/extensionNavigation';
import type { ExtensionNavigationSnapshot } from '../../shared/extension';
import { t } from '../../shared/i18n';
import { extensionSurfaceKey, prepareExtensionSurfaceReturn } from './components/ExtensionSurface';

const cache = new Map<string, ExtensionNavigationSnapshot>();
const empty = new Map<string, ExtensionNavigationSnapshot>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
function publish(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const snapshot = value as ExtensionNavigationSnapshot;
  if (!snapshot.workspaceId || !snapshot.sourceRootId || !Number.isSafeInteger(snapshot.selectionRevision) || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.nodes)) return;
  const previous = cache.get(snapshot.workspaceId);
  if (previous && (previous.selectionRevision > snapshot.selectionRevision || (previous.selectionRevision === snapshot.selectionRevision && previous.revision > snapshot.revision))) return;
  // A main-process update may move several live surfaces at once. Prepare all
  // of them while their old tab hosts are still connected, before notifying React.
  const rollbacks: Array<() => void> = [];
  try {
    if (previous && previous.sourceRootId === snapshot.sourceRootId && previous.selectionRevision === snapshot.selectionRevision) {
      for (const old of previous.nodes) {
        if (old.kind !== 'extension' || old.placement !== 'tab') continue;
        const next = snapshot.nodes.find(node => node.id === old.id);
        if (next?.kind !== 'extension' || next.extensionId !== old.extensionId || next.viewId !== old.viewId || next.placement === 'tab') continue;
        const rollback = prepareExtensionSurfaceReturn(extensionSurfaceKey(snapshot.workspaceId, old.id), true);
        if (rollback) rollbacks.push(rollback);
      }
    }
  } catch (error) {
    const errors: unknown[] = [error];
    for (const rollback of rollbacks.reverse()) try { rollback(); } catch (rollbackError) { errors.push(rollbackError); }
    if (errors.length > 1) throw new AggregateError(errors, t('扩展页面位置保存失败，恢复原位置也失败'));
    throw error;
  }
  cache.set(snapshot.workspaceId, { ...snapshot, nodes: snapshot.nodes.filter(node => node.kind !== 'web') });
  listeners.forEach(listener => listener());
}
export async function refreshExtensionNavigation(): Promise<void> { publish(await window.api.workbench.navigation()); }
export function useExtensionWorkbenchNavigation(workspaceId: string): ExtensionNavigationSnapshot {
  if (!empty.has(workspaceId)) empty.set(workspaceId, { workspaceId, sourceRootId: '', selectionRevision: 0, revision: 0, nodes: [], libraryExpanded: false });
  useEffect(() => {
    const stop = window.api.on('workbench:changed', value => {
      try { publish(value); }
      catch (error) { window.dispatchEvent(new CustomEvent('workbench:error', { detail: String(error) })); }
    });
    void refreshExtensionNavigation().catch(error => window.dispatchEvent(new CustomEvent('workbench:error', { detail: String(error) })));
    return stop;
  }, [workspaceId]);
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => cache.get(workspaceId) ?? empty.get(workspaceId)!);
}
export function saveExtensionNavigation(workspaceId: string, changes: { nodes?: ExtensionNavigationNode[]; libraryExpanded?: boolean }): Promise<void> {
  const write = (pending.get(workspaceId) ?? Promise.resolve()).then(async () => {
    const current = cache.get(workspaceId);
    if (!current) throw new Error(t('工具列表尚未加载'));
    publish(await window.api.workbench.saveNavigation({ ...current, ...changes }));
  });
  pending.set(workspaceId, write.catch(() => {}));
  return write.catch(async error => { await refreshExtensionNavigation(); throw error; });
}
export function setExtensionPlacement(workspaceId: string, nodeId: string, placement: 'center' | 'tab' | 'window'): Promise<void> {
  const write = (pending.get(workspaceId) ?? Promise.resolve()).then(async () => {
    const current = cache.get(workspaceId);
    if (!current) throw new Error(t('工具列表尚未加载'));
    const previous = current.nodes.find(node => node.id === nodeId);
    const rollback = previous?.kind === 'extension' && previous.placement === 'tab' && placement !== 'tab'
      ? prepareExtensionSurfaceReturn(extensionSurfaceKey(workspaceId, nodeId)) : undefined;
    const placementFrom = (value: unknown): string | undefined => {
      if (!value || typeof value !== 'object' || !previous || previous.kind !== 'extension') return undefined;
      const snapshot = value as ExtensionNavigationSnapshot;
      if (snapshot.workspaceId !== workspaceId || snapshot.sourceRootId !== current.sourceRootId ||
          snapshot.selectionRevision !== current.selectionRevision || !Number.isSafeInteger(snapshot.revision) ||
          snapshot.revision < current.revision || !Array.isArray(snapshot.nodes)) return undefined;
      const node = snapshot.nodes.find(item => item.id === nodeId);
      return node?.kind === 'extension' && node.extensionId === previous.extensionId && node.viewId === previous.viewId ? node.placement : undefined;
    };
    try {
      const result = await window.api.workbench.saveNavigation({ ...current, nodes: current.nodes.map(node => node.id === nodeId ? { ...node, placement } : node) });
      if (placementFrom(result) !== placement) throw new Error(t('扩展页面位置未得到确认'));
      publish(result);
    } catch (error) {
      let actual: ExtensionNavigationSnapshot;
      try { actual = await window.api.workbench.navigation(); }
      catch (readError) { throw new AggregateError([error, readError], t('扩展页面位置结果未知，请检查后再试')); }
      const actualPlacement = placementFrom(actual);
      if (actualPlacement === placement) { publish(actual); return; }
      if (actualPlacement !== previous?.placement) throw new Error(t('扩展页面位置结果未知，请检查后再试'));
      publish(actual);
      if (rollback) {
        try { rollback(); } catch (rollbackError) { throw new AggregateError([error, rollbackError], t('扩展页面位置保存失败，恢复原位置也失败')); }
      }
      throw error;
    }
  });
  pending.set(workspaceId, write.catch(() => {}));
  return write;
}
