/**
 * POST /v1/session-status（与 /v1/s/<token>/status）body 解析。
 * phase = 模型交付上报；label = 胶囊文案（不改列），note 是其工具侧别名；
 * activity = 仅 hooks。旧 body 仅 label 仍只改胶囊；kind=done 兼容折成 phase=done。
 */
import type { LiveStatusKind, StructuredActivityKind } from '../../shared/types';
import { t } from '../../shared/i18n';
import { isModelStatusPhase, normalizeModelStatusLabel, type ModelStatusPhase } from '../../shared/setStatus';

const KINDS: LiveStatusKind[] = ['info', 'active', 'waiting', 'done', 'error'];
const ACTIVITIES: StructuredActivityKind[] = ['active', 'idle', 'waiting_input', 'blocked'];

export interface StatusBodyParseResult {
  /** 自由文案胶囊；hooks 上报可缺省 */
  label?: string;
  /** label 是否来自 note 别名（新工具语义，着色按进行中处理） */
  labelFromNote?: boolean;
  kind?: LiveStatusKind;
  summary?: string;
  /** hooks 结构化生命周期 */
  activity?: StructuredActivityKind;
  event?: string;
  toolUseId?: string;
  phase?: ModelStatusPhase;
}

/**
 * 解析并裁剪；label / activity / phase 至少要有一个。
 * 未知字段静默忽略（向前兼容）。
 */
export function parseStatusBody(body: Record<string, unknown>): StatusBodyParseResult {
  // note 是 sessions.setStatus 工具侧的胶囊参数名；HTTP 契约名仍是 label，两者同义
  let rawLabel = '';
  let fromNote = false;
  if (typeof body.note === 'string' && body.note.trim()) {
    rawLabel = body.note;
    fromNote = true;
  } else if (typeof body.label === 'string') {
    rawLabel = body.label;
  }
  const label = normalizeModelStatusLabel(rawLabel);
  const kind = KINDS.includes(body.kind as LiveStatusKind)
    ? (body.kind as LiveStatusKind)
    : undefined;
  const summary =
    typeof body.summary === 'string' && body.summary.trim() ? body.summary.slice(0, 200) : undefined;
  const activity = ACTIVITIES.includes(body.activity as StructuredActivityKind)
    ? (body.activity as StructuredActivityKind)
    : undefined;
  const event = typeof body.event === 'string' && body.event.trim() ? body.event.trim().slice(0, 64) : undefined;
  if (body.phase === 'idle') throw new Error(t('phase 必须是 needs_you 或 done，空闲由宿主判断'));
  let phase = isModelStatusPhase(body.phase) ? body.phase : undefined;
  // 兼容旧 Worker：kind=done 且未带 phase → 仍跳「已完成」列
  if (!phase && kind === 'done') phase = 'done';
  if (!label && !activity && !phase) {
    throw new Error(t('需要非空 label（或 note）、activity 或 phase（needs_you|done）'));
  }
  return {
    label,
    labelFromNote: label ? fromNote : undefined,
    kind,
    summary,
    activity,
    event,
    toolUseId: typeof body.toolUseId === 'string' ? body.toolUseId.trim().slice(0, 256) || undefined : undefined,
    phase
  };
}
