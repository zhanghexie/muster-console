import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import path from 'node:path';
import type { SessionsService } from '../sessions';
import { SqliteDesktopEpochHistory } from './epochHistory';
import { WorkerDesktopEpochs } from './workerEpoch';

/** Connect Worker identity to the actual archive lifecycle before it can authorize desktop work. */
export class WorkerDesktopEpochRuntime {
  private history?: SqliteDesktopEpochHistory;
  private workerEpochs?: WorkerDesktopEpochs;
  private readonly unbind: () => void;
  constructor(private readonly userData: string, private readonly sessions: SessionsService) {
    if (!path.isAbsolute(userData)) throw new Error('Desktop epoch path must be absolute');
    this.unbind = sessions.onBeforeArchive(rows => {
      const ids = rows.filter(row => row.type === 'terminal' && row.launchKind !== 'shell' && !!row.workspaceId).map(row => row.id);
      if (ids.length) this.epochs.invalidateBatchBeforeArchive(ids);
    });
  }
  get epochs(): WorkerDesktopEpochs {
    if (this.workerEpochs) return this.workerEpochs;
    const history = new SqliteDesktopEpochHistory(path.join(userDataStorage(this.userData).resolve('app', 'desktop'), 'epochs.sqlite'));
    try {
      const epochs = new WorkerDesktopEpochs(this.sessions, history);
      this.history = history; this.workerEpochs = epochs;
      return epochs;
    } catch (error) { history.close(); throw error; }
  }
  currentBinding(owner: string): ReturnType<WorkerDesktopEpochs['currentBinding']> {
    const binding = this.epochs.currentBinding(owner);
    if (!binding) throw new Error('Worker desktop identity is unavailable');
    return binding;
  }
  close(): void { try { this.unbind(); } finally { this.history?.close(); } }
}
