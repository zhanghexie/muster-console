import type { SafetyMessage } from '../../../shared/safety';
import { getResolvedLocale, t } from '../../../shared/i18n';
import { localizeSafetyReason, localizeSafetySummary } from '../../../shared/safetyReason';

const STATUS_LABELS: Record<string, string> = {
  reviewing: '审核中', allowed: '已通过', needs_confirmation: '需要你确认', denied: '未执行', failed: '审核异常'
};

/** Translate only host-authored envelopes; the embedded user/model detail stays verbatim. */
export function safetyMessageDisplay(message: SafetyMessage): string {
  const text = message.text;
  if (message.role === 'system' && message.origin === 'approval_request') {
    const request = /^审批请求：([^。]*)。([\s\S]*)$/.exec(text);
    if (request) return t('审批请求：{{action}}。{{summary}}', { action: request[1], summary: localizeSafetySummary(request[1], request[2]) });
  }
  if (message.role === 'system' && message.origin === 'human_decision') {
    const decision = /^(用户在人工确认弹窗中(?:批准|拒绝)本次操作：)([^。]+)。([\s\S]*)$/.exec(text);
    if (decision) {
      const summary = localizeSafetySummary(decision[2], decision[3]);
      if (summary !== decision[3]) return localizeSafetyReason(decision[1] + t('{{action}}。{{summary}}', { action: decision[2], summary }));
    }
    return localizeSafetyReason(text);
  }
  if (message.role === 'assistant' && message.origin === 'reviewer' && message.requestId) {
    if (text === '通过') return getResolvedLocale() === 'zh-CN' ? text : t('已通过');
    if (text.startsWith('需要人工审核：')) return localizeSafetyReason(text);
  }
  if (message.role !== 'system' || message.origin !== 'service') return text;
  if (text === '人工确认超时，本次操作未授权。') return t('人工确认超时，本次操作未授权。');
  if (text === '本次审批已由人工确认弹窗接管。聊天消息不会批准操作，请在弹窗中确认或拒绝。') {
    return t('本次审批已由人工确认弹窗接管。聊天消息不会批准操作，请在弹窗中确认或拒绝。');
  }
  const status = /^本次审批状态：([a-z_]+)。聊天消息不会重新审批；需要重试时请从原操作入口重新提交。$/.exec(text);
  if (status) return t('本次审批状态：{{status}}。聊天消息不会重新审批；需要重试时请从原操作入口重新提交。', {
    status: getResolvedLocale() !== 'zh-CN' && Object.hasOwn(STATUS_LABELS, status[1]) ? t(STATUS_LABELS[status[1]]) : status[1]
  });
  const handedOff = '。已转交人工确认弹窗，请在弹窗决定本次操作。';
  if (text.endsWith(handedOff)) return t('{{reason}}。已转交人工确认弹窗，请在弹窗决定本次操作。', { reason: localizeSafetyReason(text.slice(0, -handedOff.length)) });
  const unavailable = '。人工确认通道不可用，本次操作未授权；请恢复确认通道后重新提交。';
  if (text.endsWith(unavailable)) return t('{{reason}}。人工确认通道不可用，本次操作未授权；请恢复确认通道后重新提交。', { reason: localizeSafetyReason(text.slice(0, -unavailable.length)) });
  return localizeSafetyReason(text);
}
