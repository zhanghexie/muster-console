import type { TreeNavRow } from './listTreeKeyboardNav';
import type { GitRepoSummary, WorkspaceRoot } from './types';

export type RepoSort = 'name' | 'recent' | 'dirty';

export type GitRepoTreeKind = 'external-root' | 'source-root' | 'folder' | 'repo';

export type GitRepoTreeNode = {
  id: string;
  parentId: string | null;
  kind: GitRepoTreeKind;
  label: string;
  expandable: boolean;
  absPath?: string;
  sourceRoot?: boolean;
  repo?: GitRepoSummary;
  children: GitRepoTreeNode[];
};

type InternalNode = {
  label: string;
  absPath: string;
  repo?: GitRepoSummary;
  children: Map<string, InternalNode>;
};

/**
 * pathKey 契约（见 shared/pathKey.ts）：比较键统一为 `/`，Windows 下小写。
 * 树归属判断必须用同一分隔符，不能硬编码 `\`，否则 Windows 上全部落进「外部」。
 */
function defaultPathKey(p: string): string {
  return p.replace(/[/\\]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** pathKey 输出里的路径分隔符（统一为 `/`）。 */
const PATH_KEY_SEP = '/';

function getSep(workspacePath: string): string {
  return workspacePath.includes('\\') ? '\\' : '/';
}

function normalizeSep(p: string, sep: string): string {
  return p.replace(/[/\\]/g, sep).replace(/[/\\]+$/, '');
}

function joinAbsPath(base: string, segment: string): string {
  const sep = getSep(base);
  const normalizedBase = base.replace(/[/\\]+$/, '');
  return `${normalizedBase}${sep}${segment}`;
}

export function isInsideWorkspace(
  absPath: string,
  workspacePath: string,
  pathKey: (p: string) => string
): boolean {
  const sep = getSep(workspacePath || absPath);
  const abs = pathKey(normalizeSep(absPath, sep));
  const ws = pathKey(normalizeSep(workspacePath, sep));
  if (abs === ws) {
    return true;
  }
  return abs.startsWith(ws.endsWith(PATH_KEY_SEP) ? ws : ws + PATH_KEY_SEP);
}

function getRelativeSegments(
  repoPath: string,
  workspacePath: string,
  pathKey: (p: string) => string
): string[] | null {
  if (!isInsideWorkspace(repoPath, workspacePath, pathKey)) {
    return null;
  }
  const sep = getSep(workspacePath);
  const normRepo = normalizeSep(repoPath, sep);
  const normWs = normalizeSep(workspacePath, sep);
  const repoKey = pathKey(normRepo);
  const wsKey = pathKey(normWs);
  if (repoKey === wsKey) {
    return [];
  }
  const prefixKey = wsKey.endsWith(PATH_KEY_SEP) ? wsKey : `${wsKey}${PATH_KEY_SEP}`;
  if (!repoKey.startsWith(prefixKey)) {
    return null;
  }
  const wsSegments = normWs.split(/[/\\]/).filter(Boolean);
  return normRepo.split(/[/\\]/).filter(Boolean).slice(wsSegments.length);
}

function compareRepoActivity(a: GitRepoSummary, b: GitRepoSummary, repoSort: RepoSort): number {
  if (repoSort === 'dirty') {
    return Number(b.dirty === true) - Number(a.dirty === true);
  }
  if (repoSort === 'recent') return (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0);
  return 0;
}

function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function repoId(repoPath: string, pathKey: (p: string) => string): string {
  return `repo:${pathKey(repoPath)}`;
}

function finalizeLevel(
  nodes: Map<string, InternalNode>,
  parentId: string | null,
  sourceId: string | undefined,
  repoSort: RepoSort,
  pathKey: (p: string) => string,
  hiddenRepoKeys?: ReadonlySet<string>
): GitRepoTreeNode[] {
  const projected: GitRepoTreeNode[] = [];
  for (const node of nodes.values()) {
    const absPath = node.repo?.path ?? node.absPath;
    // A hidden parent keeps its ID so descendants and the expanded state stay in place.
    const id = node.repo ? repoId(absPath, pathKey) : `folder:${JSON.stringify([sourceId, pathKey(absPath)])}`;
    const children = finalizeLevel(node.children, id, sourceId, repoSort, pathKey, hiddenRepoKeys);
    const repo = node.repo && !hiddenRepoKeys?.has(pathKey(absPath)) ? node.repo : undefined;
    if (!repo && children.length === 0) continue;
    projected.push({ id, parentId, kind: repo ? 'repo' : 'folder', label: node.label,
      absPath, repo, expandable: children.length > 0, children });
  }
  return projected.sort((a, b) => {
    if (repoSort !== 'name') {
      const order = a.repo && b.repo
        ? compareRepoActivity(a.repo, b.repo, repoSort)
        : Number(Boolean(a.repo)) - Number(Boolean(b.repo));
      if (order) return order;
    }
    return compareLabels(a.label, b.label);
  });
}

function insertRepo(
  level: Map<string, InternalNode>,
  segments: string[],
  repo: GitRepoSummary,
  workspacePath: string,
  pathKey: (p: string) => string
): void {
  const sep = getSep(workspacePath);
  let currentMap = level;
  let currentAbs = normalizeSep(workspacePath, sep);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    currentAbs = joinAbsPath(currentAbs, segment);
    const key = pathKey(segment);
    let node = currentMap.get(key);
    if (!node) {
      node = { label: segment, absPath: currentAbs, children: new Map() };
      currentMap.set(key, node);
    }
    if (i === segments.length - 1) {
      node.label = segment;
      node.repo = repo;
    }
    currentMap = node.children;
  }
}

function buildWorkspaceTree(
  repos: GitRepoSummary[],
  workspacePath: string,
  repoSort: RepoSort,
  pathKey: (p: string) => string,
  hiddenRepoKeys: ReadonlySet<string> | undefined,
  source?: WorkspaceRoot
): GitRepoTreeNode[] {
  const level = new Map<string, InternalNode>();
  let rootRepo: GitRepoSummary | undefined;
  for (const repo of repos) {
    const segments = getRelativeSegments(repo.path, workspacePath, pathKey);
    if (!segments) continue;
    if (segments.length === 0) rootRepo = repo;
    else insertRepo(level, segments, repo, workspacePath, pathKey);
  }

  if (!source && !rootRepo) return finalizeLevel(level, null, undefined, repoSort, pathKey, hiddenRepoKeys);
  const id = rootRepo ? repoId(rootRepo.path, pathKey) : `source:${JSON.stringify(source!.id)}`;
  const children = finalizeLevel(level, id, source?.id, repoSort, pathKey, hiddenRepoKeys);
  const repo = rootRepo && !hiddenRepoKeys?.has(pathKey(rootRepo.path)) ? rootRepo : undefined;
  if (!source && !repo && children.length === 0) return [];
  const label = source?.label?.trim() || workspacePath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || workspacePath;
  return [{ id, parentId: null, kind: repo ? 'repo' : source ? 'source-root' : 'folder', label,
    sourceRoot: !!source, absPath: rootRepo?.path ?? workspacePath, repo,
    expandable: children.length > 0, children }];
}

function buildExternalRoot(
  repos: GitRepoSummary[],
  repoSort: RepoSort,
  pathKey: (p: string) => string
): GitRepoTreeNode {
  const sorted = [...repos].sort((a, b) => compareRepoActivity(a, b, repoSort) || compareLabels(a.name, b.name));
  const children: GitRepoTreeNode[] = sorted.map(repo => ({
    id: repoId(repo.path, pathKey), parentId: 'external-root', kind: 'repo',
    label: repo.name, absPath: repo.path, repo, expandable: false, children: []
  }));
  return {
    id: 'external-root',
    parentId: null,
    kind: 'external-root',
    label: '外部',
    expandable: children.length > 0,
    children
  };
}

export function buildGitRepoTree(opts: {
  repos: GitRepoSummary[];
  /** Hidden repositories in `repos` can supply a folder for visible descendants. */
  hiddenRepoKeys?: ReadonlySet<string>;
  workspacePath: string;
  workspaceRoots?: readonly WorkspaceRoot[];
  repoSort: RepoSort;
  pathKey?: (p: string) => string;
}): GitRepoTreeNode[] {
  const pathKey = opts.pathKey ?? defaultPathKey;
  const { hiddenRepoKeys } = opts;
  const seen = new Set<string>();
  const repos = opts.repos.filter(repo => {
    const key = pathKey(repo.path);
    if (repo.worktree || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (opts.workspaceRoots && opts.workspaceRoots.length > 1) {
    const worktreePaths = new Set(opts.repos.filter(repo => repo.worktree).map(repo => pathKey(repo.path)));
    const sources = opts.workspaceRoots;
    const bySpecificity = [...sources].sort((a, b) => pathKey(b.path).length - pathKey(a.path).length);
    const buckets = new Map(sources.map(root => [root.id, [] as GitRepoSummary[]]));
    const external: GitRepoSummary[] = [];
    for (const repo of repos) {
      const owner = repo.rootId !== undefined
        ? sources.find(root => root.id === repo.rootId)
        : bySpecificity.find(root => isInsideWorkspace(repo.path, root.path, pathKey));
      if (owner) buckets.get(owner.id)!.push(repo);
      else if (!hiddenRepoKeys?.has(pathKey(repo.path))) external.push(repo);
    }
    const roots = sources.flatMap(source => buildWorkspaceTree(buckets.get(source.id)!, source.path, opts.repoSort, pathKey, hiddenRepoKeys,
      worktreePaths.has(pathKey(source.path)) ? undefined : source));
    if (external.length) roots.push(buildExternalRoot(external, opts.repoSort, pathKey));
    return roots;
  }
  const inside: GitRepoSummary[] = [];
  const outside: GitRepoSummary[] = [];

  for (const repo of repos) {
    if (isInsideWorkspace(repo.path, opts.workspacePath, pathKey)) {
      inside.push(repo);
    } else if (!hiddenRepoKeys?.has(pathKey(repo.path))) {
      outside.push(repo);
    }
  }

  const roots: GitRepoTreeNode[] = [];

  if (outside.length > 0) {
    roots.push(buildExternalRoot(outside, opts.repoSort, pathKey));
  }

  roots.push(...buildWorkspaceTree(inside, opts.workspacePath, opts.repoSort, pathKey, hiddenRepoKeys));

  return roots;
}

/** 全树 id → 从根到该节点的 id 链路（含自身），供选中定位展开祖先。
 *  覆盖整棵树（含折叠节点）——只依赖树结构，不随 expanded 变化，
 *  调用方可用它做 memo，避免展开/收起重跑依赖祖先链的 effect。 */
export function buildChainById(roots: GitRepoTreeNode[]): Map<string, string[]> {
  const chainById = new Map<string, string[]>();
  const walk = (nodes: GitRepoTreeNode[], parentChain: string[]): void => {
    for (const node of nodes) {
      const chain = [...parentChain, node.id];
      chainById.set(node.id, chain);
      if (node.children.length > 0) walk(node.children, chain);
    }
  };
  walk(roots, []);
  return chainById;
}

export function flattenGitRepoTree(
  roots: GitRepoTreeNode[],
  expanded: ReadonlySet<string>
): {
  items: Array<{ node: GitRepoTreeNode; depth: number }>;
  rows: TreeNavRow[];
} {
  const items: Array<{ node: GitRepoTreeNode; depth: number }> = [];
  const rows: TreeNavRow[] = [];

  const visit = (nodes: GitRepoTreeNode[], depth: number): void => {
    for (const node of nodes) {
      items.push({ node, depth });
      rows.push({
        id: node.id,
        parentId: node.parentId,
        expandable: node.expandable,
        expanded: expanded.has(node.id)
      });
      if (expanded.has(node.id) && node.children.length > 0) {
        visit(node.children, depth + 1);
      }
    }
  };

  visit(roots, 0);

  return { items, rows };
}
