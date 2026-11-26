/**
 * sessions.setStatus 的纯决策核（executor 与单测共用）：
 * 一个工具同时上报看板列（phase）与左栏胶囊（note）。宿主按 phase 补默认胶囊，
 * 节点推进必然刷新文案——旧 setPhase/setLiveStatus 双工具时代胶囊常被漏报的根因。
 */
import { t } from './i18n';
import type { LiveStatusKind, SessionPhaseKind } from './types';

export const MODEL_STATUS_PHASES = ['needs_you', 'done'] as const;
export type ModelStatusPhase = typeof MODEL_STATUS_PHASES[number];

export function isModelStatusPhase(value: unknown): value is ModelStatusPhase {
  return MODEL_STATUS_PHASES.some(phase => phase === value);
}
const KINDS: LiveStatusKind[] = ['info', 'active', 'waiting', 'done', 'error'];

export const MODEL_STATUS_LABEL_MAX_LENGTH = 10;

/** Model-authored capsule text: free vocabulary, bounded Unicode code points. */
export function normalizeModelStatusLabel(value: unknown): string | undefined {
  const label = typeof value === 'string' ? value.trim() : '';
  if ([...label].length > MODEL_STATUS_LABEL_MAX_LENGTH) throw new Error(t('状态文案最多 10 个字符'));
  return label || undefined;
}

export interface NormalizedSetStatus {
  phase?: SessionPhaseKind;
  note?: string;
  kind?: LiveStatusKind;
}

/** 参数校验 + 归一；非法即抛错（错误信息直接回给模型）。 */
export function normalizeSetStatus(args: {
  phase?: unknown;
  note?: unknown;
  kind?: unknown;
}): NormalizedSetStatus {
  const phaseArg = typeof args.phase === 'string' ? args.phase.trim() : '';
  const phase = isModelStatusPhase(phaseArg) ? phaseArg : undefined;
  if (phaseArg && !phase) throw new Error(t('phase 必须是 needs_you 或 done，空闲由宿主判断'));
  const note = normalizeModelStatusLabel(args.note);
  const kind = KINDS.includes(args.kind as LiveStatusKind)
    ? (args.kind as LiveStatusKind)
    : undefined;
  if (!phase && !note) throw new Error(t('phase 与 note 至少传一个'));
  return { phase, note: note || undefined, kind };
}

/** 省略 note 时按 phase 给的默认胶囊文案。 */
export function defaultNoteFor(phase: SessionPhaseKind): string {
  if (phase === 'needs_you') return t('等验收');
  if (phase === 'done') return t('已完成');
  return t('空闲');
}

/** 默认着色：needs_you=等外部、done=闭环、idle=中性。 */
export function defaultKindFor(phase: SessionPhaseKind): LiveStatusKind {
  if (phase === 'needs_you') return 'waiting';
  if (phase === 'done') return 'done';
  return 'info';
}

/**
 * 胶囊决策。显式 note 永远写；省略时仅当 phase 真正写入才补默认
 * （粘性规则静默拦截时看板没动，不覆盖胶囊，避免冲掉用户语境）。
 * 没有 phase 默认可借时（只传 note、或 phase 被粘性拦下）按进行中着色。
 */
export function capsuleForSetStatus(
  norm: NormalizedSetStatus,
  phaseApplied: boolean
): { label: string; kind: LiveStatusKind } | undefined {
  const phaseDefaultApplies = !!norm.phase && phaseApplied;
  const label = norm.note || (phaseDefaultApplies ? defaultNoteFor(norm.phase!) : undefined);
  if (!label) return undefined;
  const kind = norm.kind || (phaseDefaultApplies ? defaultKindFor(norm.phase!) : 'active');
  return { label, kind };
}
