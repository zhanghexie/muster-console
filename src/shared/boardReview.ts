/**
 * 看板「需要你 / 待验收」纯函数（P12 + R4）。
 * 无 process：列过滤、验收快照、留痕拼接。
 */
import { boardStatusOfSession, boardZoneOf, isGlobalBoardSession } from './boardStatus';
import { isDimensionGateRedSession } from './dimensionGates';
import { t } from './i18n';
import type { SessionMeta } from './types';

export type ReviewDecision = 'passed' | 'rejected' | 'deferred' | 'processed';

export interface AcceptanceRecord {
  at: number;
  decision: ReviewDecision;
  note?: string;
}

export const ACCEPTANCE_LOG_MAX = 40;

/** 退出但未闭环仍需要处理；只有显式归档排除。 */
export function hiddenFromNeedsYouColumn(
  s: Pick<SessionMeta, 'archived' | 'lifecycle' | 'status'>
): boolean {
  if (s.archived) return true;
  return false;
}

export type BoardNeedsReason = 'approval' | 'question' | 'review' | 'failure' | 'no_signal';

/** 用户注意与验收只看会话/审批状态；代理间未回信不产生人类待办或阻止验收。 */
export function boardNeedsReason(s: SessionMeta, now = Date.now()): BoardNeedsReason | undefined {
  if (s.archived) return undefined;
  const status = boardStatusOfSession(s, now);
  if (status === 'error') return 'failure';
  if (status === 'no_signal') return 'no_signal';
  if (status === 'blocked') return 'approval';
  if (status !== 'waiting') return undefined;
  if (s.activity?.kind === 'waiting_input') return 'question';
  return s.phase?.value === 'needs_you' ? 'review' : 'question';
}

export function canReviewSession(s: SessionMeta, now = Date.now()): boolean {
  return boardNeedsReason(s, now) === 'review';
}

export function canCompleteAndArchiveSession(s: SessionMeta): boolean {
  return !s.archived && ((canReviewSession(s) && !isDimensionGateRedSession(s)) || boardStatusOfSession(s) === 'done');
}

/**
 * 维度门红灯（R-14）：needs_you 会话被机械门挡下——不进「需要你」列，
 * 卡片留在工作列带红灯徽标；看板右键出「打回重做 / 强制验收（跳过维度门）」。
 */
export function gatedFromNeedsYouColumn(
  s: SessionMeta, now = Date.now()
): boolean {
  return isDimensionGateRedSession(s) && canReviewSession(s, now);
}

/** 探出条 / 轮播：需要你区且未搁置、未归档；未闭环退出也提醒。 */
export function isNeedsYouPeekSession(
  s: SessionMeta,
  now: number = Date.now()
): boolean {
  if (!isGlobalBoardSession(s)) return false;
  if (hiddenFromNeedsYouColumn(s)) return false;
  if (s.reviewDeferred) return false;
  if (gatedFromNeedsYouColumn(s, now)) return false;
  return boardZoneOf(boardStatusOfSession(s, now)) === 'needsYou';
}

export function appendAcceptanceLog(
  prev: readonly AcceptanceRecord[] | undefined,
  rec: AcceptanceRecord
): AcceptanceRecord[] {
  const next = [...(prev ?? []), rec];
  return next.length > ACCEPTANCE_LOG_MAX ? next.slice(-ACCEPTANCE_LOG_MAX) : next;
}

export interface ReviewFacts {
  sessionId: string;
  shortId: string;
  item: string;
  commits: string;
  summary: string;
  deferred: boolean;
}

/** 待处理快照只含会话交付信息，不把未回信列作风险。 */
export function reviewFactsOf(s: SessionMeta): ReviewFacts {
  const summary = (s.liveStatus?.summary ?? '').trim();
  return {
    sessionId: s.id,
    shortId: s.id.replace(/-/g, '').slice(0, 8),
    item: s.name,
    commits: (s.worktreeBranch ?? '').trim(),
    summary,
    deferred: !!s.reviewDeferred
  };
}

export function rejectInjectText(note: string | undefined): string {
  const n = (note ?? '').trim() || t('请按验收意见继续修改');
  return t('【验收打回】{{note}}', { note: n });
}

export function isReviewDecision(v: unknown): v is ReviewDecision {
  return v === 'passed' || v === 'rejected' || v === 'deferred' || v === 'processed';
}
