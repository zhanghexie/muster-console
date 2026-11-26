/**
 * sessions.integrate 审批策略（纯函数，无 process）。
 * 缺省 required：弹确认，老调用不传参数行为不变。
 * 仅字面 'auto' 免确认；其它值（含大小写变体）一律 required。
 *
 * 合入失败可见性：人手动确认过（required / review / requestIntegrate）必须桌面 toast；
 * 调度 approval=auto 免确认失败只走编排事件，不重复弹给操作者。
 */
import { t } from './i18n';

export type IntegrateApproval = 'auto' | 'required';

/** 验收账本里免审批合入的可检索前缀 */
export const INTEGRATE_AUTO_ACCEPTANCE_NOTE = 'approval=auto';

/** 失败 toast 同键前缀（与成功 `integrate-auto:` 对称） */
export const INTEGRATE_FAIL_UPDATE_KEY_PREFIX = 'integrate-fail:';

const INTEGRATE_FAIL_REASON_MAX = 800;

export function resolveIntegrateApproval(raw: unknown): IntegrateApproval {
  return raw === 'auto' ? 'auto' : 'required';
}

/** 仅 sessions.integrate + approval=auto 跳过 dangerous 确认门 */
export function shouldSkipIntegrateConfirm(
  toolName: string,
  args: Record<string, unknown> | undefined | null
): boolean {
  return toolName === 'sessions.integrate' && resolveIntegrateApproval(args?.approval) === 'auto';
}

/**
 * 合入失败是否弹给操作者（桌面 toast）。
 * - sessions.integrate + approval=auto：调度免确认，只走编排事件
 * - 其余（required / review / requestIntegrate）：人点过确认或主动请合入，必须可见
 */
export function shouldNotifyUserOnIntegrateFail(
  toolName: string,
  args?: Record<string, unknown> | undefined | null
): boolean {
  if (toolName === 'sessions.integrate') {
    return resolveIntegrateApproval(args?.approval) !== 'auto';
  }
  return toolName === 'sessions.review' || toolName === 'sessions.requestIntegrate';
}

export function integrateAutoAcceptanceNote(reason?: string): string {
  const r = reason?.trim();
  return r ? `${INTEGRATE_AUTO_ACCEPTANCE_NOTE}: ${r}` : INTEGRATE_AUTO_ACCEPTANCE_NOTE;
}

export function buildIntegrateAutoApprovalTrace(opts: {
  sessionName?: string;
  sessionId?: string;
  target?: string;
  note?: string;
}): { label: string; text: string; updateKey?: string; sessionName: string } {
  const target = opts.target?.trim() || 'main';
  const sessionName = opts.sessionName?.trim() || t('会话');
  const note = opts.note?.trim();
  const text = note
    ? t('调度免审批合入「{{name}}」→ {{target}}（{{note}}）', {
        name: sessionName,
        target,
        note
      })
    : t('调度免审批合入「{{name}}」→ {{target}}', { name: sessionName, target });
  const sid = opts.sessionId?.trim();
  return {
    label: t('免审批合入'),
    text,
    sessionName,
    ...(sid ? { updateKey: `integrate-auto:${sid}` } : {})
  };
}

export function clipIntegrateFailReason(reason: string): string {
  const r = reason.trim();
  if (r.length <= INTEGRATE_FAIL_REASON_MAX) return r;
  return `${r.slice(0, INTEGRATE_FAIL_REASON_MAX)}…`;
}

export function buildIntegrateFailNotify(opts: {
  sessionName?: string;
  sessionId?: string;
  reason: string;
}): { label: string; text: string; kind: 'error'; updateKey?: string; sessionName: string } {
  const sessionName = opts.sessionName?.trim() || t('会话');
  const reason = clipIntegrateFailReason(opts.reason) || t('未知原因');
  const sid = opts.sessionId?.trim();
  return {
    label: t('合入失败'),
    kind: 'error',
    sessionName,
    text: t('合入「{{name}}」失败：{{reason}}', { name: sessionName, reason }),
    ...(sid ? { updateKey: `${INTEGRATE_FAIL_UPDATE_KEY_PREFIX}${sid}` } : {})
  };
}

/** NotifyStore.push 入参（无 electron；toast=true 是唯一可见出口） */
export function buildIntegrateFailNotifyPush(opts: {
  workspaceId: string;
  sessionId: string;
  sessionName?: string;
  reason: string;
}): {
  workspaceId: string;
  sessionId: string;
  sessionName: string;
  label: string;
  kind: 'error';
  text: string;
  update: boolean;
  updateKey?: string;
  toast: true;
} {
  const trace = buildIntegrateFailNotify({
    sessionName: opts.sessionName,
    sessionId: opts.sessionId,
    reason: opts.reason
  });
  return {
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId,
    sessionName: trace.sessionName,
    label: trace.label,
    kind: 'error',
    text: trace.text,
    update: Boolean(trace.updateKey),
    ...(trace.updateKey ? { updateKey: trace.updateKey } : {}),
    toast: true
  };
}
