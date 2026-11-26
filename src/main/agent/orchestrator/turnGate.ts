/**
 * O8 自治回合闸的 token 簿记：槽随「自治回合链」持有——host 入口起链时占槽，
 * busy 期间排队消息续发沿用同一 token（一条链=一个槽），链收口（无排队续发）释放。
 * 人的回合不占槽；fail-open：闸异常时按无闸放行（token 不入表，释放为 no-op）。
 */
import {
  TurnGate,
  TurnGateQueue,
  type TurnGateConfig,
  type TurnGateQueueItem
} from '../../../shared/turnGate';
import type { OrchestratorHost } from './internal';
import type { WsAgentBucket } from './types';

/**
 * O8 全局自治回合闸装配：跨工作区 token 槽信号量 + 租约回收（config.turnGate，缺省
 * enabled=true cap=4 leaseMs=15min）。只对 host 标记的自治入口生效——桌面 chat:send /
 * sendNow / 计划卡执行 / 飞书人指令都不带 host 标记，人的回合永不被自治负载节流。
 */
export function createTurnGateWiring(
  getGateConfig: () => TurnGateConfig,
  deliver: (item: TurnGateQueueItem, token: string) => void
): { turnGate: TurnGate; gateQueue: TurnGateQueue } {
  const turnGate = new TurnGate(
    getGateConfig,
    () => Date.now(),
    (info) =>
      console.error(
        `[orchestrator] 自治回合租约超时，回收 wedged 槽 ${info.token}（持有 ${Math.round(info.heldMs / 1000)}s，transient 超限一回合可接受）`
      )
  );
  // 闸满暂存 + 释放即 drain 的投递缓冲（不丢、不向上游报错）
  const gateQueue = new TurnGateQueue({
    gate: turnGate,
    deliver,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>)
  });
  return { turnGate, gateQueue };
}

/** 把已持有的槽 token 绑到本区（覆盖上一条链的遗留 token，防泄漏） */
export function bindTurnGateToken(o: OrchestratorHost, bucket: WsAgentBucket, token: string): void {
  if (bucket.gateToken && bucket.gateToken !== token) {
    releaseGateTokenOnly(o, bucket.gateToken);
  }
  bucket.gateToken = token;
}

export function releaseGateTokenOnly(o: OrchestratorHost, token: string | undefined): void {
  if (!token) return;
  try {
    o.turnGate.release(token);
  } catch (err) {
    console.error('[orchestrator] turn gate release failed（忽略）', err);
  }
}

/** 链收口：释放本区槽 token 并立即 drain 满闸 pending（哪怕本区是人链也试着放行） */
export function releaseTurnGate(o: OrchestratorHost, bucket: WsAgentBucket): void {
  const token = bucket.gateToken;
  bucket.gateToken = undefined;
  releaseGateTokenOnly(o, token);
  try {
    o.gateQueue.drain();
  } catch (err) {
    console.error('[orchestrator] gated pending drain failed（保底重试节奏会再试）', err);
  }
}
