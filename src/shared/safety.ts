import type { GuiChatMessage } from './guiWorker';

export type SafetyStreamEvent =
  | { type: 'model-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; id: string; output: string; isError: boolean }
  | { type: 'error'; message: string };

/** Ephemeral host-owned Git evidence; never a model-supplied path or a persisted record. */
export interface SafetyGitEvidence {
  kind: 'git';
  operation?: 'integrate' | 'delete';
  /** Applicant statement, never proof of test execution. */
  delivery?: string;
  sessions: Array<{ id: string; name?: string }>;
  repositories: Array<{
    id: string;
    sessionId: string;
    sessionName?: string;
    root: string;
    sourceRef?: string;
    targetRef?: string;
    source?: string;
    target?: string;
    unavailable?: string;
    role?: 'task' | 'target-checkout' | 'shared';
    roleUnknown?: boolean;
    workingTreeEvidence?: 'informational' | 'critical';
    tests?: { status: 'verified-pass' | 'verified-fail' | 'not-collected'; reason?: string };
    status?: unknown;
    untrackedFiles?: unknown[];
    content: Partial<Record<'diff' | 'workingDiff' | 'stagedDiff' | 'commits', string>>;
  }>;
  contents: Record<string, string>;
  incomplete: boolean;
}

export interface SafetyOperation {
  workspaceId: string;
  actorId?: string;
  action: string;
  args: Record<string, unknown>;
  source: 'catalog' | 'worker' | 'app';
  dangerous?: boolean;
  permissionClass?: string;
  summary?: string;
  evidence?: string;
  /** Captured by the trusted session service and scoped to this operation. */
  gitEvidence?: SafetyGitEvidence;
  targetFingerprint?: string;
  signal?: AbortSignal;
  humanConfirm?: (reason: string, signal?: AbortSignal) => Promise<boolean>;
}
export interface SafetyDecision {
  allowed: boolean;
  requestId: string;
  risk: 'routine' | 'high';
  reason: string;
  escalated?: boolean;
  cancelled?: boolean;
  /** Audit could not be read or committed; the service issued no approval. */
  auditUnavailable?: boolean;
  /** A completed human decision must never trigger another confirmation. */
  humanDecision?: boolean;
}
export interface SafetyRecord {
  requestId: string;
  workspaceId: string;
  action: string;
  fingerprint: string;
  generation: number;
  risk: 'high';
  status: 'reviewing' | 'allowed' | 'needs_confirmation' | 'denied' | 'failed';
  reason: string;
  createdAt: number;
  finishedAt?: number;
  summary?: string;
  model?: {
    providerId?: string;
    modelId?: string;
    name?: string;
  };
}
export interface SafetyMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
  requestId?: string;
  /** Host provenance; absent on transcripts saved before this field existed. */
  origin?: 'approval_request' | 'user_chat' | 'reviewer' | 'human_decision' | 'service';
  /** Structured live parts shared with the scheduler transcript. */
  parts?: GuiChatMessage['parts'];
  error?: string;
}
export interface SafetyRule {
  id: string;
  text: string;
  actions: string[];
  enabled: boolean;
  revision: number;
  createdAt: number;
  sourceText: string;
}
export interface SafetySnapshot {
  workspaceId: string;
  records: SafetyRecord[];
  messages: SafetyMessage[];
  rules: SafetyRule[];
  ruleRevision: number;
  busy: boolean;
  generation: number;
}
export interface SafetyService {
  authorize(operation: SafetyOperation): Promise<SafetyDecision>;
  snapshot(workspaceId: string): SafetySnapshot;
  send(
    workspaceId: string,
    text: string,
    requestId?: string,
  ): Promise<SafetySnapshot>;
  stop(workspaceId: string): void;
  clearConversation(workspaceId: string): SafetySnapshot;
  setRuleEnabled(
    workspaceId: string,
    ruleId: string,
    enabled: boolean,
    revision: number,
  ): SafetySnapshot;
  invalidate(workspaceId?: string): void;
  dispose(): void;
}
