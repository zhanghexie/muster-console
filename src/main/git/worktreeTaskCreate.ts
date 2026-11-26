import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppConfig, GitWorktreeCreationResidual, NestedRepoSkipInfo, SessionWorktreeGroups, WorkspaceWorktreeGroupSelection } from '../../shared/types';
import type { GitService } from './service';
import type { SessionTarget } from '../sessions/targets';
import { assertSessionTargetCurrent } from '../sessions/targets';
import { controlRootFor, requireSourceRoot, requireWorkspace, resolveRealPathInsideRoot, sourcePathKey } from '../workspacePaths';
import { workspaceRootUsesFor } from '../workspaceRootUses';
import { isPathInsideWorkspace } from './scan';
import { readGitDirectories, resolveRepoIdentity, type RepoIdentity } from './repoIdentity';
import { pathKey } from '../pathKey';
import { normalizeRepoSetInput, nestedWorktreePath } from './nestedRepos';
import { assertPreparedWorktreeGroupCurrent, assertPreparedWorktreeCwd, type PreparedWorktreeGroup } from './worktreeCreatePlan';
import { rollbackPreparedTrees } from './worktreeRollback';
import { validateSessionWorktreeGroups } from '../../shared/sessionWorktrees';

type Config = { get(): AppConfig };
export type TaskWorktreeCreateResult = {
  ok: true; state: SessionWorktreeGroups; cwd: string; warnings: string[];
  skipped: Array<{ rootId: string; mainRepo: string; repos: NestedRepoSkipInfo[] }>;
  /** Host-only publication guard/cleanup; never serialized into SessionMeta. */
  assertCurrent(): void;
  rollback(): Promise<GitWorktreeCreationResidual[]>;
} | { ok: false; message: string; residuals: GitWorktreeCreationResidual[] };

/** This input validator is also used before the session creator's first await. */
export function normalizeWorktreeGroupSelections(input: unknown): WorkspaceWorktreeGroupSelection[] {
  if (!Array.isArray(input) || !input.length) throw new Error('isolationGroups must contain rooted repository selections');
  return input.map(selection => {
    if (!selection || typeof selection.rootId !== 'string' || !selection.rootId.trim() || typeof selection.relativePath !== 'string') throw new Error('invalid isolation group source');
    const relativePath = selection.relativePath.replace(/\\/g, '/');
    if (relativePath.includes('\0') || relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath) || (relativePath && relativePath.split('/').some((part: string) => !part || part === '.' || part === '..'))) throw new Error('invalid isolation repository relative path');
    const normalized = normalizeRepoSetInput(selection.repoSet);
    if (!normalized.ok) throw new Error(normalized.message);
    return { rootId: selection.rootId, relativePath, ...(selection.repoSet !== undefined ? { repoSet: normalized.paths } : {}) };
  });
}

/** All groups are prepared before materialization; provisioning starts after all succeed. */
export async function createTaskWorktreeGroups(ctx: { config: Config; git: GitService }, input: {
  target: SessionTarget; sessionId: string; selections: WorkspaceWorktreeGroupSelection[];
  provisionCommands: string[];
  preserveCwd?: boolean;
  /** Host-owned append lock: includes members inferred from selected ancestor groups. */
  holdRepository?: (commonKey: string) => void;
  /** Host-owned per-repository preparation, after complete task materialization. */
  groupProvisionCommands?: ReadonlyArray<{ rootId: string; relativePath: string; commands: string[] }>;
}): Promise<TaskWorktreeCreateResult> {
  const selections = normalizeWorktreeGroupSelections(input.selections);
  const sessionId = input.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('task session identity required');
  const validCommands = (value: unknown): value is string[] => Array.isArray(value) && value.every(command => typeof command === 'string' && !!command.trim() && !command.includes('\0'));
  if (!validCommands(input.provisionCommands)) throw new Error('invalid worktree preparation commands');
  const commands = [...input.provisionCommands];
  const groupCommands = structuredClone(input.groupProvisionCommands ?? []);
  if (!Array.isArray(groupCommands) || groupCommands.some(provision => !provision || !validCommands(provision.commands))) throw new Error('invalid repository preparation commands');
  normalizeWorktreeGroupSelections(groupCommands.length ? groupCommands : selections);
  const captured = ctx.config.get();
  const capturedStorageRoot = captured.worktreeStorageRoot;
  const target = structuredClone(input.target);
  const workspace = requireWorkspace(captured, input.target.workspaceId);
  const workspaceId = workspace.id;
  const roots = selections.map(selection => {
    const root = requireSourceRoot(workspace, selection.rootId);
    return { selection, root: { ...root }, physical: sourcePathKey(root.path) };
  });
  // Acquire every selected source synchronously, including an already archived owner.
  const releases = [...new Set([...roots.map(item => item.root.id), target.sourceRoot.rootId])].map(rootId => workspaceRootUsesFor(ctx.config).acquire({
    workspaceId, rootId, kind: 'launch', id: sessionId, sessionId, label: 'worktree creation'
  }));
  const prepared: Array<{ plan: PreparedWorktreeGroup; rootId: string; rootPath: string; sourceCwd: string; skipped: NestedRepoSkipInfo[] }> = [];
  const created: typeof prepared = [];
  const residuals: GitWorktreeCreationResidual[] = [];
  const assertCurrent = () => {
    assertSessionTargetCurrent(ctx.config.get(), target);
    const current = requireWorkspace(ctx.config.get(), workspaceId);
    if (sourcePathKey(controlRootFor(current)) !== target.controlKey || ctx.config.get().worktreeStorageRoot !== capturedStorageRoot) throw new Error('task worktree management or storage scope changed');
    for (const item of roots) if (sourcePathKey(requireSourceRoot(current, item.root.id).path) !== item.physical) throw new Error(`task source folder changed: ${item.root.id}`);
  };
  const assertTaskTreesCurrent = () => {
    assertCurrent();
    for (const item of created) for (const repo of [item.plan.main, ...item.plan.nested]) {
      const tree = nestedWorktreePath(item.plan.path, repo.relativePath);
      const dirs = readGitDirectories(tree);
      if (sourcePathKey(tree) !== pathKey(tree) || !dirs || sourcePathKey(dirs.commonDir) !== repo.commonKey || pathKey(dirs.gitDir) === pathKey(dirs.commonDir)
        || readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8').trim() !== `ref: refs/heads/${item.plan.branch}`) throw new Error(`task worktree identity changed: ${tree}`);
    }
  };
  const rollback = async () => {
    for (const item of [...created].reverse()) residuals.push(...await rollbackPreparedTrees([
      { repo: item.plan.main, path: item.plan.path, branch: item.plan.branch },
      ...item.plan.nested.map(repo => ({ repo, path: nestedWorktreePath(item.plan.path, repo.relativePath), branch: item.plan.branch }))
    ]));
    ctx.git.invalidateRepoCaches(prepared.flatMap(item => [item.plan.main.mainRepo, item.plan.path, ...item.plan.nested.flatMap(repo => [repo.mainRepo, nestedWorktreePath(item.plan.path, repo.relativePath)])]));
    return residuals;
  };
  try {
    const candidates: Array<(typeof roots)[number] & { sourceCwd: string; repositoryPath: string; identity: RepoIdentity }> = [];
    for (const item of roots) {
      assertCurrent();
      const sourceCwd = await resolveRealPathInsideRoot(item.root.path, item.selection.relativePath);
      const physical = await fs.realpath(sourceCwd);
      const identity = await resolveRepoIdentity(sourceCwd, [sourceCwd]);
      if (!identity || sourcePathKey(identity.root) !== sourcePathKey(physical) || identity.linked) throw new Error(`selected source is not a primary Git repository: ${sourceCwd}`);
      candidates.push({ ...item, sourceCwd, repositoryPath: await fs.realpath(identity.mainRepo), identity });
    }
    // Physical duplicates and nested selected roots share one actual container group.
    const representatives = candidates.filter((candidate, i) => !candidates.some((other, j) =>
      i !== j && isPathInsideWorkspace(candidate.repositoryPath, other.repositoryPath)
        && (sourcePathKey(candidate.identity.mainRepo) !== sourcePathKey(other.identity.mainRepo) || j < i)));
    const repositoryIds = new Set<string>();
    for (const item of representatives) {
      assertCurrent();
      let repoSet = item.selection.repoSet;
      if (repoSet !== undefined) {
        repoSet = [...repoSet];
        const children = candidates.filter(child => child !== item && isPathInsideWorkspace(child.repositoryPath, item.repositoryPath));
        const discovery = children.some(child => child.selection.repoSet === undefined)
          ? await ctx.git.discoverNestedReposDetailedFor(item.sourceCwd, { workspaceId, includeIgnored: true }) : { healthy: [], skipped: [] };
        for (const child of children) {
          if (sourcePathKey(child.identity.mainRepo) === sourcePathKey(item.identity.mainRepo)) {
            if (child.selection.repoSet === undefined) { repoSet = undefined; break; }
            repoSet.push(...child.selection.repoSet);
            continue;
          }
          const relative = path.relative(item.repositoryPath, child.repositoryPath).split(path.sep).join('/');
          repoSet.push(relative, ...(child.selection.repoSet !== undefined
            ? child.selection.repoSet.map(member => `${relative}/${member}`)
            : discovery.healthy.filter(member => member.startsWith(`${relative}/`))));
        }
      }
      const value = await ctx.git.prepareSessionWorktreeGroup(item.sourceCwd, sessionId, repoSet, workspaceId);
      for (const repo of [value.plan.main, ...value.plan.nested]) {
        input.holdRepository?.(repo.commonKey);
        if (repositoryIds.has(repo.commonKey)) throw new Error(`source repository appears in multiple groups: ${repo.mainRepo}`);
        repositoryIds.add(repo.commonKey);
      }
      prepared.push({ ...value, rootId: item.root.id, rootPath: item.root.path, sourceCwd: item.sourceCwd });
    }
    assertCurrent();
    const primary = prepared.find(item => isPathInsideWorkspace(sourcePathKey(target.cwd), sourcePathKey(item.plan.main.mainRepo))) ?? (input.preserveCwd ? prepared[0] : undefined);
    if (!primary) throw new Error('current working directory is outside the selected isolation groups');
    const originalCwd = await fs.realpath(target.cwd);
    if (!input.preserveCwd) await assertPreparedWorktreeCwd(primary.plan, originalCwd);
    // Resolve every preparation recipe before creating directories or running commands.
    const provisions: Array<{ cwd: string; commands: string[] }> = [];
    for (const provision of groupCommands) {
      const source = roots.find(item => item.root.id === provision.rootId);
      if (!source) throw new Error('repository preparation source was not selected');
      const originalPath = await resolveRealPathInsideRoot(source.root.path, provision.relativePath);
      const physical = await fs.realpath(originalPath);
      const owner = prepared.find(item => isPathInsideWorkspace(physical, item.plan.main.mainRepo));
      if (!owner) throw new Error('repository preparation target was not isolated');
      const relative = path.relative(owner.plan.main.mainRepo, physical).split(path.sep).join('/');
      if (relative && !owner.plan.nested.some(repo => repo.relativePath === relative)) throw new Error(`repository preparation requires an isolated repository root: ${relative}; selected: ${owner.plan.nested.map(repo => repo.relativePath).join(', ')}`);
      provisions.push({ cwd: nestedWorktreePath(owner.plan.path, relative), commands: provision.commands });
    }
    const beforeCreate = async () => {
      assertCurrent();
      if (sourcePathKey(target.cwd) !== sourcePathKey(originalCwd)) throw new Error('task working directory identity changed');
      for (const item of prepared) await assertPreparedWorktreeGroupCurrent(item.plan);
      assertCurrent();
    };
    for (const item of prepared) {
      const result = await ctx.git.materializeSessionWorktreeGroup(item.plan, beforeCreate);
      if (!result.ok || !result.path) { residuals.push(...(result.creationResiduals ?? [])); throw new Error(result.message ?? 'worktree creation failed'); }
      created.push(item);
    }
    await beforeCreate();
    const idFor = (item: (typeof prepared)[number]) => createHash('sha256').update(`${item.rootId}\0${item.plan.main.commonKey}`).digest('hex').slice(0, 20);
    const state: SessionWorktreeGroups = { version: 1, ...(input.preserveCwd ? { cwdPolicy: 'source' as const, revision: 1 } : {}), primaryGroupId: idFor(primary), groups: prepared.map(item => ({
      id: idFor(item), path: item.plan.path, branch: item.plan.branch, baseBranch: item.plan.main.baseBranch, baseCommit: item.plan.main.baseCommit,
      sourceRoot: { rootId: item.rootId, path: item.rootPath, cwd: !input.preserveCwd && item === primary ? target.sourceRoot.cwd : item.sourceCwd, physicalPath: sourcePathKey(item.rootPath) },
      source: { mainRepo: item.plan.main.mainRepo, commonDir: item.plan.main.commonDir },
      repos: item.plan.nested.map(repo => ({ path: repo.relativePath, branch: item.plan.branch, baseBranch: repo.baseBranch, baseCommit: repo.baseCommit, kind: repo.kind }))
    })), sourceRoots: [...new Map(roots.map(item => [item.root.id, { rootId: item.root.id, path: item.root.path, cwd: item.root.path, physicalPath: item.physical }])).values()] };
    validateSessionWorktreeGroups(state);
    const cwd = input.preserveCwd ? target.cwd : path.join(primary.plan.path, path.relative(primary.plan.main.mainRepo, originalCwd));
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error(`mapped working directory is missing from the committed baseline: ${cwd}`);
    const warnings = prepared.flatMap(item => [item.plan.main, ...item.plan.nested].filter(repo => repo.dirtyPaths.length)
      .map(repo => `Source changes were not copied into the task: ${repo.mainRepo}: ${repo.dirtyPaths.slice(0, 20).join(', ')}`));
    const environment = { MUSTER_WORKSPACE_ID: workspaceId, MUSTER_WORKSPACE_CONTROL_ROOT: target.controlRoot,
      MUSTER_WORKTREE_PRIMARY: primary.plan.path,
      MUSTER_WORKTREE_GROUPS_JSON: JSON.stringify(state.groups.map(group => ({ rootId: group.sourceRoot!.rootId, sourcePath: group.source!.mainRepo, worktreePath: group.path }))) };
    // Existing commands retain one invocation at the primary group. Named group commands
    // run at their mapped repository after every group (and nested member) exists.
    assertTaskTreesCurrent();
    if (commands.length) {
      const warning = await ctx.git.runWorktreeProvision(primary.plan.path, commands, environment, assertTaskTreesCurrent);
      if (warning) warnings.push(warning);
    }
    for (const provision of provisions) {
      assertTaskTreesCurrent();
      const warning = await ctx.git.runWorktreeProvision(provision.cwd, provision.commands, environment, assertTaskTreesCurrent);
      if (warning) warnings.push(warning);
    }
    assertTaskTreesCurrent();
    return { ok: true, state, cwd, warnings, assertCurrent: assertTaskTreesCurrent, rollback, skipped: prepared.filter(item => item.skipped.length).map(item => ({ rootId: item.rootId, mainRepo: item.plan.main.mainRepo, repos: item.skipped })) };
  } catch (error) {
    await rollback();
    return { ok: false, message: String((error as Error).message ?? error), residuals };
  } finally { for (const release of releases) release(); }
}
