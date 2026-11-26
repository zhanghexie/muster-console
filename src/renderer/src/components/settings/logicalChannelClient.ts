import { useCallback, useLayoutEffect, useRef } from 'react';
import type { LogicalChannelMethod } from '../../../../shared/messagingChannels';
import { t } from '../../../../shared/i18n';

/** Global management omits workspaceId; workspace bindings and inbox calls set it explicitly. */
export function useLogicalChannelClient(workspaceId: string | undefined, active: boolean) {
  const scope = useRef({ active, workspaceId, requests: new Set<AbortController>() });
  useLayoutEffect(() => {
    const state = scope.current;
    state.active = active;
    state.workspaceId = workspaceId;
    return () => {
      state.active = false;
      for (const request of state.requests) request.abort();
      state.requests.clear();
    };
  }, [active, workspaceId]);
  return useCallback(async <T,>(method: LogicalChannelMethod, payload: Record<string, unknown> = {}): Promise<T> => {
    const state = scope.current;
    if (!state.active || state.workspaceId !== workspaceId) throw new DOMException('Closed', 'AbortError');
    const request = new AbortController();
    const requestId = crypto.randomUUID();
    state.requests.add(request);
    const cancel = (): void => { void window.api.messaging.cancel(requestId).catch(() => {}); };
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await window.api.messaging.call('channels', method, { ...payload, ...(workspaceId !== undefined && { workspaceId }) }, requestId);
      request.signal.throwIfAborted();
      if (!response.ok) throw new Error(typeof response.error === 'string' ? response.error : channelErrorMessage(response.error.code, response.error.message));
      return response.value as T;
    } finally {
      request.signal.removeEventListener('abort', cancel);
      state.requests.delete(request);
    }
  }, [workspaceId]);
}

function channelErrorMessage(code: string, fallback?: string): string {
  switch (code) {
    case 'channel-source-offline': return t('消息源已离线，请在连接账号中恢复连接。');
    case 'channel-source-read-only': return t('此消息源只有读取权限，请先在 Channel 中允许回复。');
    case 'channel-source-not-sendable': return t('此消息源当前不能发送，请检查账号连接与平台权限。');
    case 'channel-source-not-found': case 'channel-source-not-granted': case 'channel-source-changed':
      return t('消息源已变更，请刷新后重新选择。');
    case 'channel-remote-source-in-use': return t('此对话已绑定其他远程目标，请先停用原绑定。');
    case 'channel-remote-target-unavailable': return t('目标会话已不可用，请选择仍存在的工作会话。');
    case 'channel-remote-disabled': return t('请先为此消息源启用远程输入。');
    case 'remote-sender-unverifiable': return t('此消息源不能验证远程操作人，请选择其他 IM 对话。');
    case 'channel-workspace-not-found': return t('工作区已不可用，请返回工作台重新选择工作区。');
    case 'channel-not-found': return t('Channel 已被移除，请刷新列表。');
    case 'channel-not-bound': return t('当前工作区尚未绑定此 Channel，请先在手机中绑定。');
    case 'logical-channel-store-unavailable': return t('Channel 数据暂时无法读取，请重试；若仍失败，请查看诊断日志中的存储错误。');
    case 'channel-request-conflict': return t('同一发送请求的内容已变化，请检查原对话后重新发送。');
    default: return fallback || code;
  }
}

export function channelDiagnosticReason(reason: string): string {
  switch (reason) {
    case 'sender-not-authorized': return t('此操作人尚未授权，请在当前对话完成验证码验证。');
    case 'bot-not-connected': case 'unknown-bot': return t('消息源已离线，请在连接账号中恢复连接。');
    case 'account-changed': case 'target-changed': case 'stale-route':
      return t('消息来源或目标已变更，请刷新后核对绑定。');
    case 'invalid-target': return t('发送目标不可用，请检查来源对话是否仍然存在。');
    case 'capability-unavailable': case 'channel-source-not-sendable':
      return t('此消息源当前不能发送，请检查账号连接与平台权限。');
    case 'delivery-context-unavailable': return t('回复所需的会话凭据已失效，请先在原对话发送一条新消息。');
    case 'thread-unavailable': return t('原消息线程已不可用，请打开原对话核对。');
    case 'send-result-unknown': return t('无法确认消息是否发出，请先检查原对话，避免重复发送。');
    case 'remote-store-unavailable': return t('远程授权暂时无法读取，请查看诊断日志后重试。');
    case 'remote-result-unknown': return t('无法确认远程处理结果，请检查目标会话和原对话。');
    case 'remote-target-unavailable': return t('目标会话暂时不能接收输入，请在工作台检查会话状态后重试。');
    default: return channelErrorMessage(reason);
  }
}

export function isChannelCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function channelProviderLabel(provider: string): string {
  switch (provider) {
    case 'feishu': case 'legacy-feishu': return t('飞书');
    case 'weixin': return t('微信');
    case 'wecom': return t('企业微信');
    case 'wecom-app': return t('企业微信应用');
    case 'dingtalk': return t('钉钉');
    case 'email': case 'legacy-mail': return t('邮箱');
    case 'qq': return 'QQ';
    case 'slack': return 'Slack';
    case 'telegram': return 'Telegram';
    case 'discord': return 'Discord';
    case 'whatsapp': return 'WhatsApp';
    case 'imessage': return 'iMessage';
    case 'matrix': return 'Matrix';
    default: return provider;
  }
}
