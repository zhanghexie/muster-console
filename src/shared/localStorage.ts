import type { StorageMaintenanceId } from './storageMaintenance';

/** A local storage inventory is a snapshot, not a promise of reclaimable disk space. */
export const MAX_LOCAL_STORAGE_SELECTION = 1000;
export type LocalStorageCategory = 'worktrees' | 'sessions' | 'attachments' | 'handovers' | 'extensions' | 'apps' | 'browser' | 'themes' | 'other';
export type LocalStorageAction = 'worktree' | 'session' | 'attachment' | 'handover' | 'theme' | 'app' | 'download' | 'browserData' | 'artifact' | 'extension' | 'extensionActivation' | 'startupCleanup';
export type LocalStorageReason = 'active' | 'subsessions' | 'worktree' | 'unknown' | 'unknownDownload' | 'shared' | 'builtin' | 'unavailable' | 'duplicate' | 'processing' | 'restartPending';
export type LocalStoragePathStatus = 'available' | 'missing' | 'unavailable';

export interface LocalStorageItem {
  id: string;
  category: LocalStorageCategory;
  /** User data or a file name; never translate. */
  name: string;
  workspaceId?: string;
  owner?: string;
  paths: string[];
  /** Worktree paths are checked individually; a missing directory may still have Git metadata. */
  pathStatuses?: Array<{ path: string; status: LocalStoragePathStatus }>;
  /** Logical file sizes; null means the item is logical or could not be measured. */
  bytes: number | null;
  /** Logical item uses shared files whose physical bytes cannot be attributed to it alone. */
  sizeKind?: 'shared';
  partial: boolean;
  /** Latest observed filesystem modification time; absent for logical or unreadable items. */
  modifiedAt?: number;
  /** Diagnostic detail from an unavailable domain service, if any. */
  issue?: string;
  action?: LocalStorageAction;
  reason?: LocalStorageReason;
  sessionId?: string;
  /** Cleanup releases the runtime of a session which has not been archived. */
  stopsSession?: boolean;
  /** The registered Git identity supports an explicit discard operation. */
  canDiscardWorktree?: boolean;
  /** Group of on-disk assets released and cleared together before the next service startup. */
  maintenanceId?: StorageMaintenanceId;
}

/** Deleting a prerequisite requires deleting its dependents first. */
export interface LocalStorageDependency {
  dependentId: string;
  prerequisiteId: string;
}

export interface LocalStorageSnapshot {
  id: string;
  items: LocalStorageItem[];
  workspaces: { id: string; name: string }[];
  partial: boolean;
  dependencies?: LocalStorageDependency[];
}

export interface LocalStorageSelection { id: string; deleteAppData?: boolean; discardWorktree?: boolean }
export interface LocalStorageCleanupResult {
  id: string;
  status: 'completed' | 'started' | 'skipped' | 'failed' | 'scheduled';
  /** External error details are retained as diagnostics. */
  error?: string;
}
export interface LocalStorageCleanupJob {
  id: string;
  total: number;
  done: boolean;
  results: LocalStorageCleanupResult[];
  error?: string;
}
