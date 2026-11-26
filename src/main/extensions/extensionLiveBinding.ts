import type { ExtensionManifest } from '../../shared/extensionManifest';
import { defaultRootFor, requireSourceRoot } from '../../shared/workspaceRoots';
import type { WorkspaceInfo, WorkspaceRoot } from '../../shared/types';
import type { ExtensionSourcePackage, ExtensionSourceScope } from './extensionSourceLayout';
import type { ExtensionCatalogRecord, ExtensionPackageCatalog } from './extensionPackageCatalog';
import type { ExtensionDevelopmentTrustSubject, ExtensionDevelopmentTrustStore } from './extensionDevelopmentTrust';
import { resolveExtensionProjectBindingAsync, type ExtensionProjectMapping } from './extensionProjectBinding';

export interface ExtensionLiveBindingInput {
  workspaceId: string;
  extensionId: string;
  scope: ExtensionSourceScope;
  controlRoot?: string;
  sourceRootId?: string;
  expectedFingerprint?: string;
  packageInfo: ExtensionSourcePackage;
}

export interface ExtensionLiveBindingDependencies {
  catalog: Pick<ExtensionPackageCatalog, 'get'>;
  workspace: (workspaceId: string) => WorkspaceInfo | undefined;
  mappings?: (workspace: WorkspaceInfo) => readonly ExtensionProjectMapping[];
  isWorkspaceActivated?: (input: { workspaceId: string; extensionId: string; scope: ExtensionSourceScope; controlRoot?: string }) => boolean;
  developmentTrust?: Pick<ExtensionDevelopmentTrustStore, 'canRun' | 'ensureCanRun'>;
}

export interface ExtensionLiveBinding {
  workspace?: WorkspaceInfo;
  sourceRoot?: WorkspaceRoot;
  controlRoot?: string;
  rootsRevision?: number;
  packageInfo: ExtensionSourcePackage;
  catalog: ExtensionCatalogRecord;
  trustSubject: ExtensionDevelopmentTrustSubject;
  trusted: boolean;
  assertCurrent(signal?: AbortSignal): void;
}

export class ExtensionDevelopmentTrustRequiredError extends Error {
  constructor() {
    super('extension development trust is required before running this package');
  }
}

/**
 * Resolve the complete runtime identity for an extension operation.
 *
 * Callers may use the returned assertion around a long-running operation. It
 * checks the same catalog, workspace activation, development trust and root
 * revision that were used for the initial resolution.
 */
export async function resolveLiveExtensionBinding(
  input: ExtensionLiveBindingInput,
  dependencies: ExtensionLiveBindingDependencies
): Promise<ExtensionLiveBinding> {
  const pkg = input.packageInfo;
  const manifest = pkg.manifest as ExtensionManifest;
  if (pkg.descriptor.extensionId !== input.extensionId || manifest.id !== input.extensionId) throw new Error('extension package identity changed');
  if (pkg.descriptor.scope !== input.scope || manifest.scope !== input.scope) throw new Error('extension manifest scope does not match the requested surface scope');
  if (input.expectedFingerprint !== undefined && pkg.fingerprint !== input.expectedFingerprint) throw new Error('extension package changed');
  const workspace = dependencies.workspace(input.workspaceId);
  if (!workspace && input.scope === 'project') throw new Error('Extension workspace is unavailable');
  if (!workspace && input.sourceRootId) throw new Error('Extension workspace is unavailable');
  const sourceRoot = workspace ? (input.sourceRootId ? requireSourceRoot(workspace, input.sourceRootId) : defaultRootFor(workspace)) : undefined;
  const controlRoot = input.scope === 'project' ? input.controlRoot ?? sourceRoot?.path : undefined;
  if (input.scope === 'project') {
    if (!workspace || !sourceRoot || !input.sourceRootId || !manifest.project) throw new Error('Project extension is missing its binding');
    const bound = await resolveExtensionProjectBindingAsync(workspace, manifest.project, dependencies.mappings?.(workspace) ?? []);
    if (bound.id !== input.sourceRootId) throw new Error('Extension belongs to a different project');
  }
  const catalog = dependencies.catalog.get(input.scope, input.extensionId, controlRoot);
  if (!catalog || !catalog.enabled) throw new Error('extension package is disabled');
  if (catalog.fingerprint !== pkg.fingerprint) throw new Error('extension package fingerprint is stale');
  if (dependencies.isWorkspaceActivated && !dependencies.isWorkspaceActivated({ workspaceId: input.workspaceId, extensionId: input.extensionId, scope: input.scope, ...(controlRoot ? { controlRoot } : {}) })) {
    throw new Error('extension is disabled in this workspace');
  }
  const trustSubject: ExtensionDevelopmentTrustSubject = {
    extensionId: pkg.manifest.id,
    scope: input.scope,
    directory: pkg.descriptor.directory,
    fingerprint: pkg.fingerprint
  };
  const trust = dependencies.developmentTrust;
  const requiresVerification = trust && !trust.canRun(trustSubject);
  if (requiresVerification && !await trust.ensureCanRun(trustSubject)) throw new ExtensionDevelopmentTrustRequiredError();
  const rootPath = sourceRoot?.path;
  const rootsRevision = workspace?.rootsRevision ?? 0;
  const assertCurrent = (signal?: AbortSignal): void => {
    signal?.throwIfAborted();
    if (workspace) {
      const current = dependencies.workspace(input.workspaceId);
      if (!current || (current.rootsRevision ?? 0) !== rootsRevision) throw new Error('Extension live binding changed');
      const currentRoot = input.sourceRootId ? requireSourceRoot(current, input.sourceRootId) : defaultRootFor(current);
      const samePath = rootPath !== undefined && (process.platform === 'win32' ? currentRoot.path.toLowerCase() === rootPath.toLowerCase() : currentRoot.path === rootPath);
      if (!samePath) throw new Error('Extension live binding changed');
    }
    const currentCatalog = dependencies.catalog.get(input.scope, input.extensionId, controlRoot);
    if (!currentCatalog || !currentCatalog.enabled || currentCatalog.fingerprint !== pkg.fingerprint) throw new Error('Extension live binding changed');
    if (dependencies.isWorkspaceActivated && !dependencies.isWorkspaceActivated({ workspaceId: input.workspaceId, extensionId: input.extensionId, scope: input.scope, ...(controlRoot ? { controlRoot } : {}) })) throw new Error('Extension live binding changed');
    if (trust && !trust.canRun(trustSubject)) throw new Error('Extension live binding changed');
  };
  if (requiresVerification) assertCurrent();
  return { ...(workspace ? { workspace } : {}), ...(sourceRoot ? { sourceRoot } : {}), ...(controlRoot ? { controlRoot } : {}), ...(workspace ? { rootsRevision } : {}), packageInfo: pkg, catalog, trustSubject, trusted: true, assertCurrent };
}
