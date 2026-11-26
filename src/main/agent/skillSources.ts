import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type * as Pi from '@earendil-works/pi-coding-agent';
import type { AgentSkillInfo } from '../../shared/types';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { resolveExtraSkillPaths } from './systemPrompt';
import { sourcePathKey } from '../workspacePaths';
import type { CapabilityTargetId } from '../../shared/capabilityManagement';
import { hasSkillsManagementService, filterManagedRuntimeSkills, managedGlobalSkillPaths, managedSkillPaths, prepareManagedRuntimeSkillFilter } from '../capabilityManagement/runtimeSkills';
import type { RuntimeSkillFilter } from '../capabilityManagement/skills';
import { isPiSkillTarget, piSkillRootPaths } from './piSkillRoots';
import { resolveHostSkillRootDir } from '../metaAgent/hostDomainSkills';

type Result = ReturnType<typeof Pi.loadSkills>;
type SourcedSkill = Pi.Skill & { musterSkill: AgentSkillInfo };
function inside(file: string, dir: string): boolean {
  const rel = path.relative(sourcePathKey(dir), sourcePathKey(file));
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Keep project discovery inside captured source folders, using task copies where mapped. */
export function workspaceSkillFolders(cwd: string, context?: WorkspaceExecutionContext): string[] {
  if (!context) return [cwd];
  return [...new Set([context.cwd, ...context.roots.filter(root => !root.error).map(root => {
    const mapping = context.mappings.find(item => item.rootId === root.rootId && sourcePathKey(item.sourcePath) === sourcePathKey(root.path));
    return mapping?.worktreePath ?? root.path;
  })])];
}

export function workspaceSkillPaths(cwd: string, context?: WorkspaceExecutionContext, target: CapabilityTargetId = 'pi-gui'): string[] {
  if (isPiSkillTarget(target)) {
    const seen = new Set<string>();
    const roots = hasSkillsManagementService() ? managedSkillPaths(cwd, target, context)
      : piSkillRootPaths(os.homedir(), workspaceSkillFolders(cwd, context));
    return roots.filter(directory => {
      try {
        if (!fs.statSync(directory).isDirectory()) return false;
        const key = sourcePathKey(fs.realpathSync.native(directory));
        if (seen.has(key)) return false;
        seen.add(key); return true;
      } catch { return false; }
    });
  }
  return [...new Set([...(hasSkillsManagementService() ? [] : resolveExtraSkillPaths(workspaceSkillFolders(cwd, context))), ...managedSkillPaths(cwd, target, context)])];
}

/** Recover SDK collision losers before assigning commands; never alter SKILL.md/frontmatter. */
export function createSkillSourceOverride(pi: Pick<typeof Pi, 'loadSkills'>,
  cwd: string, agentDir: string, context?: WorkspaceExecutionContext, target: CapabilityTargetId = 'pi-gui',
  filter: RuntimeSkillFilter = skills => filterManagedRuntimeSkills(skills, cwd, target, context)
): (base: Result) => Result & { skills: SourcedSkill[] } {
  const steps = createSkillSourceSteps(pi, cwd, agentDir, context, target, filter);
  return base => {
    const iterator = steps(base);
    let next; do { next = iterator.next(); } while (!next.done);
    return next.value;
  };
}

function createSkillSourceSteps(pi: Pick<typeof Pi, 'loadSkills'>,
  cwd: string, agentDir: string, context: WorkspaceExecutionContext | undefined, target: CapabilityTargetId,
  filter: RuntimeSkillFilter): (base: Result) => Generator<void, Result & { skills: SourcedSkill[] }, void> {
  return function* (base) {
    const candidates = [...base.skills];
    for (const diagnostic of base.diagnostics) {
      yield;
      if (diagnostic.type !== 'collision' || diagnostic.collision?.resourceType !== 'skill') continue;
      const loaded = pi.loadSkills({ cwd, agentDir, skillPaths: [diagnostic.collision.loserPath], includeDefaults: false });
      candidates.push(...loaded.skills);
    }
    const hostRoot = isPiSkillTarget(target) ? resolveHostSkillRootDir() : undefined;
    const hostPhysical = hostRoot ? (() => { try { return sourcePathKey(fs.realpathSync.native(hostRoot)); } catch { return undefined; } })() : undefined;
    const userDirs = isPiSkillTarget(target) ? (hasSkillsManagementService() ? managedGlobalSkillPaths(target) : piSkillRootPaths(os.homedir(), []))
      : (hasSkillsManagementService() ? [] : resolveExtraSkillPaths([])).concat(path.join(agentDir, 'skills'), managedGlobalSkillPaths(target));
    const physicalUsers = userDirs.filter(dir => !hostRoot || sourcePathKey(dir) !== sourcePathKey(hostRoot)).flatMap(dir => { try { return [fs.realpathSync.native(dir)]; } catch { return []; } });
    const seen = new Set<string>(); const skills: SourcedSkill[] = [];
    for (const skill of filter(candidates)) {
      yield;
      const physical = sourcePathKey(fs.realpathSync.native(skill.filePath));
      if (seen.has(physical)) continue;
      seen.add(physical);
      const userDir = physicalUsers.find(dir => inside(physical, dir));
      const roots = context?.roots.filter(root => !root.error && (
        inside(skill.filePath, root.path) || context.mappings.some(mapping => mapping.rootId === root.rootId && inside(skill.filePath, mapping.worktreePath))
      )).sort((a, b) => b.path.length - a.path.length) ?? [];
      const root = roots[0];
      const hostOwned = !!hostPhysical && inside(physical, hostPhysical);
      const user = !hostOwned && (!!userDir || skill.sourceInfo?.scope === 'user');
      const source: NonNullable<AgentSkillInfo['source']> = hostOwned
        ? { kind: 'mode', label: '宿主内置', path: hostRoot ?? skill.baseDir }
        : user
        ? { kind: 'user', label: '~', path: userDir ?? skill.baseDir }
        : root ? { kind: 'project', rootIds: roots.map(root => root.rootId), label: root.label ?? path.basename(root.path), path: root.path }
        : inside(skill.filePath, cwd) ? { kind: 'project', label: path.basename(cwd), path: cwd }
        : { kind: 'mode', label: path.basename(skill.baseDir), path: skill.baseDir };
      const group = user ? 'user' : root ? `root:${encodeURIComponent(root.rootId)}` : source.kind;
      const qualifiedName = `${group}/${skill.name}`;
      const info: AgentSkillInfo = { name: skill.name, description: skill.description, filePath: skill.filePath,
        baseDir: skill.baseDir, physicalFilePath: physical, id: `skill:${physical}`, source, qualifiedName };
      skills.push({ ...skill, musterSkill: info });
    }
    const counts = new Map<string, number>(); const qualifiedCounts = new Map<string, number>();
    for (const skill of skills) {
      counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
      const key = skill.musterSkill.qualifiedName!; qualifiedCounts.set(key, (qualifiedCounts.get(key) ?? 0) + 1);
    }
    for (const skill of skills) {
      const info = skill.musterSkill;
      if (qualifiedCounts.get(info.qualifiedName!)! > 1) {
        const hash = createHash('sha256').update(info.physicalFilePath!).digest('hex').slice(0, 10);
        info.qualifiedName = `${info.qualifiedName}~${hash}`;
      }
      info.commandName = counts.get(info.name)! > 1 ? info.qualifiedName : info.name;
      skill.name = info.commandName!;
    }
    return { skills, diagnostics: base.diagnostics.filter(diagnostic => diagnostic.type !== 'collision' || diagnostic.collision?.resourceType !== 'skill') };
  };
}

/** Every SDK reload prepares fresh policy cooperatively, including native /reload. */
export function createSkillSourceLoader(pi: Pick<typeof Pi, 'loadSkills' | 'DefaultResourceLoader'>,
  options: ConstructorParameters<typeof Pi.DefaultResourceLoader>[0], cwd: string, agentDir: string,
  context?: WorkspaceExecutionContext, target: CapabilityTargetId = 'pi-gui'): Pi.DefaultResourceLoader {
  let filter: RuntimeSkillFilter | undefined;
  const explicit = isPiSkillTarget(target);
  const admit: RuntimeSkillFilter = skills => {
    if (!filter) throw new Error('Skill policy is not ready; reload resources before loading skills');
    return filter(skills);
  };
  const steps = createSkillSourceSteps(pi, cwd, agentDir, context, target, admit);
  const loaderOptions = { ...options,
    ...(explicit ? { musterExplicitSkills: true, noSkills: true, additionalSkillPaths: workspaceSkillPaths(cwd, context, target),
      musterSkillsOverride: async (base: Result) => {
        const iterator = steps(base);
        let started = performance.now(), count = 0;
        while (true) {
          const next = iterator.next();
          if (next.done) {
            // A yield allows policy/service changes; validate again before publication.
            admit([]);
            return next.value;
          }
          if (++count >= 32 || performance.now() - started >= 4) {
            await new Promise<void>(resolve => setImmediate(resolve));
            started = performance.now(); count = 0;
          }
        }
      } } : {}),
    skillsOverride: createSkillSourceOverride(pi, cwd, agentDir, context, target, admit) };
  const loader = new pi.DefaultResourceLoader(loaderOptions);
  const sdk = loader as unknown as { musterSkillDiscoveryVersion?: number; getMusterExplicitSkills?: () => boolean; setMusterSkillPaths?: (paths: string[]) => void };
  if (explicit && (sdk.getMusterExplicitSkills?.() !== true || sdk.musterSkillDiscoveryVersion !== 2 || !sdk.setMusterSkillPaths)) {
    throw new Error('Pi 技能目录兼容补丁未加载：请运行 npm install（或 node scripts/patch-pi-skill-discovery.mjs），然后重启工作台');
  }
  const reload = loader.reload.bind(loader);
  let pending: Promise<void> = Promise.resolve();
  loader.reload = options => {
    const job = pending.then(async () => {
      filter = undefined;
      if (explicit) sdk.setMusterSkillPaths!(workspaceSkillPaths(cwd, context, target));
      filter = await prepareManagedRuntimeSkillFilter(cwd, target, context);
      try { await reload(options); }
      catch (error) { filter = undefined; throw error; }
    });
    pending = job.catch(() => {});
    return job;
  };
  return loader;
}

export function assertSkillFileIdentity(skill: AgentSkillInfo): void {
  if (skill.physicalFilePath && sourcePathKey(fs.realpathSync.native(skill.filePath!)) !== skill.physicalFilePath) {
    throw new Error(`skill file identity changed: ${skill.filePath}`);
  }
}
