import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { UiBridge } from '../uiBridge';
import { DesktopAuditStore } from './auditStore';
import { SqliteDesktopEpochHistory } from './epochHistory';
import { DesktopDispatchJournal } from './dispatchJournal';
import { SCREEN_READ_SCOPE } from './screenReadAuthority';
import { DesktopTaskConfirmationDeclined, SchedulerDesktopTaskEpochs } from './schedulerTaskEpoch';
import { ALL_DISPLAY_APP, SCREEN_READ_ACTION, makeSchedulerTaskConfirmation } from './schedulerTaskUi';
import { VisibleSchedulerEpochs } from './visibleSchedulerEpochs';

/** Host confirmation receipts, persistent history, and audit share the scheduler lifecycle. */
export class SchedulerDesktopEpochRuntime {
  private readonly history: SqliteDesktopEpochHistory;
  private readonly audit: DesktopAuditStore;
  private readonly epochs: SchedulerDesktopTaskEpochs;
  private readonly visibleEpochs?: VisibleSchedulerEpochs;
  private readonly captureApprovals = new Map<string, string>();
  private readonly captureRefusals = new Set<string>();
  constructor(userData: string, ui: Pick<UiBridge, 'confirmWithReceipt'>, visibilityEpoch?: () => number | undefined) {
    if (!path.isAbsolute(userData)) throw new Error('Desktop epoch path must be absolute');
    this.history = new SqliteDesktopEpochHistory(path.join(userDataStorage(userData).resolve('app', 'desktop'), 'epochs.sqlite'));
    let audit: DesktopAuditStore | undefined;
    try {
      audit = new DesktopAuditStore(path.join(userDataStorage(userData).resolve('app', 'desktop'), 'audit.sqlite'));
      this.audit = audit;
      const confirm = makeSchedulerTaskConfirmation(ui);
      const refusals = new DesktopDispatchJournal(path.join(userDataStorage(userData).resolve('app', 'desktop'), 'dispatch'));
      this.epochs = new SchedulerDesktopTaskEpochs(async (request, signal, owner) => {
        if (!owner) throw new Error('Scheduler capture owner is unavailable');
        if (this.captureRefusals.has(owner) || await refusals.hasRefusal(owner, SCREEN_READ_SCOPE)) throw new Error('Screen capture was previously declined');
        const receipt = await confirm(request, signal);
        if (!receipt.approvalId && !signal?.aborted) {
          this.captureRefusals.add(owner);
          await refusals.recordRefusal(owner, SCREEN_READ_SCOPE);
        }
        if (request.kind === 'start' && receipt.approvalId) this.captureApprovals.set(owner, receipt.approvalId);
        return receipt;
      }, async (sessionId, request, result, approvalId) => {
        this.audit.append({ sessionId, taskId: request.taskId ?? approvalId ?? `denied:${randomUUID()}`,
          source: 'desktop', action: 'look', stage: 'approval', result: result === 'approved' ? 'allowed' : 'denied' });
      }, this.history);
      if (visibilityEpoch) this.visibleEpochs = new VisibleSchedulerEpochs(this.history, visibilityEpoch);
    } catch (error) { try { audit?.close(); } finally { this.history.close(); } throw error; }
  }
  ensureCapture(owner: string, isCurrent: () => boolean, signal?: AbortSignal): Promise<string> {
    if (this.visibleEpochs) return this.visibleEpochs.ensureCapture(owner, isCurrent, signal);
    return this.epochs.ensure(owner, { appId: ALL_DISPLAY_APP, actionClass: SCREEN_READ_ACTION }, isCurrent, signal);
  }
  /** Only the matching live, host-confirmed new chain can satisfy the first read grant. */
  consumeCaptureApproval(owner: string, taskId: string): boolean {
    if (!this.epochs.isCurrent(owner, taskId) || this.captureApprovals.get(owner) !== taskId) return false;
    return this.captureApprovals.delete(owner);
  }
  async extendCapture(owner: string, isCurrent: () => boolean, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.epochs.extend(owner, { appId: ALL_DISPLAY_APP, actionClass: SCREEN_READ_ACTION }, isCurrent, signal);
      return true;
    } catch (error) {
      if (error instanceof DesktopTaskConfirmationDeclined) return false;
      throw error;
    }
  }
  currentBinding(owner: string) { return this.visibleEpochs ? this.visibleEpochs.currentBinding(owner) : this.epochs.currentBinding(owner); }
  /** Visible identities can be checked across restart without reviving an old approval. */
  continuationBinding(owner: string) { return this.visibleEpochs ? this.visibleEpochs.continuationBinding(owner) : this.epochs.currentBinding(owner); }
  closeSession(owner: string): void {
    try { if (this.visibleEpochs) this.visibleEpochs.closeSession(owner); else this.epochs.closeSession(owner); }
    finally { this.captureApprovals.delete(owner); }
  }
  close(): void { this.captureApprovals.clear(); try { this.audit.close(); } finally { this.history.close(); } }
}
