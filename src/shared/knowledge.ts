/** Knowledge contract. Source identity and verification are supplied by the host. */
export type KnowledgeKind = 'task_fact' | 'stable_constraint' | 'user_preference' | 'user_profile' | 'reusable_lesson';
/** Upper bound for the automatically injected user profile, not a storage limit. */
export const PROFILE_INJECTION_BUDGET = 2400;
export type KnowledgeStatus = 'pending' | 'active' | 'needs_revalidation' | 'superseded' | 'archived' | 'rejected';
export type KnowledgeNamespace = 'worker' | 'scheduler' | 'profile' | 'host';
export type KnowledgeRelationKind = 'derived_from' | 'supports' | 'supersedes' | 'contradicts' | 'revision_of';
export type KnowledgeEnvironmentKey = 'appVersion' | 'executorResultMaxChars' | 'mcpCallResultMaxChars' | 'mcpHubMaxChars';
export interface KnowledgeEnvironmentDependency {key:KnowledgeEnvironmentKey;value:string}
export interface KnowledgeEnvironmentCheck {state:'current'|'stale'|'unknown'|'untracked';dependencies:Array<{key:KnowledgeEnvironmentKey;recorded:string;current?:string}>}
export interface KnowledgeRelation {targetId:string;targetRevision?:number;kind:KnowledgeRelationKind;inferred:boolean}
export interface KnowledgeEvidence {
  id: string;
  source: string;
  eventTime: number;
  sessionId?: string;
  turnId?: string;
  snapshotId?: string;
  repoKey?:string;
  branch?:string;
  path?: string;
  verification: 'unverified' | 'test' | 'integration' | 'runtime' | 'user_stated' | 'user_confirmed';
  /** Located observations are separate from claims that a feature passed a test. */
  observation?: 'tool_output' | 'user_input';
  contentHash?: string;
  excerpt?: string;
}
export interface KnowledgeDraft {
  kind: KnowledgeKind;
  summary: string;
  problem?: string;
  action?: string;
  rationale?: string;
  applicability: string[];
  exceptions?: string[];
  searchKeys?: string[];
  expectedFutureUse?: string;
  repoKey?: string;
  branch?: string;
  taskId?: string;
  expiresAt?: number;
  /** Captured by the host at candidate submission, not a model claim. */
  environment?:KnowledgeEnvironmentDependency[];
}
export interface KnowledgeRecord extends KnowledgeDraft {
  schema: 1;
  id: string;
  revision: number;
  namespace: KnowledgeNamespace;
  status: KnowledgeStatus;
  origin: 'user' | 'worker' | 'scheduler' | 'untrusted' | 'system';
  /** Explicit desktop confirmation; automatic curation cannot replace this version. */
  userManaged?: boolean;
  /** Read-time projection; never persisted as an assertion of validation. */
  environmentCheck?:KnowledgeEnvironmentCheck;
  evidence: KnowledgeEvidence[];
  createdAt: number;
  updatedAt: number;
  decisionReason: string;
  supersedes?: string;
  relations?: KnowledgeRelation[];
  history: Array<{revision: number; summary: string; status: KnowledgeStatus; at: number}>;
}
export interface KnowledgeQuery {
  query: string;
  mode?: 'task' | 'history';
  namespace?: KnowledgeNamespace;
  repoKey?: string;
  branch?: string;
  conditions?: string[];
  taskId?: string;
  sources?: string[];
  limit?: number;
  now?: number;
}
export interface KnowledgeHit {
  record: KnowledgeRecord;
  score: number;
  reason: string;
  applicability: 'matched' | 'needs_check';
}
export interface KnowledgeWriteResult {
  disposition: 'proposed' | 'retained_ephemeral' | 'duplicate' | 'active' | 'rejected';
  record?: KnowledgeRecord;
  reason: string;
}
export interface KnowledgeSnapshot {
  /** Projection is unavailable or diverges from the committed ledger; never silently overwrite it. */
  integrityIssues?:Array<{id:string;reason:'missing'|'modified'}>;
  /** Real user-deletion tombstones, distinct from automatic rejection. */
  deletedIds?: string[];
  /** Stored revision/status remains unchanged until bounded compensation publishes its next version. */
  policySuppressedIds?:string[];
  profileInjectionChars?: number;
  activity?:import('./memoryCenterIpc').MemoryCenterEventsResult;
  records: KnowledgeRecord[];
  pending: number;
  active: number;
  history: number;
  startedAt: number;
  governance?: KnowledgeGovernanceReceipt[];
  processing?:{pending:number;failed:number;errors:string[];running?:boolean;paused?:boolean};
  /** Present when `knowledge:list` is called with a bounded query. */
  totalCount?: number;
  nextCursor?: string;
  truncated?: boolean;
}
export interface KnowledgeListQuery {
  cursor?: string;
  limit?: number;
  namespace?: KnowledgeNamespace;
  updatedAfter?: number;
  updatedBefore?: number;
  maxBytes?: number;
}
export interface KnowledgeGovernanceInput {
  id:string; revision:number;
  action:'history'|'merge'|'distinct';
  targetId?:string; targetRevision?:number;
  reason:string;
}
export interface KnowledgeGovernanceReceipt {
  id:string; recordId:string; action:KnowledgeGovernanceInput['action'];
  reason:string; at:number; undone:boolean;
}
export interface KnowledgeEvidenceView {
  status:'available'|'unavailable';reason?:string;
  files?:Array<{path:string;beforeHash:string|null;afterHash:string|null}>;
  diff?:string;
}
export interface KnowledgeHistorySource {id:string;name:string;namespace:'worker'|'scheduler'}
export const KNOWLEDGE_HISTORY_TRUNCATION_NOTE = '[正文超过4000字，余下内容请在原会话查看]';
export interface KnowledgeHistoryMessage {id:string;role:'user'|'assistant';text:string;at:number;snapshotId?:string;state:string;textTruncated?:boolean}
/** Optional host maintenance, never a tool supplied to a model. */
export type KnowledgeMaintenanceInput = {action:'prune_history'} | {
  action:'stop_policy'|'continue_policy';namespace:KnowledgeNamespace;policyVersion:string;reason?:string;
};
export interface KnowledgeMaintenanceResult {
  action:KnowledgeMaintenanceInput['action'];processed:number;remaining:number|null;incomplete:number;blocked?:string[];
}
export interface KnowledgeApi {
  historySources():Promise<KnowledgeHistorySource[]>;
  history(input:{sessionId:string;query:string}):Promise<{messages:KnowledgeHistoryMessage[];truncated:boolean}>;
  govern(input:KnowledgeGovernanceInput):Promise<KnowledgeGovernanceReceipt>;
  undoGovernance(input:{id:string;operationId:string}):Promise<void>;
  create(input:{namespace:KnowledgeNamespace;draft:KnowledgeDraft}):Promise<KnowledgeWriteResult>;
  process():Promise<void>;
  list(input?: KnowledgeListQuery): Promise<KnowledgeSnapshot>;
  search(query: KnowledgeQuery): Promise<KnowledgeHit[]>;
  decide(input: {id: string; revision: number; decision: 'approve' | 'reject' | 'archive' | 'revalidate'}): Promise<KnowledgeRecord>;
  revise(input: {id:string;revision:number;draft:KnowledgeDraft}): Promise<KnowledgeRecord>;
  confirm(input:{id:string;revision:number}):Promise<KnowledgeRecord>;
  promoteHost(input:{id:string;revision:number;draft:KnowledgeDraft}):Promise<KnowledgeRecord>;
  supersede(input:{id:string;revision:number;targetId:string;targetRevision:number}):Promise<KnowledgeRecord>;
  evidence(input:{id:string;evidenceId:string;file?:string}):Promise<KnowledgeEvidenceView>;
  restore(input:{id:string;revision:number;fromRevision:number}):Promise<KnowledgeRecord>;
}
