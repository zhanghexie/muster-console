/**
 * 调度会话状态落盘 + 广播。与 SessionMeta 平行，不进看板、不走 Worker setPhase。
 */
import type { BrowserWindow } from 'electron';
import type { Store } from './store';
import type { AppContext } from './context';
import {
  isSchedulerBlockedOnHuman,
  parseSchedulerStatusMap,
  type SchedulerStatus
} from '../shared/schedulerStatus';

export class SchedulerStatusStore {
  private byWs: Record<string, SchedulerStatus>;

  constructor(
    private persist: Store,
    private getWindow: () => BrowserWindow | null
  ) {
    this.byWs = parseSchedulerStatusMap(persist.loadSchedulerStatus());
  }

  list(): Record<string, SchedulerStatus> {
    return { ...this.byWs };
  }

  get(workspaceId: string): SchedulerStatus | undefined {
    const id = workspaceId.trim();
    return id ? this.byWs[id] : undefined;
  }

  set(status: SchedulerStatus): SchedulerStatus {
    this.byWs[status.workspaceId] = status;
    this.persist.saveSchedulerStatus(this.byWs);
    this.broadcast();
    return status;
  }

  remove(workspaceId: string): void {
    const id = workspaceId.trim();
    if (!id || !this.byWs[id]) return;
    delete this.byWs[id];
    this.persist.saveSchedulerStatus(this.byWs);
    this.broadcast();
  }

  broadcast(): void {
    this.getWindow()?.webContents.send('scheduler:status', { byWorkspace: this.list() });
  }
}

/** Broad waiting state used for busy-turn interjection and the task decision gate. */
export function isSchedulerWaitingOnHuman(ctx: AppContext, workspaceId: string): boolean {
  const wsId = workspaceId?.trim() || '';
  if (!wsId) return false;
  try {
    if (isSchedulerBlockedOnHuman(ctx.schedulerStatus?.get(wsId))) return true;
  } catch {
    /* fail-open：读失败当不挡 */
  }
  return hasSchedulerPendingQuestion(ctx, wsId);
}

/** Pending interactive question used by idle scheduler wake admission. */
export function hasSchedulerPendingQuestion(ctx: AppContext, workspaceId: string): boolean {
  try {
    return !!ctx.orchestrator?.getHumanWait(workspaceId);
  } catch {
    return false;
  }
}
