import { randomUUID } from 'node:crypto';
import type { AppConfig, SessionMeta, WorkspaceFileRef, WorkspaceRootDependency } from '../shared/types';
import { defaultRootFor, sourceRootsFor } from '../shared/workspaceRoots';
import { sourcePathKey } from './workspacePaths';
import { isPathInsideWorkspace } from './git/scan';

type ConfigSource = { get(): Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'> };
type RootUse = WorkspaceRootDependency & { workspaceId: string };

/** Synchronous registration must precede the first await, including path validation. */
export class WorkspaceRootUses {
  private uses = new Map<string, RootUse>();
  private owners = new Map<string, Map<string, { latest: string; tokens: Set<string> }>>();

  acquire(use: RootUse): () => void {
    const token = randomUUID();
    this.uses.set(token, structuredClone(use));
    return () => { this.uses.delete(token); };
  }

  list(workspaceId: string): WorkspaceRootDependency[] {
    return [...this.uses.values()].filter(use => use.workspaceId === workspaceId)
      .map(({ workspaceId: _workspaceId, ...use }) => structuredClone(use));
  }

  openFile(owner: string, viewId: string, ref: WorkspaceFileRef): { commit(): void; undo(): void } {
    const views = this.owners.get(owner) ?? new Map<string, { latest: string; tokens: Set<string> }>();
    const token = randomUUID();
    this.uses.set(token, { workspaceId: ref.workspaceId, rootId: ref.rootId, kind: 'open-file',
      id: viewId, label: ref.relativePath, relativePath: ref.relativePath });
    const view = views.get(viewId) ?? { latest: token, tokens: new Set<string>() };
    view.latest = token; view.tokens.add(token);
    views.set(viewId, view); this.owners.set(owner, views);
    return {
      commit: () => {
        if (views.get(viewId)?.latest !== token) return;
        for (const previous of view.tokens) if (previous !== token) { this.uses.delete(previous); view.tokens.delete(previous); }
      },
      // Invalid/late openings cannot release the previous valid view or a newer one.
      undo: () => {
        this.uses.delete(token); view.tokens.delete(token);
        if (view.latest === token) view.latest = [...view.tokens].at(-1) ?? '';
        if (!view.tokens.size && views.get(viewId) === view) views.delete(viewId);
        if (!views.size && this.owners.get(owner) === views) this.owners.delete(owner);
      }
    };
  }

  closeFile(owner: string, viewId: string): void {
    const views = this.owners.get(owner);
    for (const token of views?.get(viewId)?.tokens ?? []) this.uses.delete(token);
    views?.delete(viewId);
    if (!views?.size) this.owners.delete(owner);
  }

  closeOwner(owner: string): void {
    for (const view of this.owners.get(owner)?.values() ?? []) for (const token of view.tokens) this.uses.delete(token);
    this.owners.delete(owner);
  }
}

const registries = new WeakMap<object, WorkspaceRootUses>();
export function workspaceRootUsesFor(config: ConfigSource): WorkspaceRootUses {
  let registry = registries.get(config);
  if (!registry) { registry = new WorkspaceRootUses(); registries.set(config, registry); }
  return registry;
}

/** Capture before async source resolution. Ambiguous legacy input holds every candidate. */
export function holdPendingSource(config: ConfigSource,
  input: { workspaceId?: string; rootId?: string; cwd?: string; capturedSource?: SessionMeta['sourceRoot']; additionalRootIds?: readonly string[] },
  use: Omit<WorkspaceRootDependency, 'rootId'>): () => void {
  const cfg = config.get();
  const releases: Array<() => void> = [];
  const workspaceId = input.workspaceId ?? (!input.cwd ? cfg.activeWorkspaceId : undefined);
  for (const workspace of cfg.workspaces) {
    if (workspace.rootsError || (workspaceId !== undefined && workspace.id !== workspaceId)) continue;
    const explicit = input.rootId ?? input.capturedSource?.rootId;
    let roots = [...sourceRootsFor(workspace)];
    if (explicit !== undefined) roots = roots.filter(root => root.id === explicit);
    else if (input.cwd) {
      const cwdKey = sourcePathKey(input.cwd);
      roots = roots.filter(root => isPathInsideWorkspace(cwdKey, sourcePathKey(root.path)));
      // The legacy locator selects the most specific registered root.
      roots.sort((a, b) => sourcePathKey(b.path).length - sourcePathKey(a.path).length);
      roots = roots.slice(0, 1);
      // Unresolved paths (e.g. a new file through a Junction) must not open an await gap.
      if (!roots.length && workspaceId !== undefined) roots = [...sourceRootsFor(workspace)];
    } else roots = [defaultRootFor(workspace)];
    const additional = sourceRootsFor(workspace).filter(root => input.additionalRootIds?.includes(root.id));
    for (const root of new Map([...roots, ...additional].map(root => [root.id, root])).values()) releases.push(workspaceRootUsesFor(config).acquire({ ...use, workspaceId: workspace.id, rootId: root.id }));
  }
  return () => { for (const release of releases) release(); };
}
