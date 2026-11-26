import fs from 'node:fs';
import path from 'node:path';
import type { LocalStorageDependency, LocalStorageItem } from '../../shared/localStorage';
import type { SessionMeta } from '../../shared/types';
import { pathKey } from '../pathKey';

export function sessionWorktreePaths(row: SessionMeta): string[] {
  const groups = Array.isArray(row.worktreeGroups?.groups) ? row.worktreeGroups.groups : [];
  return [...new Set([row.worktreePath, ...groups.map(group => group?.path)]
    .filter((folder): folder is string => typeof folder === 'string' && path.isAbsolute(folder)).map(folder => path.resolve(folder)))];
}

/** Resolve aliases, including an existing ancestor of a missing checkout. */
function physicalPath(folder: string): string {
  let ancestor = path.resolve(folder);
  for (;;) {
    try { return pathKey(path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, folder))); }
    catch (error) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor || (error as NodeJS.ErrnoException).code !== 'ENOENT') return pathKey(folder);
      ancestor = parent;
    }
  }
}

function within(folder: string, tree: string): boolean {
  const relative = path.relative(tree, folder);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function worktreeSessionReferences(owner: SessionMeta, rows: readonly SessionMeta[], cache = new Map<string, string>()): SessionMeta[] {
  const resolve = (folder: string) => {
    const key = pathKey(folder);
    let current = cache.get(key);
    if (current === undefined) { current = physicalPath(folder); cache.set(key, current); }
    return current;
  };
  const paths = sessionWorktreePaths(owner);
  const roots = paths.map(pathKey), physical = paths.map(resolve);
  return rows.filter(row => {
    if (row.id === owner.id) return !row.retainedWorktreeOnly;
    if (row.worktreeGroups?.borrowedFrom === owner.id) return true;
    const paths = [...sessionWorktreePaths(row), row.cwd, row.terminalResumeScope?.cwd].filter((folder): folder is string => !!folder && path.isAbsolute(folder));
    return paths.some(folder => roots.some(tree => within(pathKey(folder), tree)) || physical.some(tree => within(resolve(folder), tree)));
  });
}

export function storageSessionDependencies(items: readonly LocalStorageItem[], rows: readonly SessionMeta[]): LocalStorageDependency[] {
  const sessions = new Map(items.filter(item => item.category === 'sessions' && item.sessionId).map(item => [item.sessionId!, item.id]));
  const byId = new Map(rows.map(row => [row.id, row]));
  const dependencies: LocalStorageDependency[] = [];
  const cache = new Map<string, string>();
  for (const row of rows) {
    const dependentId = sessions.get(row.id), prerequisiteId = sessions.get(row.parentSessionId ?? '');
    if (dependentId && prerequisiteId) dependencies.push({ dependentId, prerequisiteId });
  }
  for (const item of items) {
    const owner = item.category === 'worktrees' ? byId.get(item.sessionId ?? '') : undefined;
    if (!owner) continue;
    for (const row of worktreeSessionReferences(owner, rows, cache)) {
      const dependentId = sessions.get(row.id);
      if (dependentId) dependencies.push({ dependentId, prerequisiteId: item.id });
    }
  }
  return dependencies;
}
