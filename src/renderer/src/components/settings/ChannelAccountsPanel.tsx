import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MessagingChannelStatus, MessagingStatus } from '../../../../shared/messaging';
import {
  installChannelAccountStyles,
  ChannelAccountSettings,
  setChannelAccountLocale,
  type ChannelAccountCall
} from '../../../../main/messaging/dsh-im/adapters/client/channel-account-settings.js';
import { usePresence } from '../motion';
import { CustomSelect } from '../CustomSelect';
import { ChannelDisclosure } from './ChannelDisclosure';
import '../../styles/messaging-settings.css';

const STATUS_POLL_MS = 500;
function useChannelAccountCall(active: boolean): ChannelAccountCall {
  const scope = useRef<{ active: boolean; requests: Set<AbortController> }>({ active, requests: new Set() });
  useLayoutEffect(() => {
    const state = scope.current;
    state.active = active;
    return () => {
      state.active = false;
      for (const request of state.requests) request.abort();
      state.requests.clear();
    };
  }, [active]);

  return useMemo<ChannelAccountCall>(() => async (channel, method, payload, upstreamSignal) => {
    const state = scope.current;
    if (!state.active) throw new DOMException('Messaging panel closed', 'AbortError');
    upstreamSignal?.throwIfAborted();
    const controller = new AbortController();
    const signal = upstreamSignal ? AbortSignal.any([controller.signal, upstreamSignal]) : controller.signal;
    const requestId = crypto.randomUUID();
    const api = window.api.messaging;
    const cancel = (): void => { void api.cancel(requestId).catch(() => {}); };
    state.requests.add(controller);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await api.call(channel, method, payload, requestId);
      signal.throwIfAborted();
      if (!result.ok && typeof result.error === 'string') {
        return { ok: false, error: { code: 'messaging-request-failed', message: result.error } };
      }
      return result;
    } finally {
      state.requests.delete(controller);
      signal.removeEventListener('abort', cancel);
    }
  }, []);
}

function useMessagingStatus(active: boolean): [MessagingStatus | null, () => void] {
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => {
    setStatus(null);
    setRevision(current => current + 1);
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh(): Promise<void> {
      try {
        const latest = await window.api.messaging.status();
        if (cancelled) return;
        setStatus(latest);
        if (latest.state === 'initializing') timer = setTimeout(() => void refresh(), STATUS_POLL_MS);
      } catch {
        if (!cancelled) setStatus({ state: 'failed', channels: [] });
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, revision]);
  return [status, retry];
}

function ChannelContent({ channel, call }: {
  channel: MessagingChannelStatus;
  call: ChannelAccountCall;
}): React.JSX.Element {
  const { t } = useTranslation();
  const presence = usePresence(true);
  return (
    <div className="muster-messaging-content mp-panel" {...presence.spread}>
      {channel.supported ? (
        <>
          <p className="s-sec-desc muster-messaging-instructions">
            {channel.key === 'office'
              ? t('AI Office 是独立的任务连接器，用于接收和回传 Office 任务。')
              : t('此处只管理账号连接。消息源、通知和远程输入分别在 Channel 中配置。')}
          </p>
          <ChannelAccountSettings channel={channel.key} call={call} disclosure={{
            Disclosure: ChannelDisclosure,
            openLabel: t('展开账号管理'),
            closeLabel: t('收起账号管理'),
            provisionConnectedLabel: t('账号已连接。返回 Channels 添加消息源。'),
          }} />
        </>
      ) : (
        <p className="s-sec-desc" role="status">
          {channel.key === 'imessage' ? t('iMessage 仅在 macOS 上通过「信息」应用连接。')
            : channel.reason || t('此消息渠道在当前环境不可用。')}
        </p>
      )}
    </div>
  );
}

export default function ChannelAccountsPanel({ active = true }: { active?: boolean }): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh';
  const [appliedLocale, setAppliedLocale] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [status, retry] = useMessagingStatus(active);
  const call = useChannelAccountCall(active);
  useLayoutEffect(() => {
    setChannelAccountLocale(locale);
    setAppliedLocale(locale);
  }, [locale]);
  useLayoutEffect(installChannelAccountStyles, []);

  if (!status || status.state === 'initializing' || !appliedLocale) {
    return <p className="s-sec-desc" role="status">{t('正在初始化消息渠道…')}</p>;
  }
  if (status.state === 'failed') {
    return (
      <div className="muster-messaging-failure">
        <p className="s-sec-desc" role="alert">{t('无法获取消息渠道状态。')}</p>
        <button className="btn" type="button" onClick={retry}>{t('重试')}</button>
      </div>
    );
  }

  const channels = status.channels.map(channel => {
    if (channel.key === 'email') return { ...channel, label: t('邮箱') };
    if (channel.key === 'office') return { ...channel, label: t('AI Office 任务连接器') };
    return channel;
  });
  const selected = channels.find(channel => channel.key === selectedKey)
    ?? channels.find(channel => channel.supported) ?? channels[0];
  if (!selected) return <p className="s-sec-desc">{t('此消息渠道在当前环境不可用。')}</p>;
  return (
    <div className="muster-messaging-settings">
      <div className="muster-messaging-nav">
        <CustomSelect value={selected.key} ariaLabel={t('选择消息服务')} menuEnabled={active}
          options={channels.map(channel => ({ value: channel.key, label: channel.label }))} onChange={setSelectedKey} />
      </div>
      <section aria-label={selected.label}>
        <ChannelContent key={selected.key} channel={selected} call={call} />
      </section>
    </div>
  );
}
