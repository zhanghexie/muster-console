/** Settings-only capability inventory. Filesystem visibility is not session-loaded evidence. */
export type CapabilityScope = { kind: 'global' } | { kind: 'project'; projectPath: string };
export type CapabilityTargetId = string;
/** Shared by menus, first sends and busy redirects so every surface uses one policy. */
export function guiSkillTargetForRuntime(runtimeId: string | undefined, entries: Array<Pick<import('./types').AgentRuntimeEntry, 'id' | 'integrations'>> = []): CapabilityTargetId {
  return entries.find(entry => entry.id === runtimeId)?.integrations?.skillTargets?.find(target => target.kind === 'gui')?.id ?? `runtime:${runtimeId ?? 'unknown'}`;
}

export interface SkillDirectory {
  id: string;
  path: string;
  label: string;
  scope: CapabilityScope;
  custom: boolean;
  exists: boolean;
}
export interface ManagedSkillSource {
  path: string;
  directoryId: string;
  scope: CapabilityScope;
  label: string;
  managed: boolean;
}
export interface ManagedSkill {
  /** Application-owned usage documentation; readable but immutable in the manager. */
  hostOwned?: boolean;
  id: string;
  name: string;
  description: string;
  filePath: string;
  directoryPath: string;
  hash: string;
  status: 'valid' | 'invalid' | 'missing';
  error?: string;
  scope: CapabilityScope;
  inherited: boolean;
  sources: ManagedSkillSource[];
  conflictGroup?: string;
  preferred: boolean;
  files: string[];
}
export interface SkillManagementSnapshot {
  scope: CapabilityScope;
  revision: number;
  skills: ManagedSkill[];
  directories: SkillDirectory[];
  conflicts: Array<{ name: string; skillIds: string[]; preferredSkillId?: string }>;
  errors: string[];
}
export interface SkillDocument {
  id: string;
  filePath: string;
  body: string;
  hash: string;
  files: string[];
  readOnly: boolean;
}
export interface SaveSkillRequest {
  id: string;
  scope: CapabilityScope;
  body: string;
  expectedHash: string;
}
export interface CreateSkillRequest {
  scope: CapabilityScope;
  name: string;
  description?: string;
  body?: string;
}
export interface SetPreferredSkillRequest {
  scope: CapabilityScope;
  name: string;
  skillId?: string;
}
export interface SkillConsolidationPreview {
  scope: CapabilityScope;
  name: string;
  selectedId?: string;
  destination: string;
  candidates: Array<{ skill: ManagedSkill; document: SkillDocument }>;
  removePaths: string[];
  linkPaths: string[];
  fingerprint: string;
}
export interface SkillConsolidationRequest {
  scope: CapabilityScope; name: string; skillId: string; expectedFingerprint: string;
}
export interface SkillManagementAPI {
  previewConsolidation(scope: CapabilityScope, name: string, skillId?: string): Promise<SkillConsolidationPreview>;
  consolidate(input: SkillConsolidationRequest): Promise<{ snapshot: SkillManagementSnapshot; backupPath: string }>;
  list(scope: CapabilityScope): Promise<SkillManagementSnapshot>;
  readSkill(id: string, scope: CapabilityScope): Promise<SkillDocument>;
  saveSkill(input: SaveSkillRequest): Promise<SkillManagementSnapshot>;
  createSkill(input: CreateSkillRequest): Promise<SkillManagementSnapshot>;
  setPreferred(input: SetPreferredSkillRequest): Promise<SkillManagementSnapshot>;
  refresh(scope: CapabilityScope): Promise<SkillManagementSnapshot>;
}
