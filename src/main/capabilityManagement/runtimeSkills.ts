import path from 'node:path';
import type { CapabilityTargetId } from '../../shared/capabilityManagement';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import type { RuntimeSkillFilter, SkillsManagementService } from './skills';
import { sourcePathKey } from '../workspacePaths';

let service: SkillsManagementService | undefined;
export function setSkillsManagementService(value: SkillsManagementService | undefined): void {
  service = value;
}
export function hasSkillsManagementService(): boolean { return !!service; }
function sourceProjects(cwd: string, context?: WorkspaceExecutionContext): string[] {
  // A shared source folder can belong to multiple workspaces. The captured management
  // root is the policy namespace; the service expands it to that workspace's sources.
  return context ? [context.controlRoot] : [cwd];
}
export function managedSkillPaths(cwd: string, target: CapabilityTargetId, context?: WorkspaceExecutionContext): string[] {
  if (!service) return [];
  const globalPaths = new Set(service.additionalSkillPaths([], target).map(sourcePathKey));
  return service.additionalSkillPaths(sourceProjects(cwd, context), target).map(directory => {
    if (globalPaths.has(sourcePathKey(directory))) return directory;
    const mapping = [...(context?.mappings ?? [])].sort((a, b) => b.sourcePath.length - a.sourcePath.length).find(item => {
      const relative = path.relative(sourcePathKey(item.sourcePath), sourcePathKey(directory));
      return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    });
    return mapping ? path.join(mapping.worktreePath, path.relative(mapping.sourcePath, directory)) : directory;
  });
}
export function managedGlobalSkillPaths(target: CapabilityTargetId): string[] {
  return service?.additionalSkillPaths([], target) ?? [];
}
/** Policy uses source identity, while resource loading keeps the captured worktree file. */
export function filterManagedRuntimeSkills<T extends { filePath: string; name?: string }>(
  skills: T[], cwd: string, target: CapabilityTargetId, context?: WorkspaceExecutionContext, prepared?: RuntimeSkillFilter
): T[] {
  if (!service && !prepared) return skills;
  const candidates = skills.map(skill => {
    const mapping = context?.mappings.find(item => {
      const rel = path.relative(sourcePathKey(item.worktreePath), sourcePathKey(skill.filePath));
      return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
    });
    const filePath = mapping ? path.join(mapping.sourcePath, path.relative(mapping.worktreePath, skill.filePath)) : skill.filePath;
    return { ...skill, filePath, originalSkill: skill };
  });
  return (prepared ? prepared(candidates) : service!.filterRuntimeSkills(candidates, target, sourceProjects(cwd, context))).map(candidate => candidate.originalSkill);
}

export async function prepareManagedRuntimeSkillFilter(cwd: string, target: CapabilityTargetId,
  context?: WorkspaceExecutionContext): Promise<RuntimeSkillFilter> {
  const captured = service;
  const filter: RuntimeSkillFilter = captured ? await captured.prepareRuntimeSkillFilter(target, sourceProjects(cwd, context)) : skills => skills;
  return skills => {
    if (captured !== service) throw new Error('Skill service changed during resource loading; retry the request');
    return filterManagedRuntimeSkills(skills, cwd, target, context, filter);
  };
}
