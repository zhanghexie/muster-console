import path from 'node:path';
import { app } from 'electron';
import type { AppContext } from '../context';
import type { ExtensionNavigationSnapshot, ExtensionToolbarItem } from '../../shared/extension';
import { ExtensionNavigationStore } from './extensionNavigation';
import type { ExtensionManagementService } from './extensionManagement';
import type { ExtensionPackageCatalog } from './extensionPackageCatalog';
import type { ExtensionHost } from './extensionHost';
import { ensureExtensionStorageRoot } from './extensionWorkspaceActivation';

/** User-facing navigation and toolbar actions use the current package catalog. */
export class ExtensionWorkbench {
  readonly navigation: ExtensionNavigationStore;
  constructor(private ctx: AppContext, private management: ExtensionManagementService, private catalog: ExtensionPackageCatalog, private extensionHost: ExtensionHost) {
    const root = ensureExtensionStorageRoot(app.getPath('userData'));
    this.navigation = new ExtensionNavigationStore(path.join(root, 'navigation.json'));
  }
  private selected(workspaceId: string): { rootId: string } {
    if (!workspaceId || this.ctx.config.get().activeWorkspaceId !== workspaceId) throw new Error('Workspace changed; refresh the extension view');
    return { rootId: this.management.rootId(workspaceId) };
  }
  projectPath(workspaceId: string, sourceRootId?: string): string { return this.management.rootPath(workspaceId, sourceRootId); }
  private catalogEntries(workspaceId: string, sourceRootId: string): Array<{ extensionId: string; title: string; icon?: string; scope: 'global' | 'project'; sourceRootId?: string }> {
    const projectPath = this.projectPath(workspaceId, sourceRootId);
    this.catalog.queueProjectSync(projectPath);
    return [
      ...this.catalog.list('global').filter(item => item.surfaceKind === 'sidebar' && this.management.isRunnable(workspaceId, 'global', item.extensionId)).map(item => ({ extensionId: item.extensionId, title: item.name, ...(item.icon ? { icon: item.icon } : {}), scope: 'global' as const })),
      ...this.catalog.list('project').filter(item => item.surfaceKind === 'sidebar' && item.controlRoot && (process.platform === 'win32' ? item.controlRoot.toLowerCase() === projectPath.toLowerCase() : item.controlRoot === projectPath) && this.management.isRunnable(workspaceId, 'project', item.extensionId, item.controlRoot)).map(item => ({ extensionId: item.extensionId, title: item.name, ...(item.icon ? { icon: item.icon } : {}), scope: 'project' as const, sourceRootId }))
    ];
  }
  private catalogToolbarEntries(workspaceId: string, sourceRootId: string): Array<{ id: string; name: string; scope: 'global' | 'project'; menu?: Array<{ id: string; label: string }> }> {
    const projectPath = this.projectPath(workspaceId, sourceRootId);
    this.catalog.queueProjectSync(projectPath);
    const records = [
      ...this.catalog.list('global').filter(item => item.surfaceKind === 'toolbar' && this.management.isRunnable(workspaceId, 'global', item.extensionId)),
      ...this.catalog.list('project').filter(item => item.surfaceKind === 'toolbar' && item.controlRoot && (process.platform === 'win32' ? item.controlRoot.toLowerCase() === projectPath.toLowerCase() : item.controlRoot === projectPath) && this.management.isRunnable(workspaceId, 'project', item.extensionId, item.controlRoot))
    ];
    return records.map(record => ({ id: record.extensionId, name: record.name, scope: record.scope, ...(record.menu?.length ? { menu: record.menu } : {}) }));
  }
  sync(workspaceId = this.ctx.config.get().activeWorkspaceId): ExtensionNavigationSnapshot {
    if (!workspaceId && !this.ctx.config.get().activeWorkspaceId) {
      return { workspaceId: '', sourceRootId: '', selectionRevision: 0, revision: 0, nodes: [], libraryExpanded: false };
    }
    const { rootId } = this.selected(workspaceId);
    return this.navigation.snapshot(workspaceId, rootId, this.management.selectionRevision(workspaceId), true, this.catalogEntries(workspaceId, rootId));
  }
  peek(workspaceId: string): ExtensionNavigationSnapshot {
    const { rootId } = this.selected(workspaceId);
    return this.navigation.snapshot(workspaceId, rootId, this.management.selectionRevision(workspaceId), false, this.catalogEntries(workspaceId, rootId));
  }
  save(input: ExtensionNavigationSnapshot): ExtensionNavigationSnapshot {
    const { rootId } = this.selected(input.workspaceId);
    if (input.sourceRootId !== rootId || input.selectionRevision !== this.management.selectionRevision(input.workspaceId)) throw new Error('Selected project changed; refresh the extension view');
    return this.navigation.save(input, this.catalogEntries(input.workspaceId, rootId));
  }
  toolbar(workspaceId: string): { workspaceId: string; sourceRootId: string; selectionRevision: number; items: ExtensionToolbarItem[] } {
    const { rootId } = this.selected(workspaceId);
    return { workspaceId, sourceRootId: rootId, selectionRevision: this.management.selectionRevision(workspaceId), items: this.catalogToolbarEntries(workspaceId, rootId).map(item => ({ id: item.id, name: item.name, scope: item.scope, ...(item.menu ? { menu: item.menu } : {}) })) };
  }
  async runToolbar(input: { workspaceId: string; sourceRootId: string; selectionRevision: number; extensionId: string; menuId?: string; scope?: 'global' | 'project' }, signal?: AbortSignal): Promise<unknown> {
    const { rootId } = this.selected(input.workspaceId);
    if (input.sourceRootId !== rootId || input.selectionRevision !== this.management.selectionRevision(input.workspaceId)) throw new Error('Selected project changed before running the action');
    const scope = input.scope ?? 'global';
    const controlRoot = scope === 'project' ? this.projectPath(input.workspaceId, rootId) : undefined;
    return this.extensionHost.runToolbar({ workspaceId: input.workspaceId, extensionId: input.extensionId, scope, ...(controlRoot ? { controlRoot } : {}), sourceRootId: rootId, ...(input.menuId ? { menuId: input.menuId } : {}), ...(signal ? { signal } : {}) });
  }
  stop(): void {}
}
