import fs from 'node:fs';
import { requireSourceRoot, sourceRootsFor } from '../../shared/workspaceRoots';
import type { WorkspaceInfo } from '../../shared/types';
import { writeJsonAtomicSync } from '../atomicJson';
import type { ExtensionProjectMapping } from './extensionProjectBinding';

/** Local-only mapping for project bindings that cannot be expressed portably as a relative path. */
export class ExtensionProjectMappings {
  private rows: ExtensionProjectMapping[];
  constructor(private file: string) {
    if (!fs.existsSync(file)) { this.rows = []; return; }
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Project mappings are invalid');
    const document = raw as { version?: unknown; mappings?: unknown };
    if (document.version !== 1 || !Array.isArray(document.mappings)) throw new Error('Project mappings are invalid');
    const rows = document.mappings as ExtensionProjectMapping[];
    if (rows.some(row => !row || typeof row !== 'object' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.key) || typeof row.workspaceId !== 'string' || !row.workspaceId || typeof row.rootId !== 'string' || !row.rootId || typeof row.realPath !== 'string' || !row.realPath)) throw new Error('Project mapping is invalid');
    if (new Set(rows.map(row => JSON.stringify([row.workspaceId, row.key]))).size !== rows.length) throw new Error('Project mappings contain duplicates');
    this.rows = rows;
  }
  list(): ExtensionProjectMapping[] { return structuredClone(this.rows); }
  bind(workspace: WorkspaceInfo, key: string, rootId: string, expectedRootId?: string): ExtensionProjectMapping {
    if (!workspace.id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) throw new Error('Invalid project mapping identity');
    const source = requireSourceRoot(workspace, rootId), realPath = fs.realpathSync(source.path);
    if (!fs.statSync(realPath).isDirectory()) throw new Error('Mapped project is not a directory');
    const matches = sourceRootsFor(workspace).filter(root => {
      try { const candidate = fs.realpathSync(root.path); return process.platform === 'win32' ? candidate.toLowerCase() === realPath.toLowerCase() : candidate === realPath; }
      catch { return false; }
    });
    if (matches.length !== 1) throw new Error('Mapped project is ambiguous');
    const existing = this.rows.find(item => item.workspaceId === workspace.id && item.key === key);
    const samePath = existing && (process.platform === 'win32' ? existing.realPath.toLowerCase() === realPath.toLowerCase() : existing.realPath === realPath);
    if (existing && (existing.rootId !== rootId || !samePath) && expectedRootId !== existing.rootId) throw new Error('Project mapping is already bound; provide its current root ID to rebind explicitly');
    if (!existing && expectedRootId !== undefined) throw new Error('Project mapping changed; refresh before rebinding');
    if (existing && existing.rootId === rootId && samePath) return { ...existing };
    const row: ExtensionProjectMapping = { key, workspaceId: workspace.id, rootId, realPath };
    const next = [...this.rows.filter(item => item.workspaceId !== workspace.id || item.key !== key), row];
    writeJsonAtomicSync(this.file, { version: 1, mappings: next }); this.rows = next; return { ...row };
  }
  unbind(workspaceId: string, key: string): void {
    const next = this.rows.filter(row => row.workspaceId !== workspaceId || row.key !== key);
    writeJsonAtomicSync(this.file, { version: 1, mappings: next }); this.rows = next;
  }
}
