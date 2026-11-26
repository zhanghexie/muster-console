/**
 * 手机表面服务端推送帧（T1.2）：NotifyBus 决策通过的看板翻转 → 网关 WS 主动下推。
 *
 * 帧形态（`t:'push'` 与既有 result/event 帧并列，webApiShim.handleMessage 分发）：
 *   {t:'push', type:'session-status', sessionId, phase, label}
 *  - phase 是触发类（needs_you/done/error），不是 BoardStatus 全集——只有这三类
 *    翻转会触发推送（决策矩阵见 notifyDecision.ts）；
 *  - label 是主进程拼好的展示文案（formatNotifyText「会话名 · 需要你」形态），
 *    手机端 toast 直用不二次本地化；
 *  - 深链跳转复用手机端 needs_you 深链（mobile-surface.md），需要 workspaceId 时
 *    由客户端在本地会话表里解析（sessions:changed 全量事件与推送帧同链路到达）。
 *
 * 离线 Web Push（Service Worker 推送）刻意不做：网关侧只在 web-access.json 预留
 * pushSubscription 存储位（见 WebAccessServer.setPushSubscription），本模块不涉及。
 */

/** 推送触发类。与 shared/notifyDecision 的 NotifyTrigger 同值集，独立声明避免无谓耦合 */
export type SessionStatusPushPhase = 'needs_you' | 'done' | 'error';

export interface SessionStatusPush {
  type: 'session-status';
  sessionId: string;
  phase: SessionStatusPushPhase;
  label: string;
}

export function isSessionStatusPushPhase(v: unknown): v is SessionStatusPushPhase {
  return v === 'needs_you' || v === 'done' || v === 'error';
}

/**
 * 防御性解析（shim 收帧用）：字段齐全、phase 在触发类词表内才放行，其余静默丢弃
 * （畸形帧/未来新增推送类型不炸手机端）。多余字段不透传。
 */
export function parseSessionStatusPush(raw: unknown): SessionStatusPush | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.type !== 'session-status') return null;
  const sessionId = typeof o.sessionId === 'string' ? o.sessionId.trim() : '';
  if (!sessionId) return null;
  if (!isSessionStatusPushPhase(o.phase)) return null;
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (!label) return null;
  return { type: 'session-status', sessionId, phase: o.phase, label };
}
