import path from 'node:path';
import fs from 'node:fs';
import type { NestedRepoSkipInfo } from '../../shared/types';
import { pathKey } from '../pathKey';
import { findGitRootsDetailed, isPathInsideWorkspace, type GitScanIssue, type GitScanResult } from './scan';
import { inspectNestedRepoHealth, NESTED_REPO_SCAN_DEPTH, type NestedRepoDiscovery } from './nestedRepos';
import { readGitDirectories } from './repoIdentity';
import { filterGitignoreExcludedRepos } from './gitignoreFilter';

interface DiscoverySnapshot {
  root: string;
  roots: string[];
  issues: GitScanIssue[];
  unhealthy: Map<string, Omit<NestedRepoSkipInfo, 'path'>>;
  identities: Map<string, string>;
  healthReads?: Promise<void>;
  isolationRoots?: string[];
}

/** Cheap entry/identity checks do not traverse directories or launch Git. */
function topologyIdentity(repo: string): { key: string; gitDir: string; commonKey: string; linked: boolean } | null {
  try {
    if (!fs.statSync(repo).isDirectory()) return null;
    const dirs = readGitDirectories(repo);
    if (!dirs) return null;
    const gitKey = pathKey(fs.realpathSync(dirs.gitDir));
    const commonKey = pathKey(fs.realpathSync(dirs.commonDir));
    const stat = fs.statSync(dirs.commonDir);
    return { key: JSON.stringify([pathKey(fs.realpathSync(repo)), gitKey, commonKey, stat.dev, stat.ino, stat.birthtimeMs]),
      gitDir: dirs.gitDir, commonKey, linked: gitKey !== commonKey };
  } catch { return null; }
}

/**
 * Repository topology is refreshed explicitly, independently of status/branch caches.
 * A workspace snapshot also serves nested discovery for every source repo inside it.
 * No TTL or directory mtime: filesystem noise must not trigger another deep traversal.
 */
export class GitRepoDiscoveryCache {
  private snapshots = new Map<string, { root: string; value: Promise<DiscoverySnapshot> }>();
  /** Independent source roots scan in parallel; the same physical root stays ordered. */
  private scanQueues = new Map<string, Promise<void>>();

  /** An app-owned init changes topology; the next reader refreshes the affected scope. */
  invalidateContaining(repoPath: string): void {
    const root = path.resolve(repoPath);
    for (const [key, entry] of this.snapshots) {
      if (isPathInsideWorkspace(root, entry.root) || isPathInsideWorkspace(entry.root, root)) {
        this.snapshots.delete(key);
      }
    }
  }

  private get(rootPath: string, force = false): Promise<DiscoverySnapshot> {
    const root = path.resolve(rootPath);
    if (force) {
      // The fresh enclosing snapshot replaces earlier per-repo snapshots too.
      for (const [key, entry] of this.snapshots) {
        if (isPathInsideWorkspace(entry.root, root)) this.snapshots.delete(key);
      }
    } else {
      const enclosing = [...this.snapshots.values()]
        .filter(entry => isPathInsideWorkspace(root, entry.root))
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (enclosing) return enclosing.value;
    }
    const key = pathKey(root);
    const laneKey = pathKey(root);
    const previous = this.scanQueues.get(laneKey) ?? Promise.resolve();
    const value = previous.then(() => this.scan(root)).catch(error => {
      if (this.snapshots.get(key)?.value === value) this.snapshots.delete(key);
      throw error;
    });
    const lane = value.then(() => undefined, () => undefined);
    this.scanQueues.set(laneKey, lane);
    void lane.then(() => { if (this.scanQueues.get(laneKey) === lane) this.scanQueues.delete(laneKey); });
    this.snapshots.set(key, { root, value });
    return value;
  }

  private async scan(root: string): Promise<DiscoverySnapshot> {
    const { roots, issues } = await findGitRootsDetailed(root, NESTED_REPO_SCAN_DEPTH);
    // A parent ignores files it does not own, including independent plugin repos.
    // Browsing membership comes from .git entries, never the parent's ignore rules.
    const unhealthy: DiscoverySnapshot['unhealthy'] = new Map();
    const identities: DiscoverySnapshot['identities'] = new Map();
    for (const repo of roots) {
      const identity = topologyIdentity(repo);
      if (identity) identities.set(pathKey(repo), identity.key);
    }
    return { root, roots, issues, unhealthy, identities };
  }

  /** Isolation preflight needs commit health; directory browsing does not. */
  private inspectHealth(snapshot: DiscoverySnapshot): Promise<void> {
    if (snapshot.healthReads) return snapshot.healthReads;
    // Preserve automatic isolation's existing ignore policy for reference clones.
    // It is independent of the complete browsing topology.
    const reads = (async () => {
      const candidates = await filterGitignoreExcludedRepos(snapshot.root, snapshot.roots);
      snapshot.isolationRoots = candidates;
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
        while (cursor < candidates.length) {
          const repo = candidates[cursor++]!;
          const health = await inspectNestedRepoHealth(repo);
          if (!health.ok) snapshot.unhealthy.set(pathKey(repo), { reason: health.reason, detail: health.detail });
        }
      }));
    })();
    snapshot.healthReads = reads.catch(error => { snapshot.healthReads = undefined; throw error; });
    return snapshot.healthReads;
  }

  async roots(rootPath: string, force = false): Promise<string[]> {
    const root = path.resolve(rootPath);
    const snapshot = await this.get(root, force);
    return snapshot.roots.filter(repo => isPathInsideWorkspace(repo, root) && topologyIdentity(repo) !== null);
  }

  /** Ancestors serve overlapping roots; force refresh replaces each physical scope once. */
  async rootsMany(rootPaths: readonly string[], force = false): Promise<string[]> {
    return (await this.rootsManyDetailed(rootPaths, force)).roots;
  }

  async rootsManyDetailed(rootPaths: readonly string[], force = false): Promise<GitScanResult> {
    const scopes = [...new Map(rootPaths.map(root => [pathKey(path.resolve(root)), path.resolve(root)])).values()]
      .sort((a, b) => a.length - b.length);
    const visited: string[] = [];
    const repos = new Map<string, string>();
    const issues = new Map<string, GitScanIssue>();
    const selected = scopes.filter(root => !scopes.some(parent => parent !== root && isPathInsideWorkspace(root, parent)));
    const snapshots = await Promise.all(selected.map(root => this.get(root, force)));
    for (const [index, root] of selected.entries()) {
      if (visited.some(parent => isPathInsideWorkspace(root, parent))) continue;
      const snapshot = snapshots[index]!;
      for (const repo of snapshot.roots) if (isPathInsideWorkspace(repo, root) && topologyIdentity(repo) !== null) repos.set(pathKey(repo), repo);
      for (const issue of snapshot.issues) if (isPathInsideWorkspace(issue.path, root) || isPathInsideWorkspace(root, issue.path)) {
        issues.set(pathKey(issue.path), issue);
      }
      visited.push(root);
    }
    return { roots: [...repos.values()], issues: [...issues.values()] };
  }

  async nested(mainRepo: string, excludedPaths: readonly string[] = [], includeIgnored = false): Promise<NestedRepoDiscovery> {
    const root = path.resolve(mainRepo);
    const snapshot = await this.get(root);
    const excluded = (repo: string) => excludedPaths.some(parent => isPathInsideWorkspace(repo, parent));
    const incomplete = snapshot.issues.find(issue => !excluded(issue.path)
      && (isPathInsideWorkspace(issue.path, root) || isPathInsideWorkspace(root, issue.path)));
    if (incomplete) throw new Error(`Repository discovery incomplete: ${incomplete.path}: ${incomplete.message}`);
    await this.inspectHealth(snapshot);
    const candidates = includeIgnored ? snapshot.roots : snapshot.isolationRoots!;
    const healthy: string[] = [];
    const skipped: NestedRepoSkipInfo[] = [];
    const linkedRoots: string[] = [];
    const commonDirs = new Set([topologyIdentity(root)?.commonKey].filter((key): key is string => !!key));
    for (const repo of candidates) {
      if (pathKey(repo) === pathKey(root) || !isPathInsideWorkspace(repo, root) || excluded(repo)) continue;
      if (linkedRoots.some(parent => isPathInsideWorkspace(repo, parent))) continue;
      const rel = path.relative(root, repo).replace(/\\/g, '/');
      const identity = topologyIdentity(repo);
      if (!identity) {
        skipped.push({ path: rel, reason: fs.existsSync(repo) ? 'missing-head' : 'missing-directory', detail: `Repository entry no longer exists: ${repo}` });
        continue;
      }
      if (identity.linked || commonDirs.has(identity.commonKey)) { linkedRoots.push(repo); continue; }
      commonDirs.add(identity.commonKey);
      const cachedIdentity = snapshot.identities.get(pathKey(repo));
      if (cachedIdentity && cachedIdentity !== identity.key) {
        skipped.push({ path: rel, reason: 'identity-changed', detail: `Repository identity changed; refresh repositories: ${repo}` });
        continue;
      }
      if (!fs.existsSync(path.join(identity.gitDir, 'HEAD'))) {
        skipped.push({ path: rel, reason: 'missing-head', detail: `Repository HEAD no longer exists: ${repo}` });
        continue;
      }
      // Explicitly selected subtrees may include repositories ignored by their
      // parents. They were not health-checked by the automatic-isolation cache.
      const extraHealth = includeIgnored && !snapshot.isolationRoots!.includes(repo) ? await inspectNestedRepoHealth(repo) : undefined;
      const health = extraHealth && !extraHealth.ok
        ? { reason: extraHealth.reason, detail: extraHealth.detail } : snapshot.unhealthy.get(pathKey(repo));
      if (health) skipped.push({ path: rel, ...health });
      else healthy.push(rel);
    }
    healthy.sort();
    skipped.sort((a, b) => a.path.localeCompare(b.path));
    return { healthy, skipped };
  }
}
