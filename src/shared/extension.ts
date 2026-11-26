import type { ExtensionManifest } from './extensionManifest';
import { listResidentWorkerToolMetas } from './hostTools';
import { projectHostToolRoster } from './hostToolProjection';

/**
 * The extension manifest contract lives in `extensionManifest.ts`; it is
 * re-exported here for existing import sites. The remaining types are the
 * contract-independent management/navigation/runtime projections.
 */
export type { ExtensionManifest } from './extensionManifest';

/** Relative bindings travel with Git; mapped bindings must be resolved locally. */
export type ExtensionProjectBinding = { kind: 'relative'; path: string } | { kind: 'mapped'; key: string };
export type ExtensionViewPermission = 'storage' | 'notify' | 'llm' | 'fs:ro' | 'data' | 'commands' | 'ui' | 'agent.state' | 'agent.commands';
export const EXTENSION_BUILTIN_HOST_TOOLS = ['host.sessions.create', 'host.mail.send', 'host.sessions.select', 'host.sessions.observe', 'host.runtimes.run', 'host.terminal.create', 'host.terminal.write', 'host.tasks.render'] as const;
export const EXTENSION_HOST_TOOLS: readonly string[] = [...new Set([
  ...EXTENSION_BUILTIN_HOST_TOOLS,
  ...projectHostToolRoster([...listResidentWorkerToolMetas().map(meta => meta.id), 'askQuestion']).map(tool => tool.name)
])];
export function isExtensionHostTool(name: string): boolean {
  return EXTENSION_HOST_TOOLS.some(tool => tool === name || tool.replace(/\./g, '_') === name);
}

export type ExtensionStatus = 'installed' | 'reviewing' | 'approved' | 'rejected' | 'pending' | 'conflict' | 'error';
export interface ExtensionDiscoveredExtension {
  workspaceId: string;
  id: string;
  directory: string;
  fingerprint?: string;
  manifest?: ExtensionManifest;
  enabled?: boolean;
  enabledInAnyWorkspace?: boolean;
  bundled?: boolean;
  sourceKind?: 'center' | 'local';
  status: ExtensionStatus;
  reason?: string;
}
export interface ExtensionTransactionProblem {
  id: string;
  extensionId?: string;
  reason: string;
  paths: string[];
}
export type ExtensionTransactionPreserveResult = { ok: true; preservedPath: string } | { ok: false; error: string };
export interface ExtensionListing {
  global: ExtensionDiscoveredExtension[];
  project: ExtensionDiscoveredExtension[];
  problems: ExtensionDiscoveredExtension[];
  issues: string[];
  transactions?: ExtensionTransactionProblem[];
}
export interface ExtensionManagementSnapshot {
  workspaceId: string;
  sourceRootId: string;
  selectionRevision: number;
  projects: Array<{ id: string; label: string }>;
  listing: ExtensionListing;
}
export interface ExtensionInstanceIdentity {
  token: string; instanceId: string; generation: number; workspaceId: string; extensionId: string;
  sourceRootId: string; rootsRevision?: number; fingerprint: string; viewId?: string;
}
export interface ExtensionRuntimeEvent { workspaceId: string; extensionId: string; sourceRootId: string; generation: number; topic: string; value: unknown }
export interface ExtensionViewInstance extends ExtensionInstanceIdentity {
  viewId: string;
  entry: string;
  permissions: ExtensionViewPermission[];
  extension: { id: string; name: string; icon?: string; version?: string; scope: 'global' | 'project'; commands?: ExtensionManifest['commands']; hasBackground: boolean; hasNative: boolean; surfaceKind?: 'toolbar' | 'sidebar'; agentProfile?: 'scheduler-pi' };
}
export interface ExtensionNavigationSnapshot {
  workspaceId: string;
  sourceRootId: string;
  selectionRevision: number;
  revision: number;
  nodes: import('./extensionNavigation').ExtensionNavigationNode[];
  libraryExpanded: boolean;
}
export interface ExtensionToolbarItem {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  scope: 'global' | 'project';
  menu?: Array<{ id: string; label: string }>;
}

export type ExtensionToolbarRunResult =
  | { status: 'completed'; result: unknown }
  | { status: 'development-trust-required'; error: string };

export function isPortableProjectPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  if (value === '.') return true;
  let normalSegmentSeen = false;
  return value.split('/').every(segment => {
    if (segment === '..') return !normalSegmentSeen;
    normalSegmentSeen = true;
    return !!segment && segment !== '.' && !/[<>:"|?*]/.test(segment)
      && !/[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment);
  });
}

export function validateExtensionProjectBinding(value: unknown): value is ExtensionProjectBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (binding.kind === 'relative') return Object.keys(binding).length === 2 && isPortableProjectPath(binding.path);
  if (binding.kind === 'mapped') return Object.keys(binding).length === 2 && typeof binding.key === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(binding.key);
  return false;
}

export function sameExtensionProjectBinding(a: ExtensionProjectBinding | undefined, b: ExtensionProjectBinding | undefined): boolean {
  return !!a && !!b && (a.kind === 'relative' && b.kind === 'relative' ? a.path === b.path : a.kind === 'mapped' && b.kind === 'mapped' && a.key === b.key);
}
