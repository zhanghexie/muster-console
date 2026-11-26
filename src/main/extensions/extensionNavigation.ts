import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseNavigation } from '../../shared/extensionNavigation';
import type { ExtensionNavigationNode } from '../../shared/extensionNavigation';
import type { ExtensionNavigationSnapshot } from '../../shared/extension';
import { writeJsonAtomicSync } from '../atomicJson';

interface ProjectNavigation { nodes: ExtensionNavigationNode[]; libraryExpanded: boolean }
interface StoredNavigation { version: 1; revision: number; projects: Record<string, ProjectNavigation> }
function key(workspaceId: string, sourceRootId: string): string { return JSON.stringify([workspaceId, sourceRootId]); }
function viewKey(extensionId: string, viewId: string, scope: 'global' | 'project' = 'global', sourceRootId = ''): string { return JSON.stringify([scope, sourceRootId, extensionId, viewId]); }
function validNodes(value: unknown): ExtensionNavigationNode[] | null {
  const nodes = parseNavigation(value);
  if (!nodes || nodes.some(node => node.kind === 'web' || node.scope === 'global' || (node.kind === 'extension' && Object.hasOwn(node, 'installationWorkspaceId')))) return null;
    const views = nodes.filter(node => node.kind === 'extension').map(node => viewKey(node.extensionId, node.viewId, node.extensionScope ?? 'global', node.extensionSourceRootId ?? ''));
  return new Set(views).size === views.length ? nodes : null;
}

/** UI shortcuts are local to a workspace/project; availability always comes from extension. */
export class ExtensionNavigationStore {
  private data: StoredNavigation = { version: 1, revision: 0, projects: {} };
  private writable = true;
  recoveryWarning: string | null = null;
  constructor(private file: string) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.unavailable(`无法读取扩展导航：${String(error)}`); return;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) { this.unavailable(`扩展导航路径不是普通文件：${file}`); return; }
    let source: string;
    try { source = stat.size > 4 * 1024 * 1024 ? '' : fs.readFileSync(file, 'utf8'); }
    catch (error) { this.unavailable(`无法读取扩展导航：${String(error)}`); return; }
    try {
      if (!source) throw new Error('导航文件为空或超过大小限制');
      const parsed: unknown = JSON.parse(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Extension navigation storage is invalid');
      const document = parsed as StoredNavigation;
      if (document.version !== 1 || !Number.isSafeInteger(document.revision) || document.revision < 0 || !document.projects || typeof document.projects !== 'object' || Array.isArray(document.projects)) throw new Error('Extension navigation storage is invalid');
      for (const [project, value] of Object.entries(document.projects)) {
        let identity: unknown;
        try { identity = JSON.parse(project); } catch { throw new Error('Extension navigation project identity is invalid'); }
        if (!Array.isArray(identity) || identity.length !== 2 || identity.some(item => typeof item !== 'string' || !item) || !value || typeof value !== 'object' || typeof value.libraryExpanded !== 'boolean' || !validNodes(value.nodes)) throw new Error('Extension navigation project state is invalid');
      }
      this.data = document;
    } catch (error) {
      const backup = `${file}.bad-${randomUUID()}`;
      try {
        fs.renameSync(file, backup);
        this.recoveryWarning = `扩展导航配置损坏，已保留至 ${backup}；已重建默认导航。原因：${String(error)}`;
        console.error('[extension]', this.recoveryWarning);
      } catch (moveError) {
        this.unavailable(`扩展导航配置损坏，无法保留原文件 ${file}：${String(moveError)}`);
      }
    }
  }
  private unavailable(message: string): void { this.writable = false; this.recoveryWarning = `${message}；导航暂不可保存。`; console.error('[extension]', this.recoveryWarning); }
  private commit(projectKey: string, project: ProjectNavigation): void {
    if (!this.writable) throw new Error(this.recoveryWarning || 'Extension navigation is read-only');
    const next = { ...this.data, revision: this.data.revision + 1, projects: { ...this.data.projects, [projectKey]: project } };
    writeJsonAtomicSync(this.file, next); this.data = next;
  }
  snapshot(workspaceId: string, sourceRootId: string, selectionRevision = 0, materialize = true, catalogEntries: readonly { extensionId: string; title: string; icon?: string; scope?: 'global' | 'project'; sourceRootId?: string }[] = []): ExtensionNavigationSnapshot {
    if (!workspaceId || !sourceRootId) throw new Error('Workspace and selected project are required');
    const projectKey = key(workspaceId, sourceRootId), existing = this.data.projects[projectKey] ?? { nodes: [], libraryExpanded: false };
    const nodes = structuredClone(existing.nodes);
    const available = new Map<string, { extensionId: string; viewId: string; title: string; icon?: string; scope: 'global' | 'project'; sourceRootId?: string }>();
    for (const entry of catalogEntries) available.set(viewKey(entry.extensionId, 'main', entry.scope ?? 'global', entry.sourceRootId ?? ''), { extensionId: entry.extensionId, viewId: 'main', title: entry.title, ...(entry.icon ? { icon: entry.icon } : {}), scope: entry.scope ?? 'global', ...(entry.sourceRootId ? { sourceRootId: entry.sourceRootId } : {}) });
    let changed = false;
    for (const [viewId, view] of available) if (materialize && !nodes.some(node => node.kind === 'extension' && viewKey(node.extensionId, node.viewId, node.extensionScope ?? 'global', node.extensionSourceRootId ?? '') === viewId)) {
      nodes.push({ id: randomUUID(), kind: 'extension', parentId: null, title: view.title, extensionId: view.extensionId, viewId: view.viewId, ...(view.icon ? { icon: view.icon } : {}), extensionScope: view.scope, ...(view.sourceRootId ? { extensionSourceRootId: view.sourceRootId } : {}), favorite: false }); changed = true;
    }
    if (changed && this.writable) this.commit(projectKey, { ...existing, nodes });
    return { workspaceId, sourceRootId, selectionRevision, revision: this.data.revision, libraryExpanded: existing.libraryExpanded,
      nodes: nodes.filter(node => node.kind !== 'extension' || available.has(viewKey(node.extensionId, node.viewId, node.extensionScope ?? 'global', node.extensionSourceRootId ?? ''))).map(node => {
        if (node.kind !== 'extension') return node;
        const view = available.get(viewKey(node.extensionId, node.viewId, node.extensionScope ?? 'global', node.extensionSourceRootId ?? ''));
        return view?.icon ? { ...node, icon: view.icon } : node;
      }) };
  }
  save(input: ExtensionNavigationSnapshot, catalogEntries: readonly { extensionId: string; title: string; icon?: string; scope?: 'global' | 'project'; sourceRootId?: string }[] = []): ExtensionNavigationSnapshot {
    if (!this.writable) throw new Error(this.recoveryWarning || 'Extension navigation is read-only');
    if (!input.workspaceId || !input.sourceRootId || typeof input.libraryExpanded !== 'boolean') throw new Error('Invalid extension navigation identity');
    const current = this.snapshot(input.workspaceId, input.sourceRootId, input.selectionRevision, true, catalogEntries);
    if (input.revision !== current.revision) throw new Error('Extension navigation changed; refresh and retry');
    const next = validNodes(input.nodes);
    if (!next) throw new Error('Invalid extension navigation');
    const projectKey = key(input.workspaceId, input.sourceRootId), stored = this.data.projects[projectKey] ?? { nodes: [], libraryExpanded: false };
    for (const node of next) {
      const original = stored.nodes.find(item => item.id === node.id);
      if (original && original.kind !== node.kind) throw new Error('Navigation node identity cannot change kind');
    }
    const visible = new Map(current.nodes.filter(node => node.kind === 'extension').map(node => [node.id, node]));
    for (const node of next) if (node.kind === 'extension') {
      const original = visible.get(node.id);
      if (!original || original.kind !== 'extension' || original.extensionId !== node.extensionId || original.viewId !== node.viewId || (original.extensionScope ?? 'global') !== (node.extensionScope ?? 'global') || (original.extensionSourceRootId ?? '') !== (node.extensionSourceRootId ?? '')) throw new Error('Navigation cannot introduce or change an extension identity');
    }
    const ids = new Set(next.map(node => node.id));
    for (const node of stored.nodes) {
      if (node.kind !== 'extension' || ids.has(node.id)) continue;
      // Unpinning never removes the extension from the project library. Hidden
      // (disabled/unavailable) entries retain their existing favorite state.
      const wasVisible = visible.has(node.id);
      let parentId = node.parentId;
      if (parentId && !ids.has(parentId)) parentId = null;
      next.push({ ...node, parentId, ...(wasVisible ? { favorite: false } : {}) }); ids.add(node.id);
    }
    if (!validNodes(next)) throw new Error('Invalid extension navigation hierarchy');
    const project = { nodes: next, libraryExpanded: input.libraryExpanded };
    if (JSON.stringify(project) !== JSON.stringify(stored)) this.commit(projectKey, project);
    return this.snapshot(input.workspaceId, input.sourceRootId, input.selectionRevision, true, catalogEntries);
  }
}

