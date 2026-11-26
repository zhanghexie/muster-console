import { defaultRootFor, requireSourceRoot, sourceRootsFor, workspaceRootLabel } from '../../shared/workspaceRoots';
import type { WorkspaceInfo } from '../../shared/types';
import type { ExtensionManagementSnapshot } from '../../shared/extension';
import type { ExtensionPackageCatalog } from './extensionPackageCatalog';
import type { ExtensionDevelopmentTrustStore } from './extensionDevelopmentTrust';
import type { ExtensionSourceLayout, ExtensionSourceScope } from './extensionSourceLayout';
import type { ExtensionWorkspaceActivationStore } from './extensionWorkspaceActivation';
import { SAMPLE_IDS } from './extensionSampleInstaller';

/** Workspace/project selection and workspace-level extension activation. */
export class ExtensionManagementService {
  private selected = new Map<string, { id: string; path: string }>();
  private defaultSeen = new Map<string, { id: string; path: string }>();
  private revisions = new Map<string, number>();
  private removing = new Set<string>();
  constructor(private catalog: ExtensionPackageCatalog, private workspaces: () => readonly WorkspaceInfo[], private changed: (workspaceId: string) => void, private navigationWarning: () => string | null = () => null, private builtinWarning: () => string | null = () => null, private activation?: ExtensionWorkspaceActivationStore, private runtimeAuthorization?: ExtensionDevelopmentTrustStore) {}
  private workspace(id: string): WorkspaceInfo {
    const workspace = this.workspaces().find(item => item.id === id);
    if (!workspace) throw new Error('Workspace is not registered');
    return workspace;
  }
  rootId(workspaceId: string): string {
    const workspace = this.workspace(workspaceId), selected = this.selected.get(workspaceId);
    if (!selected) {
      const root = defaultRootFor(workspace), previous = this.defaultSeen.get(workspaceId);
      if (previous && (previous.id !== root.id || previous.path !== root.path)) this.revisions.set(workspaceId, (this.revisions.get(workspaceId) ?? 0) + 1);
      this.defaultSeen.set(workspaceId, { id: root.id, path: root.path });
      return root.id;
    }
    const root = requireSourceRoot(workspace, selected.id);
    const equal = process.platform === 'win32' ? root.path.toLowerCase() === selected.path.toLowerCase() : root.path === selected.path;
    if (!equal) throw new Error('The selected project path changed; choose the project again');
    return root.id;
  }
  rootPath(workspaceId: string, sourceRootId?: string): string {
    const workspace = this.workspace(workspaceId);
    return requireSourceRoot(workspace, sourceRootId ?? this.rootId(workspaceId)).path;
  }
  select(workspaceId: string, sourceRootId: string): ExtensionManagementSnapshot {
    const root = requireSourceRoot(this.workspace(workspaceId), sourceRootId);
    this.selected.set(workspaceId, { id: root.id, path: root.path });
    this.revisions.set(workspaceId, (this.revisions.get(workspaceId) ?? 0) + 1);
    this.changed(workspaceId);
    return this.snapshot(workspaceId);
  }
  selectionRevision(workspaceId: string): number { this.rootId(workspaceId); return this.revisions.get(workspaceId) ?? 0; }
  isEnabled(workspaceId: string, scope: ExtensionSourceScope, extensionId: string, controlRoot?: string): boolean {
    const record = this.catalog.get(scope, extensionId, controlRoot);
    return this.activation?.isEnabled({ workspaceId, scope, extensionId, ...(controlRoot ? { controlRoot } : {}) }, record?.enabled ?? true) ?? (record?.enabled ?? true);
  }
  isRunnable(workspaceId: string, scope: ExtensionSourceScope, extensionId: string, controlRoot?: string): boolean {
    const record = this.catalog.get(scope, extensionId, controlRoot);
    return !!record?.enabled && this.isEnabled(workspaceId, scope, extensionId, controlRoot)
      && (this.runtimeAuthorization?.canRun(record, workspaceId) ?? true);
  }
  isGlobalEnabledAnywhere(extensionId: string): boolean {
    return this.workspaces().some(workspace => this.isRunnable(workspace.id, 'global', extensionId));
  }
  snapshot(workspaceId: string): ExtensionManagementSnapshot {
    const workspace = this.workspace(workspaceId), sourceRootId = this.rootId(workspaceId);
    const issues = [this.navigationWarning(), this.builtinWarning()].filter((value): value is string => !!value);
    return { workspaceId, sourceRootId, selectionRevision: this.revisions.get(workspaceId) ?? 0, projects: sourceRootsFor(workspace).map(root => ({ id: root.id, label: workspaceRootLabel(root) })), listing: { global: [], project: [], problems: [], issues, transactions: [] } };
  }
  async setEnabled(workspaceId: string, sourceRootId: string, scope: 'global' | 'project', extensionId: string, enabled: boolean, selectionRevision: number): Promise<ExtensionManagementSnapshot> {
    if (this.rootId(workspaceId) !== sourceRootId || this.selectionRevision(workspaceId) !== selectionRevision) throw new Error('The selected project changed; refresh before changing an extension');
    if (scope === 'global' && this.removing.has(extensionId)) throw new Error('扩展正在卸载，请稍后再试');
    const controlRoot = scope === 'project' ? this.rootPath(workspaceId, sourceRootId) : undefined;
    if (this.activation) {
      const record = this.catalog.get(scope, extensionId, controlRoot);
      if (!record) throw new Error('extension package is not registered');
      if (enabled) this.runtimeAuthorization?.authorizeActivation(record, [workspaceId]);
      await this.activation.set({ workspaceId, scope, extensionId, ...(controlRoot ? { controlRoot } : {}) }, enabled);
    } else await this.catalog.setEnabled({ scope, extensionId, ...(controlRoot ? { controlRoot } : {}), enabled });
    this.changed(workspaceId);
    return this.snapshot(workspaceId);
  }
  async setEnabledAll(workspaceId: string, extensionId: string, enabled: boolean): Promise<void> {
    this.workspace(workspaceId);
    if (this.removing.has(extensionId)) throw new Error('扩展正在卸载，请稍后再试');
    const record = this.catalog.get('global', extensionId);
    if (!record) throw new Error('extension package is not registered');
    const workspaces = this.workspaces();
    if (enabled) this.runtimeAuthorization?.authorizeActivation(record, workspaces.map(item => item.id));
    if (this.activation) await this.activation.setAll(workspaces.map(item => item.id), { scope: 'global', extensionId }, enabled);
    else await this.catalog.setEnabled({ scope: 'global', extensionId, enabled });
    for (const workspace of workspaces) this.changed(workspace.id);
  }

  /** Use the same activation ledger as the management pane, including records of closed workspaces. */
  async disableGlobalForStorage(workspaceId: string, extensionId: string, fingerprint: string): Promise<void> {
    const record = this.catalog.get('global', extensionId);
    if (!this.activation || !record || record.fingerprint !== fingerprint || this.removing.has(extensionId)) {
      throw new Error('扩展内容已变化，请刷新列表后重新卸载');
    }
    await this.activation.set({ workspaceId, extensionId, scope: 'global' }, false);
    this.changed(workspaceId);
  }

  async uninstallGlobal(workspaceId: string | undefined, extensionId: string, fingerprint: string, operations: {
    layout: ExtensionSourceLayout;
    close: (extensionId: string) => Promise<void>;
    trash: (directory: string) => Promise<void>;
    checkInactive?: () => boolean;
  }): Promise<void> {
    if (workspaceId !== undefined) this.workspace(workspaceId);
    if (SAMPLE_IDS.some(id => id === extensionId)) throw new Error('内置扩展随应用提供，无法卸载');
    if (this.removing.has(extensionId)) throw new Error('扩展正在卸载，请稍后再试');
    if (!this.catalog.get('global', extensionId)) throw new Error('extension package is not registered');
    const isActive = () => this.isGlobalEnabledAnywhere(extensionId) || operations.checkInactive?.() === false;
    if (isActive()) throw new Error('请先关闭所有工作区中的该扩展后再卸载');
    this.removing.add(extensionId);
    try {
      await operations.close(extensionId);
      const pkg = await operations.layout.discover({ scope: 'global', extensionId });
      if (pkg.fingerprint !== fingerprint) throw new Error('扩展内容已变化，请刷新列表后重新卸载');
      if (isActive()) throw new Error('请先关闭所有工作区中的该扩展后再卸载');
      try { await operations.trash(pkg.descriptor.directory); }
      catch (error) { throw new Error('无法将扩展移到系统回收站，请检查回收站和目录权限后重试', { cause: error }); }
      await this.catalog.syncGlobal();
      for (const workspace of this.workspaces()) this.changed(workspace.id);
    } finally {
      this.removing.delete(extensionId);
    }
  }
}
