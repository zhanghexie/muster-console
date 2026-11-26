import { isSessionStallEligible, type SessionMonitorFacts } from './sessionActivity';

export interface StallEpochState {
  /** 进入 stalled 时的 lastActivityAt（停滞段身份） */
  lastActivityAt: number;
}

export type StallScanAction =
  | { type: 'enter'; lastActivityAt: number }
  | { type: 'skip' }
  | { type: 'recover' };

/**
 * 停滞推送资格：仅对正在工作或等待活动的会话写 stalled。
 * 已归档、已完成或闲置的会话不触发停滞提醒。
 */
export function isStallPushEligible(input: Omit<SessionMonitorFacts, 'phase'> & { phase?: { value: string } }): boolean {
  return isSessionStallEligible({ ...input, phase: input.phase?.value });
}

/**
 * 判定本轮扫描是否该写事实。
 * - 进入 stalled：写一条；epoch 相同则跳过
 * - 离开 stalled（曾报过）：写恢复
 * - 从未 stalled：跳过
 */
export function decideStallScanAction(
  prev: StallEpochState | undefined,
  verdictKind: string,
  lastActivityAt?: number
): StallScanAction {
  if (verdictKind === 'stalled') {
    const epoch =
      typeof lastActivityAt === 'number' && Number.isFinite(lastActivityAt) ? lastActivityAt : 0;
    if (prev && prev.lastActivityAt === epoch) return { type: 'skip' };
    return { type: 'enter', lastActivityAt: epoch };
  }
  if (prev) return { type: 'recover' };
  return { type: 'skip' };
}

export function applyStallScanAction(
  epochs: Map<string, StallEpochState>,
  sessionId: string,
  action: StallScanAction
): void {
  if (action.type === 'enter') {
    epochs.set(sessionId, { lastActivityAt: action.lastActivityAt });
    return;
  }
  if (action.type === 'recover') epochs.delete(sessionId);
}

/** 扫描名单里已经没了的会话，清掉 epoch（不写恢复——会话已不在活跃集）。 */
export function pruneStallEpochs(epochs: Map<string, StallEpochState>, activeIds: Iterable<string>): string[] {
  const alive = new Set(activeIds);
  const removed: string[] = [];
  for (const id of epochs.keys()) {
    if (!alive.has(id)) {
      epochs.delete(id);
      removed.push(id);
    }
  }
  return removed;
}
