import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../context';
import type { CapabilityScope } from '../../shared/capabilityManagement';
import type { CapabilityManagementAPI } from '../../shared/capabilityManagementApi';
import type { WorkspaceInfo } from '../../shared/types';
import { pathKey } from '../pathKey';
import { SkillsManagementService } from '../capabilityManagement/skills';
import { McpManagementService } from '../capabilityManagement/mcpManagement';
import { setSkillsManagementService } from '../capabilityManagement/runtimeSkills';
import { invalidateAgentSkills } from '../agent/skillsList';
import { controlRootFor, sourceRootsFor, sourcePathKey } from '../workspacePaths';
import { handle } from './handle';
import { t } from '../../shared/i18n';
import { CapabilityUsageService, setCapabilityUsageService } from '../capabilityManagement/usage';
import { resolveUsage, type UsageListInput, type UsageSnapshot, type UsageSetInput } from '../../shared/capabilityUsage';

/** Preserve earliest physical management-root precedence, including runtime Junction changes. */
export function capabilityWorkspaceForPath(value: string, registered: WorkspaceInfo[]): WorkspaceInfo | undefined {
  const lexical = pathKey(value);
  // Resolving dot segments before resolving a Junction can change filesystem meaning.
  // Such callers retain the original physical lookup instead of taking a lexical shortcut.
  const plainAbsolute = (file: string): boolean => path.isAbsolute(file) && !/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(file);
  const exact = plainAbsolute(value) ? registered.findIndex(workspace => {
    const root = controlRootFor(workspace);
    return plainAbsolute(root) && pathKey(root) === lexical;
  }) : -1;
  if (exact === 0) return registered[0];
  const key = sourcePathKey(value);
  const management = registered.find((workspace, index) => index === exact || sourcePathKey(controlRootFor(workspace)) === key);
  if (management) return management;
  const sources = registered.filter(workspace => sourceRootsFor(workspace).some(root => sourcePathKey(root.path) === key));
  return sources.length === 1 ? sources[0] : undefined;
}

/** Shared desktop/web handlers. Scope is a registered workspace, never an arbitrary renderer path. */
export function registerCapabilityManagementIpc(ctx: AppContext): void {
  const userDataDir = app.getPath('userData');
  const homeDir = process.env.MUSTER_SANDBOX === '1' ? userDataStorage(userDataDir).resolve('app', 'capability-home') : os.homedir();
  const workspaces = () => ctx.config.get().workspaces.filter(workspace => !workspace.rootsError);
  const workspaceForPath = (value: string) => capabilityWorkspaceForPath(value, workspaces());
  const validateScope = (scope: CapabilityScope): void => {
    if (!scope || !['global', 'project'].includes(scope.kind)) throw new Error(t('无效的技能作用范围'));
    if (scope.kind === 'project' && (!scope.projectPath || !workspaceForPath(scope.projectPath))) throw new Error(t('请先选择有效工作区'));
  };
  const changed = (kind: 'skills' | 'mcp', revision?: number): void => {
    const window = ctx.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('capabilityManagement:changed', { kind, revision });
  };
  let runtimeTopologyRevision = 0;
  const observationVersion = () => JSON.stringify([runtimeTopologyRevision, workspaces().map(workspace => [workspace.id, workspace.rootsRevision,
    controlRootFor(workspace), sourceRootsFor(workspace).map(root => [root.id, root.path])])]);
  const usage = new CapabilityUsageService(userDataStorage(userDataDir).file('capability-usage'), () => {
    invalidateAgentSkills(); changed('skills'); changed('mcp');
  });
  setCapabilityUsageService(usage);
  const skills = new SkillsManagementService({
    homeDir, userDataDir,
    preserveUsageRestrictions: (ids, destination) => usage.preserveSkillRestrictions(ids, destination),
    isUsageAllowed: (id, runtimeId, projects) => {
      return projects.length ? projects.every(project => usage.allows('skill', id, { runtimeId, workspaceId: workspaceForPath(project)?.id })) : usage.allows('skill', id, { runtimeId });
    },
    getProjectPaths: projectPath => {
      if (!projectPath) return workspaces().map(controlRootFor);
      const workspace = workspaceForPath(projectPath);
      return workspace ? sourceRootsFor(workspace).map(root => root.path) : [projectPath];
    },
    resolveProjectScope: projectPath => { const workspace = workspaceForPath(projectPath); return workspace ? controlRootFor(workspace) : undefined; },
    getObservationVersion: observationVersion,
    onInvalidate: invalidateAgentSkills,
    onChanged: revision => changed('skills', revision)
  });
  const mcp = new McpManagementService({ getConfig: () => ctx.config.get(),
    updateConfig: patch => { const cfg = ctx.config.update(patch); changed('mcp'); return cfg; },
    workspaceRoot: id => { const workspace = workspaces().find(item => item.id === id); return workspace ? controlRootFor(workspace) : undefined; }
  });
  ctx.skillsManagement = skills; ctx.mcpManagement = mcp;
  setSkillsManagementService(skills);
  let knownTopology = observationVersion();
  const refreshTopology = (): void => {
    const next = observationVersion();
    if (next === knownTopology) return;
    knownTopology = next; skills.topologyChanged();
  };
  const unsubscribeConfig = ctx.config.onChanged(refreshTopology);
  const unsubscribeRuntimes = ctx.runtimes.onChanged(() => { runtimeTopologyRevision++; refreshTopology(); invalidateAgentSkills(); changed('skills'); });
  app.on('will-quit', () => { unsubscribeConfig(); unsubscribeRuntimes(); mcp.dispose(); skills.dispose(); setSkillsManagementService(undefined); setCapabilityUsageService(undefined); });
  type Api = CapabilityManagementAPI;
  const usageInventory = async (input: UsageListInput): Promise<UsageSnapshot> => {
    if (!input || (input.kind !== undefined && !['skill', 'mcp'].includes(input.kind))) throw new Error(t('无效的能力类别。'));
    const runtimes = ctx.runtimes.list();
    if (input.runtimeId && !runtimes.some(runtime => runtime.id === input.runtimeId)) throw new Error(t('Harness 已不存在，请刷新。'));
    const workspace = input.workspaceId ? workspaces().find(item => item.id === input.workspaceId) : undefined;
    if (input.workspaceId && !workspace) throw new Error(t('工作区已不存在，请刷新。'));
    const policy = usage.snapshot();
    const cfg = ctx.config.get();
    const resources: UsageSnapshot['resources'] = [];
    if (input.kind !== 'mcp') {
      const scope: CapabilityScope = workspace ? { kind: 'project', projectPath: controlRootFor(workspace) } : { kind: 'global' };
      const inventory = skills.list(scope);
      for (const skill of inventory.skills) resources.push({ id: skill.id, kind: 'skill', name: skill.name,
        state: resolveUsage(policy, 'skill', skill.id, input, skill.status === 'valid') });
    }
    if (input.kind !== 'skill') {
      const inventory = await mcp.list(input.workspaceId);
      for (const entry of inventory.servers.filter(entry => !entry.overridden)) resources.push({ id: entry.server.name, kind: 'mcp', name: entry.server.name,
        state: resolveUsage(policy, 'mcp', entry.server.name, input, cfg.mcp.enabled && entry.server.enabled && cfg.mcp.servers.find(server => server.name === entry.server.name)?.enabled !== false) });
    }
    return { revision: policy.revision, resources, runtimes: runtimes.map(({ id, label }) => ({ id, label })),
      categories: { skill: resolveUsage(policy, 'skill', '*', input), mcp: resolveUsage(policy, 'mcp', '*', input, cfg.mcp.enabled) } };
  };
  handle('capabilityManagement:usageList', (_event, input: UsageListInput) => usageInventory(input));
  handle('capabilityManagement:usageSet', async (_event, input: UsageSetInput) => {
    if (!input?.scope || !['global', 'harness', 'workspace'].includes(input.scope.kind)) throw new Error(t('无效的使用范围。'));
    const context = input.scope.kind === 'harness' ? { runtimeId: input.scope.runtimeId } : input.scope.kind === 'workspace' ? { workspaceId: input.scope.workspaceId } : {};
    if ((input.scope.kind === 'harness' && !input.scope.runtimeId) || (input.scope.kind === 'workspace' && !input.scope.workspaceId)) throw new Error(t('无效的使用范围。'));
    // Harness policy also covers project-only skills; include every registered source when validating identity.
    const inventories = [await usageInventory({ ...context, kind: input.kind })];
    if (input.scope.kind !== 'workspace') for (const workspace of workspaces()) inventories.push(await usageInventory({ ...context, workspaceId: workspace.id, kind: input.kind }));
    const known = new Set(inventories.flatMap(inventory => inventory.resources.map(resource => resource.id)));
    if (!Array.isArray(input.resourceIds) || input.resourceIds.some(id => id !== '*' && !known.has(id))) throw new Error(t('能力已不存在，请刷新后重试。'));
    usage.set(input);
  });
  handle('capabilityManagement:skillsList', (_event, scope: Parameters<Api['skillsList']>[0]) => { validateScope(scope); return skills.list(scope); });
  handle('capabilityManagement:readSkill', (_event, id: string, scope: CapabilityScope) => { validateScope(scope); return skills.readSkill(id, scope); });
  handle('capabilityManagement:saveSkill', (_event, input: Parameters<Api['saveSkill']>[0]) => { validateScope(input.scope); return skills.saveSkill(input); });
  handle('capabilityManagement:createSkill', (_event, input: Parameters<Api['createSkill']>[0]) => { validateScope(input.scope); return skills.createSkill(input); });
  handle('capabilityManagement:setPreferred', (_event, input: Parameters<Api['setPreferred']>[0]) => { validateScope(input.scope); return skills.setPreferred(input); });
  handle('capabilityManagement:previewSkillConsolidation', (_event, scope: Parameters<Api['previewSkillConsolidation']>[0], name: string, skillId?: string) => { validateScope(scope); return skills.previewConsolidation(scope, name, skillId); });
  handle('capabilityManagement:consolidateSkill', (_event, input: Parameters<Api['consolidateSkill']>[0]) => { validateScope(input.scope); return skills.consolidate(input); });
  handle('capabilityManagement:refresh', async (_event, scope: CapabilityScope) => {
    validateScope(scope);
    ctx.getWindow()?.webContents.send('runtimes:availabilityChanged', {});
    return skills.refresh(scope);
  });
  handle('capabilityManagement:mcpList', (_event, workspaceId?: string) => mcp.list(workspaceId));
  handle('capabilityManagement:getMcp', (_event, id: string) => mcp.get(id));
  handle('capabilityManagement:saveMcp', async (_event, input: Parameters<Api['saveMcp']>[0]) => { const result = await mcp.save(input); changed('mcp'); return result; });
  handle('capabilityManagement:removeMcp', async (_event, input: Parameters<Api['removeMcp']>[0]) => { await mcp.remove(input); changed('mcp'); });
  handle('capabilityManagement:importMcp', async (_event, input: Parameters<Api['importMcp']>[0]) => { const result = await mcp.importJson(input); changed('mcp'); return result; });
  handle('capabilityManagement:testMcp', async (_event, id: string) => { const result = await mcp.test(id); changed('mcp'); return result; });
  handle('capabilityManagement:setMcpEnabled', async (_event, enabled: boolean, workspaceId?: string) => {
    if (typeof enabled !== 'boolean') throw new Error(t('无效的 MCP 开关'));
    await mcp.list(workspaceId);
    ctx.config.update({ mcp: { ...ctx.config.get().mcp, enabled } }); changed('mcp');
    return mcp.list(workspaceId);
  });
}
