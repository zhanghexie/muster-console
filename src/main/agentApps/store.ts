import type { AppCallResult, AppConnection, AppFeishuChat, AppInstallation, AppOperation, AppRecord } from '../../shared/agentApps';

export type AppJob = { id: string; kind: 'reminder' | 'sync'; appId: string; commandId: string; params: Record<string, unknown>; dueAt: number; intervalMs?: number; dailyTime?: string; weekdays?: number[]; localZone?: string; enabled: boolean; revision: number; attempts: number; missed: 'skip' | 'catch-up'; lastError?: string };
export type AppOutboxEvent = { id: string; appId: string; kind: string; recordIds: string[]; title: string; createdAt: number; attempts: number; nextAttemptAt: number; action: 'wake' | 'digest' | 'mute'; occurrenceAt?: number; deliveredAt?: number; messageId?: string; legacyCommittedAt?: number; channelMessage?: { channelId: string; messageId: string } };
export type AppReceipt = { key: string; fingerprint: string; state: 'running' | 'done' | 'uncertain'; external?: boolean; submitted?: boolean; recordId?: string; result?: AppCallResult; at: number };
export type StoredConnection = AppConnection & { encryptedSecret?: string; cursors?: Record<string, Record<string, string | number>> };
export type AppWorkspaceState = {
  schemaVersion: 1; workspaceId: string; revision: number; installations: AppInstallation[];
  records: Record<string, AppRecord[]>; jobs: AppJob[]; outbox: AppOutboxEvent[];
  receipts: AppReceipt[]; operations: AppOperation[]; connections: StoredConnection[];
  feishuChats?: AppFeishuChat[];
  feedSyncedAt?: Record<string, number>;
  channelCursors?: Record<string, string>;
  uninstalledApps?: Record<string, { definitionFingerprint: string; catalogId?: string }>;
  /** Last 10,000 scoped SHA-256 source identities; no deleted record bodies. */
  deletions?: string[];
};
