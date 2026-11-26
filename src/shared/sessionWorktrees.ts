import type { SessionMeta, SessionWorktreeGroup, SessionWorktreeGroups } from './types';
import { pathKey } from './pathKey';

type WorktreeFields = Pick<SessionMeta, 'id' | 'sourceRoot' | 'worktreeGroups' | 'worktreePath' | 'worktreeSource' | 'worktreeBranch' | 'worktreeBaseBranch' | 'worktreeRepoSet'>;

function absolute(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && !value.includes('\0') && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\'));
}

/** Validate saved topology, without trusting it as proof of live Git identity. */
export function validateSessionWorktreeGroups(state: SessionWorktreeGroups): void {
  if (!state || state.version !== 1 || !Array.isArray(state.groups) || !state.groups.length) throw new Error('invalid worktree group collection');
  if (state.cwdPolicy !== undefined && state.cwdPolicy !== 'source') throw new Error('invalid worktree cwd policy');
  if (state.revision !== undefined && (!Number.isSafeInteger(state.revision) || state.revision < 1)) throw new Error('invalid worktree mapping revision');
  if (state.borrowedFrom !== undefined && (!state.borrowedFrom.trim() || state.cwdPolicy !== 'source')) throw new Error('invalid worktree borrower');
  const ids = new Set<string>();
  const paths = new Set<string>();
  const sources = new Set<string>();
  for (const group of state.groups) {
    if (!group || typeof group.id !== 'string' || !group.id.trim() || ids.has(group.id)) throw new Error('invalid or duplicate worktree group identity');
    ids.add(group.id);
    if (state.groups.length > 1 && (!group.sourceRoot || !group.source || !group.branch)) throw new Error('multiple worktree groups require complete source identities');
    if (!absolute(group.path) || paths.has(pathKey(group.path))) throw new Error('invalid or duplicate worktree group path');
    paths.add(pathKey(group.path));
    if (group.sourceRoot && (typeof group.sourceRoot.rootId !== 'string' || !group.sourceRoot.rootId.trim() || !absolute(group.sourceRoot.path) || !absolute(group.sourceRoot.cwd))) throw new Error('invalid worktree source folder identity');
    if (group.source) {
      if (!absolute(group.source.mainRepo) || !absolute(group.source.commonDir) || sources.has(pathKey(group.source.commonDir))) throw new Error('invalid or duplicate worktree source repository');
      sources.add(pathKey(group.source.commonDir));
    }
    if (group.branch !== undefined && (typeof group.branch !== 'string' || !group.branch.trim())) throw new Error('invalid worktree branch');
    if (group.baseCommit !== undefined && (typeof group.baseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(group.baseCommit))) throw new Error('invalid worktree creation baseline');
    if (!Array.isArray(group.repos)) throw new Error('invalid nested worktree collection');
    const repos = new Set<string>();
    for (const repo of group.repos) {
      if (!repo || typeof repo.path !== 'string' || !repo.path || /[\\:\0]/.test(repo.path) || repo.path.split('/').some(part => !part || part === '.' || part === '..') || typeof repo.branch !== 'string' || !repo.branch.trim() || repos.has(pathKey(repo.path))) throw new Error('invalid or duplicate nested worktree path');
      repos.add(pathKey(repo.path));
    }
    if (group.integration !== undefined) {
      if (!Array.isArray(group.integration)) throw new Error('invalid worktree integration results');
      const entries = new Set<string>();
      for (const entry of group.integration) {
        if (!entry || typeof entry.repo !== 'string' || (entry.repo !== '' && !repos.has(pathKey(entry.repo))) || entries.has(pathKey(entry.repo)) || typeof entry.branch !== 'string' || !entry.branch.trim() || !['merged', 'already-merged', 'skipped-unchanged', 'failed', 'blocked', 'not-started'].includes(entry.status)) throw new Error('invalid worktree integration result');
        entries.add(pathKey(entry.repo));
        for (const commit of [entry.headCommit, entry.targetCommit, entry.mergedCommit]) {
          if (commit !== undefined && (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))) throw new Error('invalid worktree integration commit');
        }
      }
    }
    if (group.cleanup !== undefined) {
      if (!Array.isArray(group.cleanup)) throw new Error('invalid worktree cleanup results');
      const entries = new Set<string>();
      for (const entry of group.cleanup) {
        if (!entry || typeof entry.repo !== 'string' || (entry.repo !== '' && !repos.has(pathKey(entry.repo))) || entries.has(pathKey(entry.repo)) ||
          typeof entry.branch !== 'string' || !entry.branch.trim() || !['not-started', 'retained', 'removed'].includes(entry.status) ||
          typeof entry.treeRemoved !== 'boolean' || typeof entry.branchRemoved !== 'boolean' ||
          (entry.branchRemoved && !entry.treeRemoved) || (entry.status === 'removed' && (!entry.treeRemoved || !entry.branchRemoved)) ||
          (entry.commonDir !== undefined && !absolute(entry.commonDir)) ||
          (entry.headCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.headCommit))) throw new Error('invalid worktree cleanup result');
        entries.add(pathKey(entry.repo));
      }
    }
  }
  if (!ids.has(state.primaryGroupId)) throw new Error('worktree primary group is missing');
  if (state.sourceRoots !== undefined) {
    if (!Array.isArray(state.sourceRoots)) throw new Error('invalid worktree selected source collection');
    const roots = new Set<string>();
    for (const source of state.sourceRoots) {
      if (!source || typeof source.rootId !== 'string' || !source.rootId.trim() || roots.has(source.rootId) || !absolute(source.path) || !absolute(source.cwd)) throw new Error('invalid worktree selected source identity');
      roots.add(source.rootId);
    }
  }
}

/** The legacy projection is used only when no collection was saved. */
export function sessionWorktreeGroups(session: WorktreeFields): SessionWorktreeGroups | undefined {
  if (session.worktreeGroups !== undefined) {
    validateSessionWorktreeGroups(session.worktreeGroups);
    return session.worktreeGroups;
  }
  if (!session.worktreePath) return undefined;
  const group: SessionWorktreeGroup = {
    id: `${session.id}:legacy`, path: session.worktreePath,
    ...(session.sourceRoot ? { sourceRoot: structuredClone(session.sourceRoot) } : {}),
    ...(session.worktreeSource ? { source: { ...session.worktreeSource } } : {}),
    ...(session.worktreeBranch ? { branch: session.worktreeBranch } : {}),
    ...(session.worktreeBaseBranch ? { baseBranch: session.worktreeBaseBranch } : {}),
    repos: structuredClone(session.worktreeRepoSet ?? [])
  };
  return { version: 1, primaryGroupId: group.id, groups: [group] };
}

/** Used at the load/create boundary. Explicit collections win over stale projections. */
export function normalizeSessionWorktrees(session: WorktreeFields): void {
  const state = sessionWorktreeGroups(session);
  if (!state) return;
  session.worktreeGroups = structuredClone(state);
  projectPrimaryWorktree(session);
}

export function projectPrimaryWorktree(session: WorktreeFields): void {
  if (!session.worktreeGroups) return;
  validateSessionWorktreeGroups(session.worktreeGroups);
  const group = session.worktreeGroups.groups.find(group => group.id === session.worktreeGroups!.primaryGroupId)!;
  session.worktreePath = group.path;
  session.worktreeSource = group.source ? { ...group.source } : undefined;
  session.worktreeBranch = group.branch;
  session.worktreeBaseBranch = group.baseBranch;
  session.worktreeRepoSet = structuredClone(group.repos);
  if (!session.sourceRoot && group.sourceRoot) session.sourceRoot = structuredClone(group.sourceRoot);
}

/** Until the full multi-group lifecycle is connected, old mutators must fail closed. */
export function assertSingleWorktreeGroup(session: WorktreeFields): void {
  const state = sessionWorktreeGroups(session);
  if (state && state.groups.length !== 1) throw new Error('multiple worktree groups require group-aware lifecycle operations');
}

/** Compatibility writers cannot silently replace sibling groups. */
export function syncSingleWorktreeGroup(session: WorktreeFields): void {
  assertSingleWorktreeGroup(session);
  const primary = session.worktreeGroups?.groups[0];
  if (!primary) return;
  primary.path = session.worktreePath!;
  primary.source = session.worktreeSource ? { ...session.worktreeSource } : undefined;
  primary.branch = session.worktreeBranch;
  primary.baseBranch = session.worktreeBaseBranch;
  primary.repos = structuredClone(session.worktreeRepoSet ?? []);
}

export function clearSessionWorktreeMetadata(session: WorktreeFields): void {
  delete session.worktreeGroups;
  delete session.worktreeSource;
  delete session.worktreePath;
  delete session.worktreeBranch;
  delete session.worktreeBaseBranch;
  delete session.worktreeRepoSet;
}

/** Mapped single groups need the same identity/release guards as multi-group tasks. */
export function usesTaskWorktreeLifecycle(session: WorktreeFields): boolean {
  const state = sessionWorktreeGroups(session);
  return !!state && (state.cwdPolicy === 'source' || state.groups.length > 1);
}

/** Storage may discard only branches and checkouts with recorded source identity. */
export function hasRegisteredWorktreeCleanupIdentity(session: WorktreeFields): boolean {
  try {
    const state = sessionWorktreeGroups(session);
    return !!state && !state.borrowedFrom && state.groups.every(group => !!group.source && !!group.sourceRoot && !!group.branch);
  } catch { return false; }
}

/** Borrowing a group's path never transfers cleanup ownership. */
export function transferSessionWorktrees(source: WorktreeFields, destination: WorktreeFields): void {
  const state = sessionWorktreeGroups(source);
  if (!state) return;
  destination.worktreeGroups = structuredClone(state);
  projectPrimaryWorktree(destination);
  clearSessionWorktreeMetadata(source);
}
