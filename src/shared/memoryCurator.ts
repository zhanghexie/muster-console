import type { GuiChatMessage } from './guiWorker';
import type { KnowledgeDraft, KnowledgeEvidence, KnowledgeNamespace, KnowledgeRecord, KnowledgeEnvironmentDependency } from './knowledge';

export interface MemoryCorrectionInput { memoryId:string; revision:number; problem:string; evidence:string; suggestion?:string }
export interface MemoryCorrectionProposal { decision:'correct'|'suspend'; draft:KnowledgeDraft }
export interface MemoryCorrectionStatus {
  requestId:string;
  status:'pending'|'running'|'deferred'|'failed'|'updated'|'suspended'|'rejected'|'needs_user';
  completed:boolean;
  reason:string;
  targetId:string;
  targetRevision:number;
  recordId?:string;
  recordRevision?:number;
  proposedCorrection?:MemoryCorrectionProposal;
  suggestion?:string;
}

/** Host-owned purpose; presentation names never grant these capabilities. */
export const MEMORY_CURATOR_PURPOSE = 'memory' as const;
export type MemoryCuratorStatus = 'idle' | 'running' | 'paused' | 'error';
export interface MemoryCuratorSnapshot {
  workspaceId: string;
  sessionId: string | null;
  generation: number;
  status: MemoryCuratorStatus;
  paused: boolean;
  pending: number;
  running: boolean;
  failed: number;
  messages: GuiChatMessage[];
  error?: string;
  updatedAt: number;
  model?: { providerId?: string; modelId?: string; name?: string };
}

/** Created by the authenticated producer, never accepted from renderer JSON. */
export interface MemoryCuratorCandidate {
  id: string;
  eventId: string;
  namespace: KnowledgeNamespace;
  origin: KnowledgeRecord['origin'];
  text: string;
  /** Search phrases supplied by the submitting model; curator may add related phrases. */
  searchKeys?: string[];
  environment?: KnowledgeEnvironmentDependency[];
  sourceText: string;
  /** Original human input, bound by the host; never synthesized by the curator. */
  userText?: string;
  /** Host-generated identity of original material; excludes temporary tool-call wrapper IDs. */
  hostInformationHash?: string;
  correction?: MemoryCorrectionInput;
  /** Authenticated submitting session, never supplied by the task model. */
  requesterSessionId?: string;
  evidence: KnowledgeEvidence[];
  repoKey?: string;
  branch?: string;
  explicit?: boolean;
  createdAt: number;
}
export interface MemoryCuratorReceipt {
  queued: boolean;
  candidateId: string;
  reason: string;
}
export type MemoryCuratorQueueState = 'pending' | 'running' | 'deferred' | 'failed' | 'done';
export interface MemoryCuratorQueueQuery {
  state?: MemoryCuratorQueueState | 'all' | 'queued' | 'attention';
  /** Presentation only. Defaults to visible; never changes processing or knowledge. */
  visibility?: 'visible' | 'archived' | 'all';
  offset?: number;
  limit?: number;
}
export interface MemoryCuratorQueueEntry {
  id: string;
  kind: 'candidate' | 'user';
  text: string;
  namespace: KnowledgeNamespace;
  state: MemoryCuratorQueueState;
  archived: boolean;
  createdAt: number;
  availableAt: number;
  attempts: number;
  evidenceCount: number;
  correction?: MemoryCorrectionInput;
  error?: string;
  result?: { disposition?: string; reason?: string; recordId?: string; recordRevision?:number; proposedCorrection?:MemoryCorrectionProposal; targetId?:string; targetRevision?:number };
}
export interface MemoryCuratorQueuePage { items: MemoryCuratorQueueEntry[]; total: number; offset: number; limit: number }
export interface MemoryCuratorApi {
  state(workspaceId: string): Promise<MemoryCuratorSnapshot>;
  inspect(workspaceId: string, input?: MemoryCuratorQueueQuery): Promise<MemoryCuratorQueuePage>;
  setArchived(workspaceId:string,candidateId:string,archived:boolean):Promise<{changed:boolean}>;
  send(workspaceId: string, text: string): Promise<{ accepted: boolean }>;
  setPaused(workspaceId: string, paused: boolean): Promise<MemoryCuratorSnapshot>;
  clear(workspaceId: string): Promise<MemoryCuratorSnapshot>;
  onChanged(listener: (snapshot: MemoryCuratorSnapshot) => void): () => void;
}
