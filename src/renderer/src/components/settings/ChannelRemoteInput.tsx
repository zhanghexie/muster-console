import { ErrorTip } from '../ErrorTip';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LogicalChannel, LogicalChannelDiagnostics, LogicalChannelRemoteStatus, LogicalChannelSourceGrant, LogicalChannelStage } from '../../../../shared/messagingChannels';
import { CustomSelect } from '../CustomSelect';
import { AnimatedDetails } from '../AnimatedDetails';
import { ChannelDisclosure } from './ChannelDisclosure';
import { channelDiagnosticReason, channelProviderLabel, isChannelCancellation, useLogicalChannelClient } from './logicalChannelClient';
import { Chevron, SettingsSection } from './shared';
import '../../styles/logical-channels.css';

function RemoteSourceBinding({ channelId, grant, active, refresh }: {
  channelId: string; grant: LogicalChannelSourceGrant;
  active: boolean; refresh: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const request = useLogicalChannelClient(undefined, active);
  const [status, setStatus] = useState<LogicalChannelRemoteStatus | null>(grant.remote);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [diagnostics, setDiagnostics] = useState<LogicalChannelDiagnostics | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const pair = { channelId, sourceId: grant.sourceId };
  const enabled = grant.remoteTarget !== null;
  const expiresAt = status?.binding?.expiresAt;
  useEffect(() => { setStatus(grant.remote); }, [grant.remote]);
  useEffect(() => {
    if (!active || !enabled || busy) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await request<LogicalChannelRemoteStatus>('remote.status', { channelId, sourceId: grant.sourceId });
        if (disposed) return;
        setStatus(next);
        if (next.binding) timer = setTimeout(() => void poll(), Math.min(1500, Math.max(100, next.binding.expiresAt - Date.now())));
      } catch (error) { if (!disposed && !isChannelCancellation(error)) setError(error instanceof Error ? error.message : String(error)); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [active, enabled, busy, request, channelId, grant.sourceId, revision]);
  useEffect(() => {
    if (!active || !expiresAt) return;
    const timer = setTimeout(() => {
      setStatus(current => current?.binding?.expiresAt === expiresAt ? { ...current, binding: null } : current);
    }, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [active, expiresAt]);
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (!active || pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); }
    catch (error) { if (!isChannelCancellation(error)) setError(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); setRevision(value => value + 1); }
  };
  const binding = status?.binding && status.binding.expiresAt > Date.now() ? status.binding : null;
  const loadDiagnostics = async (): Promise<void> => {
    setError('');
    try { setDiagnostics(await request<LogicalChannelDiagnostics>('diagnostics', { channelId })); }
    catch (error) { if (!isChannelCancellation(error)) setError(error instanceof Error ? error.message : String(error)); }
  };
  const stageNames: Record<LogicalChannelStage, string> = {
    receive: t('收到消息'), authorized: t('授权通过'), routed: t('开始投递会话'), reply: t('回复已送达'), failure: t('处理失败')
  };
  return <div className="logical-channel-remote-form">
    {!grant.source.canRemote ? <p className="s-sec-desc" role="status">{t('此消息源可用于 Channel 收件，不支持验证远程操作人。请选择身份可验证的 IM 对话。')}</p> : <>
      <p className="s-sec-desc">{t('授权后可远程切换所有工作区和绑定会话；无需先为工作区绑定 Channel。')}</p>
      <p className="s-sec-desc">{t('使用目标会话的模型、思考强度和上下文。')}</p>
      <div className="logical-channel-route"><span>{t(channelProviderLabel(grant.source.provider))} · {grant.source.label}</span><span aria-hidden="true">→</span><span>{t('全局工作台')}</span></div>
      <dl className="logical-channel-diagnostics">
        <div><dt><code>/ws</code></dt><dd>{t('切换工作区')}</dd></div>
        <div><dt><code>/s</code></dt><dd>{t('切换调度会话')}</dd></div>
        <div><dt><code>/bind</code></dt><dd>{t('选择工作会话')}</dd></div>
        <div><dt><code>/unbind</code></dt><dd>{t('返回调度会话')}</dd></div>
      </dl>
      <div className="logical-channel-setting"><div>{t('已授权操作人')}<p className="s-sec-desc">{status?.ready ? t('仅下列操作人可以在此对话输入指令。') : t('尚无授权操作人')}</p></div><span className={`s-tag${status?.ready && enabled ? ' ok' : ''}`}>
        {!enabled ? t('未开启') : status?.ready ? t('已启用') : t('等待验证')}</span></div>
      {status?.boundUsers.map(user => <div className="logical-channel-setting" key={user.id}><span>{user.label}</span>
        <button type="button" className="btn tiny" disabled={busy} aria-label={t('解除绑定 {{name}}', { name: user.label })} onClick={() => void run(async () => {
          setStatus(await request<LogicalChannelRemoteStatus>('remote.revoke', { ...pair, bindingId: user.id }));
        })}>{t('解除绑定')}</button></div>)}
      {!grant.source.connected && <p className="s-sec-desc" role="status">{t('消息源连接不可用，请先在 Channels 中恢复账号连接。')}</p>}
      <div className="logical-channel-actions">
        <button type="button" className="btn primary" disabled={busy || !grant.source.connected} onClick={() => void run(async () => {
          if (!enabled) await request('sources.update', { ...pair, remoteTarget: { kind: 'workbench' } });
          setStatus(await request<LogicalChannelRemoteStatus>('remote.begin', pair));
        })}>{binding ? t('换一个码') : enabled ? t('验证操作人') : t('启用并验证操作人')}</button>
        {enabled && <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
          await request('sources.update', { ...pair, remoteTarget: null }); setStatus(null); setNotice(t('远程输入已停用，Channel 收件继续可用。'));
        })}>{t('停用远程输入')}</button>}
      </div>
      <ChannelDisclosure id={`channel-binding-${grant.sourceId}`} open={Boolean(binding) && active}>
        {binding && <div className="logical-channel-code"><p>{t('在选定对话中发送此验证码，群聊请 @机器人。验证码只对当前消息源有效。')}</p><div className="logical-channel-actions"><code>{binding.code}</code>
          <button type="button" className="btn tiny" onClick={() => { void navigator.clipboard.writeText(binding.code).then(() => setNotice(t('已复制绑定码'))).catch(() => setError(t('复制失败，请手动复制绑定码。'))); }}>{t('复制绑定码')}</button></div>
          <p className="s-sec-desc">{t('此绑定码将于 {{time}} 过期', { time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(binding.expiresAt) })}</p></div>}
      </ChannelDisclosure>
    </>}
    <AnimatedDetails className="s-adv" open={diagnosticsOpen} onToggle={open => { setDiagnosticsOpen(open); if (open) void loadDiagnostics(); }} summary={<><Chevron />{t('收发诊断')}</>}>
      <div className="logical-channel-form s-adv-body">
        <p className="s-sec-desc">{t('当前 Channel 的累计处理记录。账号连接、接收消息和回复送达分别记录。')}</p>
        {diagnostics && <>
          <dl className="logical-channel-diagnostics">{(Object.keys(stageNames) as LogicalChannelStage[]).map(stage => <div key={stage}><dt>{stageNames[stage]}</dt><dd>{diagnostics.stages[stage] ?? 0}</dd></div>)}</dl>
          {diagnostics.lastStage && <p>{t('最近阶段：{{stage}}', { stage: stageNames[diagnostics.lastStage.stage] })} · {new Date(diagnostics.lastStage.at).toLocaleString()}</p>}
          {diagnostics.lastStage?.reason && <p role="status">{t('处理说明：{{reason}}', { reason: channelDiagnosticReason(diagnostics.lastStage.reason) })}</p>}
          {diagnostics.unknown > 0 && <p>{t('有 {{count}} 条发送结果未知，请先检查原对话再决定是否重发。', { count: diagnostics.unknown })}</p>}
        </>}
        <button type="button" className="btn" onClick={() => void loadDiagnostics()}>{t('刷新状态')}</button>
      </div>
    </AnimatedDetails>
    {error && <ErrorTip message={t('Channel 操作失败：{{message}}', { message: error })} />}
    <p className="logical-channel-notice" role="status" aria-live="polite">{notice}</p>
  </div>;
}

export function ChannelRemoteInput({ active = true, onOpenChannels }: {
  active?: boolean; onOpenChannels?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const request = useLogicalChannelClient(undefined, active);
  const [channels, setChannels] = useState<LogicalChannel[]>([]);
  const [channelId, setChannelId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async (): Promise<void> => {
    setChannels(await request<LogicalChannel[]>('list')); setLoading(false);
  }, [request]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void refresh().catch(error => { if (!disposed && !isChannelCancellation(error)) { setError(error instanceof Error ? error.message : String(error)); setLoading(false); } });
    return () => { disposed = true; };
  }, [active, refresh]);
  const selected = channels.find(channel => channel.id === channelId) ?? channels[0];
  const grant = selected?.sources.find(source => source.sourceId === sourceId) ?? selected?.sources[0];
  return <SettingsSection title={t('远程输入')} item="remote-messaging" desc={t('全局遥控工作台。先验证操作人，再在消息软件中选择工作区和会话。')}
    side={onOpenChannels && <button type="button" className="btn" onClick={onOpenChannels}>{t('管理 Channels')}</button>}>
    {loading ? <p role="status" className="s-sec-desc">{t('正在读取 Channels…')}</p> : !channels.length ? <p className="s-sec-desc">{t('请先在 Channels 中创建 Channel 并添加消息源。')}</p> : <div className="logical-channel-form">
      <label className="logical-channel-field"><span>{t('使用 Channel')}</span><CustomSelect value={selected?.id ?? ''} ariaLabel={t('使用 Channel')} menuEnabled={active}
        options={channels.map(channel => ({ value: channel.id, label: channel.name }))} onChange={id => { setChannelId(id); setSourceId(''); }} /></label>
      {selected?.sources.length ? <label className="logical-channel-field"><span>{t('允许接收指令的对话')}</span><CustomSelect value={grant?.sourceId ?? ''} ariaLabel={t('允许接收指令的对话')} menuEnabled={active}
        options={selected.sources.map(source => ({ value: source.sourceId, label: `${t(channelProviderLabel(source.source.provider))} · ${source.source.label}` }))} onChange={setSourceId} /></label>
        : <p className="s-sec-desc">{t('此 Channel 尚未添加消息源。')}</p>}
      {selected && grant && <RemoteSourceBinding key={`${selected.id}:${grant.sourceId}`} channelId={selected.id} grant={grant} active={active} refresh={refresh} />}
    </div>}
    {error && <><ErrorTip message={t('Channel 操作失败：{{message}}', { message: error })} /><button type="button" className="btn tiny" onClick={() => {
      setError(''); void refresh().catch(error => { if (!isChannelCancellation(error)) setError(String(error.message ?? error)); });
    }}>{t('重试')}</button></>}
  </SettingsSection>;
}
