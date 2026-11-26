import { ErrorTip } from '../components/ErrorTip';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CHANNEL_APP_ID, type AppQuery } from '../../../shared/agentApps';
import type { LogicalChannel, LogicalChannelMessage, LogicalChannelMessagePage, LogicalChannelSourceGrant } from '../../../shared/messagingChannels';
import { randomUuid } from '../../../shared/randomUuid';
import { CustomSelect } from '../components/CustomSelect';
import { channelDiagnosticReason, channelProviderLabel } from '../components/settings/logicalChannelClient';
import { localizeAppUserErrorText } from '../../../shared/appUserErrors';
import { APP_RECORD_PLACEHOLDERS } from '../../../shared/appRecordPlaceholders';
import { appConnectionNameText } from '../../../shared/appConnectionName';
import type { PhoneRoute } from './presentation';

interface Props {
  workspaceId: string;
  workspaceName?: string;
  route: PhoneRoute;
  search: string;
  revision: number;
  active: boolean;
  navigate(route: PhoneRoute): void;
}

export function ChannelAppView(props: Props) {
  return props.route.viewId === 'bindings'
    ? <ChannelBindingsView key={props.workspaceId} {...props} />
    : <ChannelInboxView key={props.workspaceId} {...props} />;
}

function ChannelInboxView({ workspaceId, route, search, revision, active, navigate }: Props) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<LogicalChannel[]>();
  const [page, setPage] = useState<LogicalChannelMessagePage>();
  const [searchTerm, setSearchTerm] = useState('');
  const [searchLimited, setSearchLimited] = useState(false);
  const [message, setMessage] = useState<LogicalChannelMessage>();
  const [unread, setUnread] = useState(false);
  const [unprocessed, setUnprocessed] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  const pageRequest = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const scope = { appId: CHANNEL_APP_ID, channelId: route.channelId, viewId: 'main' };
  const query: AppQuery = { appId: CHANNEL_APP_ID, channelId: route.channelId, id: route.entityId, search: searchTerm, channelQuery: { sourceId: route.accountId, drafts: route.folder === 'drafts', unread: unread || undefined, processed: unprocessed ? false : undefined } };
  useEffect(() => {
    if (!search.trim()) { setSearchTerm(''); return; }
    if (!active) return;
    const timer = window.setTimeout(() => setSearchTerm(search.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [search, active]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void window.api.agentApps.query(workspaceId, { appId: CHANNEL_APP_ID }).then(result => { if (current) setChannels(result.channels ?? []); }).catch(error => { if (current) setError(errorText(error)); });
    return () => { current = false; };
  }, [active, workspaceId, revision, attempt]);
  useEffect(() => {
    if (!active) return;
    let adjusted = true;
    const token = ++pageRequest.current;
    const load = route.channelId && !(route.editCommand === 'send' && !route.entityId) || !route.channelId && searchTerm;
    setError(''); setPageBusy(!!load);
    if (!load) { setPage(undefined); setMessage(undefined); return; }
    void window.api.agentApps.query(workspaceId, query).then(result => {
      if (adjusted && pageRequest.current === token) { setPage(result?.channelMessages); setMessage(result?.channelMessage); setSearchLimited(result?.searchLimited ?? false); }
    }).catch(error => { if (adjusted) { setPage(undefined); setMessage(undefined); setError(errorText(error)); } })
      .finally(() => { if (adjusted && pageRequest.current === token) setPageBusy(false); });
    return () => { adjusted = false; pageRequest.current++; };
  }, [active, workspaceId, route.channelId, route.entityId, route.accountId, route.folder, route.editCommand, searchTerm, unread, unprocessed, revision, attempt]);
  const channel = channels?.find(item => item.id === route.channelId);
  const source = channel?.sources.find(grant => grant.sourceId === route.accountId);
  const sourceFor = (id: string) => channel?.sources.find(grant => grant.sourceId === id);
  const sourceName = (grant: LogicalChannelSourceGrant) => appConnectionNameText({ name: grant.source.label, namePlaceholder: grant.source.legacyNamePlaceholder });
  const sourceText = (grant: LogicalChannelSourceGrant | undefined) => grant ? `${channelProviderLabel(grant.source.provider)} · ${sourceName(grant)}` : t('未知来源');
  const replyGrant = message && sourceFor(message.sourceId);
  const canSend = (grant: LogicalChannelSourceGrant | undefined) => !!grant && grant.permission === 'reply' && grant.source.connected && grant.source.canSend;
  const canDraft = (grant: LogicalChannelSourceGrant) => grant.source.provider === 'email' && grant.sourceId.startsWith('legacy:');
  const hasComposeTarget = channel?.sources.some(grant => canSend(grant) || canDraft(grant));
  const headings = route.editCommand === 'reply' ? t('回复') : route.editCommand === 'send' ? t('撰写消息') : source ? sourceName(source) : channel?.name ?? 'Channel';
  const renderMessage = (item: LogicalChannelMessage, showChannel = false) => {
    const itemChannel = showChannel ? channels?.find(row => row.id === item.channelId) : channel;
    const label = sourceText(itemChannel?.sources.find(grant => grant.sourceId === item.sourceId));
    return <button type="button" className="ap-channel-row" key={`${item.channelId}:${item.id}`} onClick={() => navigate({ ...route, channelId: item.channelId, entityId: item.id })}>
      <small>{showChannel && itemChannel ? `${itemChannel.name} · ${label}` : label}</small>
      <strong>{legacyText(t, item, 'subject') || legacyText(t, item, 'sender') || (item.direction === 'outbound' ? statusLabel(t, item.status) : t('消息'))}</strong>
      <span>{legacyText(t, item, 'body')}</span>
      <small>{item.direction === 'inbound' && !item.read ? `${t('未读')} · ` : ''}{new Date(item.createdAt).toLocaleString()}</small>
    </button>;
  };

  async function loadMore() {
    if (!page?.nextCursor || pageBusy) return;
    const token = ++pageRequest.current;
    setPageBusy(true); setError('');
    try {
      const result = await window.api.agentApps.query(workspaceId, { ...query, channelQuery: { ...query.channelQuery, after: page.nextCursor } });
      if (token !== pageRequest.current || !result.channelMessages) return;
      const fresh = result.channelMessages;
      setPage(previous => ({ messages: [...(previous?.messages ?? []), ...fresh.messages], nextCursor: fresh.nextCursor }));
    } catch (error) { if (token === pageRequest.current) setError(errorText(error)); }
    finally { if (token === pageRequest.current) setPageBusy(false); }
  }
  async function changeMessage(params: { read?: boolean; processed?: boolean }) {
    if (!message || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError('');
    try {
      const result = await window.api.agentApps.call(workspaceId, { appId: CHANNEL_APP_ID, commandId: 'state', params: { channelId: route.channelId, messageId: message.id, ...params } });
      if (result.channelMessage) setMessage(result.channelMessage);
    } catch (error) { setError(errorText(error)); }
    finally { pendingRef.current = false; setPending(false); }
  }

  return <>
    <header className="ap-heading ap-flight">{route.channelId && <small>Channel</small>}<h2>{headings}</h2></header>
    {error && <><ErrorTip message={error} /><button type="button" onClick={() => retry(i => i + 1)}>{t('重试')}</button></>}
    {!channels ? <p className="ap-empty" role="status">{t('正在加载…')}</p> : !route.channelId ?
      <div className="ap-scroll ap-channel-list ap-flight">
        <div className="ap-channel-actions"><button type="button" className="ap-primary" onClick={() => navigate({ appId: CHANNEL_APP_ID, viewId: 'bindings' })}>{t('绑定 Channel')}</button></div>
        {search.trim() && <>
          {pageBusy || searchTerm !== search.trim() ? <p className="ap-muted" role="status">{t('正在搜索…')}</p> : <>
            {page?.messages.map(item => renderMessage(item, true))}
            {!page?.messages.length && <p className="ap-muted">{t('暂无匹配消息')}</p>}
            {searchLimited && <p className="ap-muted">{t('仅显示最近的匹配消息。可缩小搜索范围。')}</p>}
          </>}
        </>}
        {channels.filter(item => !search || [item.name, ...item.sources.map(grant => sourceText(grant))].some(name => name.toLowerCase().includes(search.toLowerCase()))).map(item =>
          <button type="button" className="ap-channel-row" key={item.id} onClick={() => navigate({ ...scope, channelId: item.id })}><strong>{item.name}</strong><small>{item.sources.map(grant => sourceText(grant)).join(' / ')}</small></button>)}
        {!channels.length && <p className="ap-empty">{t('此工作区尚未绑定 Channel。先从全局目录选择要使用的 Channel。')}</p>}
      </div> : !channel ? <p className="ap-empty">{t('渠道不可用')}</p> :
      <div className="ap-scroll ap-channel-list ap-flight">
        {route.editCommand ? (!route.entityId || message) && <ChannelComposer workspaceId={workspaceId} channel={channel} reply={route.editCommand === 'reply' ? message : undefined}
          draft={message?.status === 'draft' ? message : undefined} initialSourceId={route.accountId} sourceText={sourceText} canSend={canSend}
          onComplete={result => { if (activeRef.current) navigate({ ...scope, accountId: route.accountId, folder: result.status === 'draft' ? 'drafts' : undefined, entityId: result.id }); }}/>
          : route.entityId ? message && <article className="ap-channel-detail">
            <p className="ap-muted">{sourceText(replyGrant)} · {new Date(message.createdAt).toLocaleString()}</p>
            {(message.subject || message.senderLabel) && <h3>{message.subject ? legacyText(t, message, 'subject') : legacyText(t, message, 'sender')}</h3>}
            {message.senderLabel && message.subject && <p className="ap-muted">{t('发件人')} {legacyText(t, message, 'sender')}</p>}
            {message.recipient && <p className="ap-muted">{t('收件人')} {message.recipient}</p>}
            <p className="ap-channel-body">{legacyText(t, message, 'body')}</p>
            {message.attachments && <details><summary>{t('附件信息')}</summary><p className="ap-channel-body">{message.attachments}</p></details>}
            {message.direction === 'outbound' && <p className="ap-muted">{statusLabel(t, message.status)}</p>}
            <div className="ap-channel-actions">
              {message.direction === 'inbound' && <>
                {canSend(replyGrant) && <button type="button" className="ap-primary" onClick={() => navigate({ ...route, editCommand: 'reply' })}>{t('回复')}</button>}
                <button type="button" disabled={pending} onClick={() => void changeMessage({ read: !message.read })}>{t(message.read ? '标为未读' : '标为已读')}</button>
                <button type="button" disabled={pending} onClick={() => void changeMessage({ processed: !message.processed })}>{t(message.processed ? '标为未处理' : '标为已处理')}</button>
              </>}
              {message.status === 'draft' && <button type="button" className="ap-primary" onClick={() => navigate({ ...route, editCommand: 'send' })}>{t('编辑草稿')}</button>}
            </div>
          </article> : <>
            <div className="ap-channel-actions">
              {hasComposeTarget && <button type="button" className="ap-primary" onClick={() => navigate({ ...route, editCommand: 'send' })}>{t('撰写消息')}</button>}
              {channel.sources.some(canDraft) && <button type="button" aria-pressed={route.folder === 'drafts'} onClick={() => navigate({ ...route, folder: route.folder === 'drafts' ? undefined : 'drafts' })}>{t('草稿')}</button>}
            </div>
            {!route.accountId && !route.folder && channel.sources.length > 1 && <nav className="ap-channel-sources" aria-label={t('对话来源')}>
              {channel.sources.map(grant => <button type="button" className="ap-channel-row" key={grant.sourceId} onClick={() => navigate({ ...route, accountId: grant.sourceId })}>{sourceText(grant)}</button>)}
            </nav>}
            <div role="search" aria-label={t('筛选消息')} className="ap-channel-actions">
              {!route.folder && <><button type="button" aria-pressed={unread} onClick={() => setUnread(value => !value)}>{t('未读')}</button><button type="button" aria-pressed={unprocessed} onClick={() => setUnprocessed(value => !value)}>{t('未处理')}</button></>}
            </div>
            {page?.messages.map(item => renderMessage(item))}
            {page?.nextCursor && <button type="button" disabled={pageBusy} onClick={() => void loadMore()}>{t('加载更多')}</button>}
            {!pageBusy && !page?.messages.length && <p className="ap-empty">{t('暂无消息')}</p>}
          </>}
        {pageBusy && <p className="ap-muted" role="status">{t('正在加载…')}</p>}
      </div>}
  </>;
}

function ChannelBindingsView({ workspaceId, workspaceName, active, revision, search }: Props) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<{ id: string; name: string; sourceCount: number; bound: boolean }[]>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [attempt, retry] = useState(0);
  const alive = useRef(active);
  const inFlight = useRef(false);
  alive.current = active;
  useEffect(() => {
    if (!active) return;
    let current = true;
    void window.api.agentApps.query(workspaceId, { appId: CHANNEL_APP_ID, viewId: 'bindings' }).then(result => {
      if (current) { setCatalog(result.channelCatalog ?? []); setError(''); }
    }).catch(error => { if (current) setError(errorText(error)); });
    return () => { current = false; };
  }, [workspaceId, active, revision, attempt]);
  useEffect(() => () => { alive.current = false; }, []);

  async function toggle(channel: { id: string; name: string; bound: boolean }) {
    if (inFlight.current || !alive.current) return;
    inFlight.current = true; setPending(channel.id); setError(''); setNotice('');
    try {
      await window.api.agentApps.call(workspaceId, { appId: CHANNEL_APP_ID, commandId: channel.bound ? 'unbind' : 'bind', params: { channelId: channel.id } });
      if (!alive.current) return;
      setNotice(t(channel.bound ? '已解除此工作区与 {{name}} 的绑定。全局 Channel 和其他工作区不受影响。' : '此工作区已绑定 {{name}}。', { name: channel.name }));
      retry(value => value + 1);
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { inFlight.current = false; if (alive.current) setPending(''); }
  }

  return <>
    <header className="ap-heading ap-flight"><small>{workspaceName ?? t('当前工作区')}</small><h2>{t('绑定 Channel')}</h2></header>
    <div className="ap-scroll ap-channel-list ap-flight">
      <p className="ap-muted">{t('从全局目录选择此工作区使用的 Channel。绑定后，调度 Agent 可以读取和处理其中的消息。')}</p>
      <div className="ap-channel-actions"><button type="button" disabled={!!pending} onClick={() => retry(value => value + 1)}>{t('刷新目录')}</button></div>
      {error && <><ErrorTip message={error} /><button type="button" onClick={() => retry(value => value + 1)}>{t('重试')}</button></>}
      {!catalog && !error && <p className="ap-muted" role="status">{t('正在加载…')}</p>}
      {catalog?.filter(item => !search || item.name.toLowerCase().includes(search.toLowerCase())).map(channel => <section className="ap-channel-binding" key={channel.id}>
        <h3>{channel.name}</h3><p className="ap-muted">{t('{{count}} 个消息源', { count: channel.sourceCount })} · {channel.bound ? t('已绑定') : t('未绑定')}</p>
        <button type="button" className={channel.bound ? '' : 'ap-primary'} disabled={!!pending}
          aria-label={t(channel.bound ? '解除绑定 {{name}}' : '绑定 {{name}}', { name: channel.name })}
          onClick={() => void toggle(channel)}>{pending === channel.id ? t('执行中') : t(channel.bound ? '解除绑定' : '绑定')}</button>
      </section>)}
      {catalog?.length === 0 && <p className="ap-empty">{t('全局目录还没有 Channel，请先在设置 → Channels 中创建。')}</p>}
      <p className="ap-muted" role="status" aria-live="polite">{notice}</p>
    </div>
  </>;
}

function statusLabel(t: ReturnType<typeof useTranslation>['t'], status: LogicalChannelMessage['status']): string {
  const labels = { received: t('已收到'), submitted: t('发送中'), sent: t('已发送'), failed: t('发送失败'), unknown: t('发送结果未确认'), draft: t('草稿') };
  return labels[status];
}

function legacyText(t: ReturnType<typeof useTranslation>['t'], message: LogicalChannelMessage, field: 'sender' | 'body' | 'subject'): string {
  const value = field === 'sender' ? message.senderLabel : field === 'body' ? message.text : message.subject ?? '';
  const kind = message.legacyPlaceholderFields?.[field];
  if (!kind || !Object.hasOwn(APP_RECORD_PLACEHOLDERS, kind)) return value;
  const placeholder = APP_RECORD_PLACEHOLDERS[kind];
  return placeholder.field === field && placeholder.source === value ? t(value) : value;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:channel-|logical-channel-)\S+$/.test(message) ? channelDiagnosticReason(message) : localizeAppUserErrorText(message);
}

function ChannelComposer({ workspaceId, channel, initialSourceId, reply, draft, sourceText, canSend, onComplete }: {
  workspaceId: string; channel: LogicalChannel; initialSourceId?: string; reply?: LogicalChannelMessage; draft?: LogicalChannelMessage;
  sourceText(grant: LogicalChannelSourceGrant | undefined): string; canSend(grant: LogicalChannelSourceGrant | undefined): boolean;
  onComplete(message: LogicalChannelMessage): void;
}) {
  const { t } = useTranslation();
  const fixed = reply?.sourceId ?? draft?.sourceId;
  const [sourceId, setSourceId] = useState(fixed ?? initialSourceId ?? '');
  const [body, setBody] = useState(draft?.text ?? '');
  const [recipient, setRecipient] = useState(draft?.recipient ?? '');
  const [subject, setSubject] = useState(draft?.subject ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const inFlight = useRef(false);
  const grant = channel.sources.find(source => source.sourceId === sourceId);
  const mail = !reply && grant?.source.provider === 'email';
  const legacyMail = mail && sourceId.startsWith('legacy:');
  const choices = [{ value: '', label: t('选择一个发送来源') }, ...channel.sources
    .filter(source => canSend(source) || source.source.provider === 'email' && source.sourceId.startsWith('legacy:'))
    .map(source => ({ value: source.sourceId, label: sourceText(source) }))];

  async function submit(saveDraft = false) {
    if (inFlight.current) return;
    if (!grant || !saveDraft && !canSend(grant)) { setError(t('请选择有发送权限的来源')); return; }
    const params = { channelId: channel.id, sourceId, text: body, ...(mail ? { subject } : {}), ...(legacyMail ? { recipient } : {}), ...(reply ? { messageId: reply.id } : {}), ...(draft ? { draftId: draft.id, expectedRevision: draft.revision } : {}) };
    const key = JSON.stringify(params);
    if (!attempt.current || attempt.current.key !== key) attempt.current = { id: randomUuid(), key };
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (draft && !saveDraft && (body !== draft.text || recipient !== (draft.recipient ?? '') || subject !== (draft.subject ?? ''))) {
        setError(t('发送前请先保存草稿。')); return;
      }
      const result = await window.api.agentApps.call(workspaceId, { appId: CHANNEL_APP_ID, commandId: saveDraft ? 'save-draft' : reply ? 'reply' : 'send', params, requestId: saveDraft ? undefined : attempt.current.id });
      if (!result.channelMessage) throw new Error(t('未收到发送结果'));
      if (result.channelMessage.status === 'failed' || result.channelMessage.status === 'unknown') setError(statusLabel(t, result.channelMessage.status));
      else onComplete(result.channelMessage);
    } catch (error) { setError(errorText(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <form className="ap-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
    {fixed ? <p className="ap-muted">{t('来源')} · {sourceText(grant)}</p> : <div className="ap-field"><span>{t('发送来源')}</span><CustomSelect className="ap-select" ariaLabel={t('发送来源')} value={sourceId} options={choices} onChange={setSourceId} disabled={busy}/></div>}
    {legacyMail && <label className="ap-field">{t('收件人')}<input name="recipient" value={recipient} type="text" inputMode="email" autoCapitalize="none" spellCheck={false} required maxLength={1000} onChange={event => setRecipient(event.target.value)}/></label>}
    {mail && <label className="ap-field">{t('邮件主题')}<input name="subject" maxLength={1000} value={subject} onChange={event => setSubject(event.target.value)}/></label>}
    <label className="ap-field">{t('消息内容')}<textarea name="body" rows={5} required maxLength={20_000} value={body} onChange={event => setBody(event.target.value)}/></label>
    {error && <ErrorTip message={error} />}
    {busy && <p role="status">{t('执行中')}</p>}
    <div className="ap-channel-actions">
      {(!grant && !fixed || canSend(grant)) && <button type="submit" className="ap-primary" disabled={busy}>{t(reply ? '发送回复' : '发送')}</button>}
      {legacyMail && <button type="button" disabled={busy} onClick={() => void submit(true)}>{t('保存草稿')}</button>}
    </div>
  </form>;
}
