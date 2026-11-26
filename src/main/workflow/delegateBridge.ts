/**
 * 排队派活等待桥（dynamic-workflow W3）：把「delegateTask 返回 queued → 挂起等
 * delegateQueue 出队回调」的桥接从 wiring 抽出，供真实队列联动测试复用——
 * wiring 用 delegateTask 的真实出口装配，测试直接驱动 delegateQueue 模块。
 *
 * 职责（与原 wiring 内联实现一致）：
 * - 排队项挂起直到 addDelegateDrainedListener 报回该 queueId 的结局；
 * - 出队回调早于 waitQueued 登记的极窄竞态用 early 表暂存一分钟；
 * - ctl.registerCancel 登记撤销回调：run 取消时 cancelQueuedDelegate 撤销未出队
 *   项并 reject；已开始创建（launching）返回 false，由调用方走迟到补偿。
 */
import { addDelegateDrainedListener, cancelQueuedDelegate, type DelegateDrainedOutcome } from '../tasks/delegateQueue';
import type { DelegateTaskResult } from '../tasks/delegate';
import { t } from '../../shared/i18n';

const EARLY_DRAIN_TTL_MS = 60_000;

export interface DelegateCancelControl {
  registerCancel: (cancel: () => boolean) => void;
}

export function createQueuedDelegateBridge<R>(
  toResult: (result: DelegateTaskResult) => R
): {
  /** 排队项等待真正拉起：resolve 结果 / 连续失败放弃 reject / 取消撤销 reject */
  waitQueued: (queueId: string, ctl?: DelegateCancelControl) => Promise<R>;
  dispose: () => void;
} {
  const waitingQueue = new Map<string, { resolve: (r: R) => void; reject: (e: Error) => void }>();
  const early = new Map<string, DelegateDrainedOutcome>();
  const settleQueued = (queueId: string, outcome: DelegateDrainedOutcome): boolean => {
    const p = waitingQueue.get(queueId);
    if (!p) return false;
    if (outcome.ok) {
      waitingQueue.delete(queueId);
      p.resolve(toResult(outcome.result));
    } else if (outcome.dropped) {
      waitingQueue.delete(queueId);
      // r2-W1：拒绝也保留结构化资源（出口已建出的会话）与原始失败原因，
      // runtime 迟到补偿据此补关/记账，不退化成普通 Error
      const rejectError = new Error(t('排队派活连续失败已放弃：{{error}}', { error: outcome.error })) as Error & {
        sessionId?: string;
      };
      if (outcome.sessionId) rejectError.sessionId = outcome.sessionId;
      p.reject(rejectError);
    }
    return true;
  };
  const offDrained = addDelegateDrainedListener((queueId, _ws, outcome) => {
    if (settleQueued(queueId, outcome)) return;
    if (!outcome.ok && !outcome.dropped) return;
    early.set(queueId, outcome);
    const timer = setTimeout(() => early.delete(queueId), EARLY_DRAIN_TTL_MS);
    timer.unref?.();
  });
  return {
    waitQueued: (queueId, ctl) =>
      new Promise<R>((resolve, reject) => {
        waitingQueue.set(queueId, { resolve, reject });
        ctl?.registerCancel(() => {
          if (!cancelQueuedDelegate(queueId)) return false;
          waitingQueue.delete(queueId);
          reject(new Error(t('工作流 run 已取消，排队派活已撤销')));
          return true;
        });
        const pre = early.get(queueId);
        if (pre) {
          early.delete(queueId);
          settleQueued(queueId, pre);
        }
      }),
    dispose: () => offDrained()
  };
}
