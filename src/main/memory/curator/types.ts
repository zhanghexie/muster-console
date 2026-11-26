import type { AppConfig } from '../../../shared/types';
import type { MemoryCuratorCandidate, MemoryCuratorSnapshot } from '../../../shared/memoryCurator';
import type { CuratorDecisionInput, CuratorDecisionReceipt, CuratorReferences } from './storageTypes';

export interface CuratorEvidenceResult {
  status: 'available' | 'unavailable';
  text?: string;
  reason?: string;
}
export type CuratorSessionEvent =
  | { type: 'model-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; id: string; output: string; isError: boolean }
  | { type: 'error'; message: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number };
export interface CuratorSessionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export interface CuratorSession {
  id: string;
  file?: string;
  model?: { providerId?: string; modelId?: string; name?: string };
  run(input: { text: string; kind: 'candidate' | 'user' | 'repair' }, signal: AbortSignal): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}
export interface CuratorSessionFactoryInput {
  root: string;
  directory: string;
  sessionFile?: string;
  tools: CuratorSessionTool[];
  onEvent: (event: CuratorSessionEvent) => void;
  maxModelRequests: number;
  /** Same host batch budget across initial and receipt-repair turns; runs before HTTP. */
  beforeModelRequest?: () => void;
}
export type CuratorSessionFactory = (input: CuratorSessionFactoryInput) => Promise<CuratorSession>;
export interface CuratorPiOptions {
  config: () => AppConfig;
  targetModel?: () => { providerId?: string; modelId?: string } | undefined;
  agentDirectory?: string;
}
export interface MemoryCuratorRuntimeOptions {
  workspaceId: string;
  root: string;
  directory: string;
  pi?: CuratorPiOptions;
  createSession?: CuratorSessionFactory;
  references(candidate: MemoryCuratorCandidate, query: string): CuratorReferences | Promise<CuratorReferences>;
  /** Host-bound lookup bridges a committed knowledge transaction and an unacknowledged queue job. */
  receipt?: (candidate: MemoryCuratorCandidate) => CuratorDecisionReceipt | undefined | Promise<CuratorDecisionReceipt | undefined>;
  commit(candidate: MemoryCuratorCandidate, decision: CuratorDecisionInput, assertCurrent: () => void): CuratorDecisionReceipt | Promise<CuratorDecisionReceipt>;
  readEvidence?: (candidate: MemoryCuratorCandidate, evidenceId: string) => CuratorEvidenceResult | Promise<CuratorEvidenceResult>;
  onChanged?: (snapshot: MemoryCuratorSnapshot) => void;
  enabled?: () => boolean;
  mode?: () => 'observe' | 'automatic' | 'paused';
  /** Host-bound original user input is already represented by candidate.sourceText. */
  userCandidate?: (text: string) => MemoryCuratorCandidate;
  now?: () => number;
  policyVersion?: string;
  maxBatch?: number;
  timeoutMs?: number;
  maxModelRequests?: number;
  idleDisposeMs?: number;
}
