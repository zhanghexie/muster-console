/**
 * 聊天转写「时间衰减」（R-23 一期）：超过阈值的旧回合在渲染层强制折叠且**不可展开**
 * （只保留该回合最后的输出正文）。调度 SQLite 适配器会复用同一阈值清理已完成回合的
 * 工具载荷，Pi 原生会话不参与这次归档；调阈值/停用只影响渲染形态，重开会话即恢复。
 *
 * 回落策略（保守）：缺时间戳 / 非法值（NaN、<=0、未来时钟）一律视为「近期」可展开——
 * 老数据缺 ts（guiWorker 迁移路径把缺 ts 归一成 0）宁可多渲染可展开，不可静默吞内容。
 * 已知边界：衰减判定在转写重渲时求值（Date.now() 进 rendered memo），无独立计时器——
 * 页面静置跨过 24h 阈值后，要等下一次消息/交互触发的重渲才收拢。
 */

/** 旧回合阈值：距今超过 24h 的回合判定为「已衰减」 */
export const STALE_TURN_MS = 24 * 60 * 60_000;

/**
 * 单条消息是否属于已衰减的旧回合：now - createdAt >= threshold 判旧
 * （恰好压线 = 已衰减；边界见 test/chat-stale-turn.mjs）。
 */
export function isStaleTurn(
  createdAt: number | null | undefined,
  now: number = Date.now(),
  threshold: number = STALE_TURN_MS
): boolean {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return false;
  }
  return now - createdAt >= threshold;
}
