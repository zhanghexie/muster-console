import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import path from 'node:path';
import type { WorkspaceInfo } from '../../shared/types';
import { requireSourceRoot } from '../../shared/workspaceRoots';
import type { ExtensionDiscoveredExtension, ExtensionListing } from '../../shared/extension';
import { SAMPLE_IDS } from './extensionSampleInstaller';
import type { ExtensionReviewDecision, ExtensionReviewRequest } from './extensionReview';
import { ExtensionReviewCoordinator, ExtensionReviewStore } from './extensionReview';
import { ExtensionDraftStore, type ExtensionDraftCreate } from './extensionDrafts';
import { ExtensionProjectMappings } from './extensionProjectMappings';
import { resolveExtensionProjectBinding } from './extensionProjectBinding';
import type { ExtensionSourceLayout } from './extensionSourceLayout';
import type { ExtensionSourcePackage } from './extensionSourceLayout';
import type { ExtensionPackageCatalog } from './extensionPackageCatalog';
import type { ExtensionSourceScope } from './extensionSourceLayout';
import { ExtensionPublishConflict, publishExtensionPackageDirectory } from './extensionPackageSnapshot';

export interface ExtensionAuthoringServicesOptions {
  userData: string;
  catalog: ExtensionPackageCatalog;
  sourceLayout: ExtensionSourceLayout;
  workspaces: () => readonly WorkspaceInfo[];
  review: (request: ExtensionReviewRequest) => Promise<ExtensionReviewDecision>;
  changed: () => void;
  enabled?: (input: { workspaceId: string; scope: ExtensionSourceScope; extensionId: string; controlRoot?: string; fallback: boolean }) => boolean;
  enabledInAnyWorkspace?: (extensionId: string) => boolean;
}

export type ExtensionSubmitResult = { status: 'published' | 'rejected' | 'stale'; fingerprint: string; reason?: string };

/**
 * Authoring, review and installation for the single package host. Drafts are
 * reviewed against the new manifest contract and, once approved, published
 * atomically into the source layout that the package catalog scans. There is no
 * per-workspace replica distribution and no background runtime here.
 */
export class ExtensionAuthoringServices {
  readonly mappings: ExtensionProjectMappings;
  readonly drafts: ExtensionDraftStore;
  private readonly reviewCoordinator: ExtensionReviewCoordinator;
  private readonly shutdown = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  private readonly publishing = new Map<string, Promise<void>>();
  private readonly base: string;
  constructor(private readonly options: ExtensionAuthoringServicesOptions) {
    this.base = userDataStorage(options.userData).resolve('app', 'extension');
    this.mappings = new ExtensionProjectMappings(path.join(this.base, 'project-mappings.json'));
    this.drafts = new ExtensionDraftStore(options.userData, options.workspaces, () => this.mappings.list(), options.sourceLayout);
    this.reviewCoordinator = new ExtensionReviewCoordinator(new ExtensionReviewStore(path.join(this.base, 'reviews.json')), path.join(this.base, 'packages'), options.review);
  }
  get userDataDirectory(): string { return this.options.userData; }

  private workspace(id: string): WorkspaceInfo {
    const workspace = this.options.workspaces().find(item => item.id === id);
    if (!workspace) throw new Error('Workspace is not registered');
    return workspace;
  }

  private discovered(pkg: ExtensionSourcePackage, workspaceId: string, installed: boolean): ExtensionDiscoveredExtension {
    const record = this.options.catalog.get(pkg.descriptor.scope, pkg.descriptor.extensionId, pkg.descriptor.controlRoot);
    const decision = installed ? undefined : this.reviewCoordinator.decision(workspaceId, pkg.manifest, pkg.fingerprint);
    const fallback = record?.enabled ?? true;
    return {
      workspaceId, id: pkg.descriptor.extensionId, directory: pkg.descriptor.directory,
      fingerprint: pkg.fingerprint, manifest: pkg.manifest, enabled: this.options.enabled?.({ workspaceId, scope: pkg.descriptor.scope, extensionId: pkg.descriptor.extensionId, ...(pkg.descriptor.controlRoot ? { controlRoot: pkg.descriptor.controlRoot } : {}), fallback }) ?? fallback,
      status: installed ? 'installed' : decision?.decision ?? 'pending', reason: decision?.reason,
      ...(installed && pkg.descriptor.scope === 'global' ? {
        bundled: SAMPLE_IDS.some(id => id === pkg.descriptor.extensionId),
        sourceKind: record?.downloaded || record?.officialRelease ? 'center' : 'local',
        enabledInAnyWorkspace: this.options.enabledInAnyWorkspace?.(pkg.descriptor.extensionId),
      } : {}),
    };
  }

  async list(workspaceId: string, sourceRootId: string, mode: 'authoring' | 'installed' = 'authoring'): Promise<ExtensionListing> {
    const workspace = this.workspace(workspaceId);
    const controlRoot = requireSourceRoot(workspace, sourceRootId).path;
    const catalog = this.options.catalog;
    const installed = mode === 'installed';
    const [globalScan, projectScan] = await Promise.all([
      installed ? catalog.syncGlobal() : catalog.scanGlobal(),
      installed ? catalog.syncProject(controlRoot) : catalog.scanProject(controlRoot)
    ]);
    const global = globalScan.packages.map(pkg => this.discovered(pkg, workspaceId, installed));
    const errors = [...globalScan.errors, ...projectScan.errors];
    const project: ExtensionDiscoveredExtension[] = [];
    for (const pkg of projectScan.packages) {
      try {
        if (resolveExtensionProjectBinding(workspace, pkg.manifest.project!, this.mappings.list()).id !== sourceRootId) throw new Error('Extension belongs to a different project');
        project.push(this.discovered(pkg, workspaceId, installed));
      } catch (error) {
        errors.push({ extensionId: pkg.manifest.id, error: String(error) });
      }
    }
    const problems: ExtensionDiscoveredExtension[] = errors.map(item => ({
      workspaceId, id: item.extensionId, directory: '', status: 'error', enabled: false, reason: item.error
    }));
    return { global, project, problems, issues: errors.map(item => `${item.extensionId}: ${item.error}`), transactions: [] };
  }

  bindProject(workspaceId: string, key: string, sourceRootId: string, expectedRootId?: string): void {
    const workspace = this.workspace(workspaceId);
    this.shutdown.signal.throwIfAborted();
    this.mappings.bind(workspace, key, sourceRootId, expectedRootId);
    this.options.changed();
  }

  async createDraft(input: ExtensionDraftCreate) { this.shutdown.signal.throwIfAborted(); return this.drafts.create(input); }
  async writeDraft(workspaceId: string, draftId: string, file: string, contents: Buffer, owner?: string): Promise<void> { this.shutdown.signal.throwIfAborted(); await this.drafts.write(draftId, workspaceId, file, contents, owner); }
  removeDraftFile(workspaceId: string, draftId: string, file: string, owner?: string): void { this.shutdown.signal.throwIfAborted(); this.drafts.remove(draftId, workspaceId, file, owner); }

  private targetDirectory(scope: 'global' | 'project', extensionId: string, controlRoot: string): string {
    return this.options.sourceLayout.resolve({ scope, extensionId, ...(scope === 'project' ? { controlRoot } : {}) }).directory;
  }

  private async sync(scope: 'global' | 'project', controlRoot: string): Promise<void> {
    if (scope === 'global') await this.options.catalog.syncGlobal();
    else await this.options.catalog.syncProject(controlRoot);
  }

  private async run<T>(signal: AbortSignal | undefined, operation: (active: AbortSignal) => Promise<T>): Promise<T> {
    this.shutdown.signal.throwIfAborted();
    const active = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    const pending = operation(active);
    this.work.add(pending);
    try { return await pending; } finally { this.work.delete(pending); }
  }

  async stop(): Promise<void> {
    this.shutdown.abort(new Error('Extension authoring has stopped'));
    await Promise.allSettled([this.reviewCoordinator.cancelPending(), ...this.work]);
  }

  submitDraft(workspaceId: string, draftId: string, owner?: string, signal?: AbortSignal, retryRejected = false): Promise<ExtensionSubmitResult> {
    return this.run(signal, active => this.publishDraft(workspaceId, draftId, owner, active, retryRejected));
  }

  private async publishDraft(workspaceId: string, draftId: string, owner: string | undefined, signal: AbortSignal, retryRejected: boolean): Promise<ExtensionSubmitResult> {
    const captured = await this.drafts.captureAsync(draftId, workspaceId, owner);
    const { info, snapshot } = captured;
    const isCurrent = (): boolean => this.drafts.isCurrent(info) && !signal.aborted;
    const result = await this.reviewCoordinator.submit({
      workspaceId, id: info.extensionId, directory: captured.directory, expectedFingerprint: snapshot.fingerprint, signal, isCurrent
    }, { retryRejected });
    if (result.status !== 'approved') return { status: result.status, fingerprint: result.fingerprint, reason: result.reason };
    const projectPath = requireSourceRoot(this.workspace(workspaceId), info.sourceRootId).path;
    const target = this.targetDirectory(info.scope, info.extensionId, info.sourceRoot);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    const previous = this.publishing.get(key);
    const pending = (async () => {
      await previous?.catch(() => {});
      if (!isCurrent()) throw new ExtensionPublishConflict('Extension publish target changed');
      await publishExtensionPackageDirectory(target, snapshot, {
        root: info.scope === 'project' ? info.sourceRoot : this.options.userData,
        expectedFingerprint: info.expectedFingerprint, isCurrent
      });
      await this.sync(info.scope, projectPath);
    })();
    this.publishing.set(key, pending);
    try { await pending; }
    catch (error) {
      if (error instanceof ExtensionPublishConflict) return { status: 'stale', fingerprint: snapshot.fingerprint, reason: error.message };
      throw error;
    } finally { if (this.publishing.get(key) === pending) this.publishing.delete(key); }
    this.options.changed();
    return { status: 'published', fingerprint: result.fingerprint };
  }

  retryReview(workspaceId: string, sourceRootId: string, id: string, signal?: AbortSignal, scope?: 'global' | 'project'): Promise<ExtensionSubmitResult> {
    return this.run(signal, async active => {
      const workspace = this.workspace(workspaceId);
      const root = requireSourceRoot(workspace, sourceRootId);
      const listing = await this.list(workspaceId, sourceRootId);
      const candidates = (scope ? listing[scope] : [...listing.global, ...listing.project]).filter(item => item.id === id);
      if (!candidates.length) throw new Error('Extension is unavailable in the selected project');
      if (candidates.length > 1) throw new Error('Specify global or project scope for this extension ID');
      const [pkg] = candidates;
      const isCurrent = () => {
        if (active.aborted) return false;
        const current = this.workspace(workspaceId);
        return requireSourceRoot(current, sourceRootId).path === root.path &&
          (!pkg.manifest?.project || resolveExtensionProjectBinding(current, pkg.manifest.project, this.mappings.list()).id === sourceRootId);
      };
      const result = await this.reviewCoordinator.submit({ workspaceId, id, directory: pkg.directory, expectedFingerprint: pkg.fingerprint, signal: active, isCurrent }, { retryRejected: true });
      if (result.status !== 'approved') {
        this.options.changed();
        return { status: result.status, fingerprint: result.fingerprint, reason: result.reason };
      }
      await this.sync(pkg.manifest!.scope, root.path);
      this.options.changed();
      return { status: 'published', fingerprint: result.fingerprint };
    });
  }
}
