import type { SkillManagementAPI } from './capabilityManagement';
import type { McpManagementApi, McpManagementInventory } from './mcpManagement';

export interface CapabilityManagementAPI {
  previewSkillConsolidation: SkillManagementAPI['previewConsolidation'];
  consolidateSkill: SkillManagementAPI['consolidate'];
  usageList(input: import('./capabilityUsage').UsageListInput): Promise<import('./capabilityUsage').UsageSnapshot>;
  usageSet(input: import('./capabilityUsage').UsageSetInput): Promise<void>;
  skillsList: SkillManagementAPI['list'];
  readSkill: SkillManagementAPI['readSkill'];
  saveSkill: SkillManagementAPI['saveSkill'];
  createSkill: SkillManagementAPI['createSkill'];
  setPreferred: SkillManagementAPI['setPreferred'];
  refresh: SkillManagementAPI['refresh'];
  mcpList: McpManagementApi['list'];
  getMcp: McpManagementApi['get'];
  saveMcp: McpManagementApi['save'];
  removeMcp: McpManagementApi['remove'];
  importMcp: McpManagementApi['importJson'];
  testMcp: McpManagementApi['test'];
  setMcpEnabled(enabled: boolean, workspaceId?: string): Promise<McpManagementInventory>;
}
