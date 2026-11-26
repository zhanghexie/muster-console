import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { controlRootFor, requireSourceRoot } from '../../shared/workspaceRoots';
import { sameExtensionProjectBinding, validateExtensionProjectBinding } from '../../shared/extension';
import type { ExtensionProjectBinding, ExtensionManifest } from '../../shared/extension';
import type { WorkspaceInfo } from '../../shared/types';
import { assertExtensionPackagePath, captureExtensionPackage, captureExtensionPackageAsync, validateExtensionPackage, writeExtensionPackageDirectoryAsync } from './extensionPackageSnapshot';
import type { ExtensionPackageSnapshot } from './extensionPackageSnapshot';
import { resolveExtensionProjectBinding } from './extensionProjectBinding';
import type { ExtensionProjectMapping } from './extensionProjectBinding';
import type { ExtensionSourceLayout } from './extensionSourceLayout';

const MAX_WRITE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 20_000;
const DRAFT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface ExtensionDraftInfo {
  version: 1; draftId: string; workspaceId: string; extensionId: string; scope: 'global' | 'project'; project?: ExtensionProjectBinding;
  owner: string; controlRoot: string; sourceRootId: string; sourceRoot: string; rootsRevision?: number; expectedFingerprint?: string;
}
export interface ExtensionDraftCreate { workspaceId: string; extensionId: string; sourceRootId: string; scope: 'global' | 'project'; project?: ExtensionProjectBinding; expectedFingerprint?: string; owner?: string }
function draftOwner(workspaceId: string, owner?: string): string {
  const value = owner ?? `workspace:${workspaceId}`;
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) throw new Error('Invalid draft owner');
  return value;
}

/** Controlled drafts belong to one workspace and never write to its source tree. */
export class ExtensionDraftStore {
  private root: string;
  constructor(userData: string, private workspaces: () => readonly WorkspaceInfo[], private mappings: () => readonly ExtensionProjectMapping[], private layout: ExtensionSourceLayout) {
    this.root = path.join(userDataStorage(userData).resolve('app', 'extension'), 'drafts');
  }
  private folder(id: string): string { if (!DRAFT_ID.test(id)) throw new Error('Invalid draft ID'); return path.join(this.root, id); }
  private workspace(id: string): WorkspaceInfo { const workspace = this.workspaces().find(item => item.id === id); if (!workspace) throw new Error('Workspace is not registered'); return workspace; }
  private samePath(a: string, b: string): boolean { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }

  async create(input: ExtensionDraftCreate): Promise<ExtensionDraftInfo> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.extensionId) || !input.workspaceId || !input.sourceRootId || (input.scope === 'project' ? !validateExtensionProjectBinding(input.project) : input.scope !== 'global' || input.project !== undefined) || (input.expectedFingerprint !== undefined && !/^package-extension:[a-f0-9]{64}$/.test(input.expectedFingerprint))) throw new Error('Invalid draft identity');
    const workspace = this.workspace(input.workspaceId);
    const controlRoot = fs.realpathSync(controlRootFor(workspace));
    const source = requireSourceRoot(workspace, input.sourceRootId);
    const sourceRoot = fs.realpathSync(source.path);
    if (!fs.statSync(controlRoot).isDirectory() || !fs.statSync(sourceRoot).isDirectory()) throw new Error('Workspace root is not a directory');
    if (input.scope === 'project' && resolveExtensionProjectBinding(workspace, input.project!, this.mappings()).id !== source.id) throw new Error('Project binding does not match the selected source root');
    let seed: ExtensionPackageSnapshot | undefined;
    if (input.expectedFingerprint) {
      const descriptor = this.layout.resolve({ scope: input.scope, extensionId: input.extensionId, ...(input.scope === 'project' ? { controlRoot: sourceRoot } : {}) });
      try { seed = await captureExtensionPackageAsync(descriptor.directory); }
      catch { throw new Error('Extension changed or cannot be opened for editing'); }
      const installed = validateExtensionPackage(seed, input.extensionId);
      if (input.scope !== installed.scope || (installed.project && resolveExtensionProjectBinding(workspace, installed.project, this.mappings()).id !== source.id)) throw new Error('Extension belongs to a different scope or project');
      if (seed.fingerprint !== input.expectedFingerprint) throw new Error('Extension changed while opening the draft');
    }
    const draftId = randomUUID();
    const info: ExtensionDraftInfo = { version: 1, draftId, workspaceId: input.workspaceId, extensionId: input.extensionId, owner: draftOwner(input.workspaceId, input.owner), scope: input.scope, ...(input.project ? { project: input.project } : {}), controlRoot, sourceRootId: source.id, sourceRoot, ...(workspace.rootsRevision !== undefined ? { rootsRevision: workspace.rootsRevision } : {}), ...(input.expectedFingerprint ? { expectedFingerprint: input.expectedFingerprint } : {}) };
    await fs.promises.mkdir(this.root, { recursive: true });
    const folder = this.folder(draftId); await fs.promises.mkdir(folder);
    try {
      const metadata = path.join(folder, 'draft.json');
      const temporary = path.join(folder, `.draft-${randomUUID()}.tmp`);
      await fs.promises.writeFile(temporary, `${JSON.stringify(info)}\n`, { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temporary, metadata);
      if (seed) await writeExtensionPackageDirectoryAsync(path.join(folder, 'files'), seed);
      else await fs.promises.mkdir(path.join(folder, 'files'));
      return info;
    } catch (error) {
      await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  get(draftId: string, workspaceId: string, owner?: string): ExtensionDraftInfo {
    const folder = this.folder(draftId);
    if (fs.lstatSync(folder).isSymbolicLink()) throw new Error('Draft directory is a link');
    const file = path.join(folder, 'draft.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('Draft metadata is invalid');
    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as ExtensionDraftInfo;
    if (info.version !== 1 || info.draftId !== draftId || info.workspaceId !== workspaceId || info.owner !== draftOwner(workspaceId, owner) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(info.extensionId) || !path.isAbsolute(info.controlRoot) || !path.isAbsolute(info.sourceRoot) || typeof info.sourceRootId !== 'string' || !info.sourceRootId || (info.scope === 'project' ? !validateExtensionProjectBinding(info.project) : info.scope !== 'global' || info.project !== undefined) || (info.expectedFingerprint !== undefined && !/^package-extension:[a-f0-9]{64}$/.test(info.expectedFingerprint))) throw new Error('Draft metadata or owner is invalid');
    return info;
  }

  isCurrent(info: ExtensionDraftInfo): boolean {
    try {
      const workspace = this.workspace(info.workspaceId);
      if (workspace.rootsRevision !== info.rootsRevision || !this.samePath(fs.realpathSync(controlRootFor(workspace)), info.controlRoot)) return false;
      const source = requireSourceRoot(workspace, info.sourceRootId);
      if (!this.samePath(fs.realpathSync(source.path), info.sourceRoot)) return false;
      return info.scope !== 'project' || resolveExtensionProjectBinding(workspace, info.project!, this.mappings()).id === info.sourceRootId;
    } catch { return false; }
  }

  private filePath(draftId: string, relative: string, createParents: boolean): string {
    assertExtensionPackagePath(relative);
    const files = path.join(this.folder(draftId), 'files');
    if (fs.lstatSync(files).isSymbolicLink()) throw new Error('Draft files directory is a link');
    const segments = relative.split('/'); let current = files;
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      let stat: fs.Stats | undefined;
      try { stat = fs.lstatSync(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (i < segments.length - 1 && createParents) { fs.mkdirSync(current); stat = fs.lstatSync(current); }
      }
      if (stat?.isSymbolicLink() || (stat && i < segments.length - 1 && !stat.isDirectory())) throw new Error('Draft paths cannot traverse links or files');
    }
    return current;
  }

  async write(draftId: string, workspaceId: string, relative: string, bytes: Buffer, owner?: string): Promise<void> {
    const info = this.get(draftId, workspaceId, owner);
    if (!this.isCurrent(info)) throw new Error('Workspace or project changed while editing the draft');
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_WRITE_BYTES) throw new Error('Draft file exceeds the per-write limit');
    const file = this.filePath(draftId, relative, true);
    const existing = fs.existsSync(file) ? await fs.promises.lstat(file) : undefined;
    if (existing && !existing.isFile()) throw new Error('Draft target is not a file');
    let total = 0, count = 0;
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Draft contains a link');
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) { count++; total += (await fs.promises.stat(child)).size; }
        else throw new Error('Unsupported draft entry');
      }
    };
    await walk(path.join(this.folder(draftId), 'files'));
    if (count + (existing ? 0 : 1) > MAX_FILES || total - (existing?.size ?? 0) + bytes.length > MAX_TOTAL_BYTES) throw new Error('Draft exceeds package limits');
    const temporary = path.join(this.folder(draftId), `.write-${randomUUID()}`);
    try { await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await fs.promises.rename(temporary, file); }
    finally { if (fs.existsSync(temporary)) await fs.promises.rm(temporary, { force: true }); }
  }

  remove(draftId: string, workspaceId: string, relative: string, owner?: string): void {
    const info = this.get(draftId, workspaceId, owner);
    if (!this.isCurrent(info)) throw new Error('Workspace or project changed while editing the draft');
    const file = this.filePath(draftId, relative, false);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Draft target is not a file');
    fs.unlinkSync(file);
  }

  capture(draftId: string, workspaceId: string, owner?: string): { info: ExtensionDraftInfo; snapshot: ExtensionPackageSnapshot; manifest: ExtensionManifest; directory: string } {
    const info = this.get(draftId, workspaceId, owner);
    if (!this.isCurrent(info)) throw new Error('Workspace or project changed while editing the draft');
    const directory = path.join(this.folder(draftId), 'files');
    const snapshot = captureExtensionPackage(directory);
    const manifest = validateExtensionPackage(snapshot, info.extensionId);
    if (snapshot.excluded.length || manifest.scope !== info.scope || (info.scope === 'project' && !sameExtensionProjectBinding(info.project, manifest.project))) throw new Error('Draft package scope or project differs from its selected target');
    return { info, snapshot, manifest, directory };
  }

  async captureAsync(draftId: string, workspaceId: string, owner?: string): Promise<{ info: ExtensionDraftInfo; snapshot: ExtensionPackageSnapshot; manifest: ExtensionManifest; directory: string }> {
    const info = this.get(draftId, workspaceId, owner);
    if (!this.isCurrent(info)) throw new Error('Workspace or project changed while editing the draft');
    const directory = path.join(this.folder(draftId), 'files');
    const snapshot = await captureExtensionPackageAsync(directory);
    if (!this.isCurrent(info)) throw new Error('Workspace or project changed while editing the draft');
    const manifest = validateExtensionPackage(snapshot, info.extensionId);
    if (snapshot.excluded.length || manifest.scope !== info.scope || (info.scope === 'project' && !sameExtensionProjectBinding(info.project, manifest.project))) throw new Error('Draft package scope or project differs from its selected target');
    return { info, snapshot, manifest, directory };
  }
}
