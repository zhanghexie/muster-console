import { ErrorTip } from '../ErrorTip';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LogicalChannel, LogicalChannelNotify, LogicalChannelPermission, LogicalChannelSource } from '../../../../shared/messagingChannels';
import type { AppSnapshot } from '../../../../shared/agentApps';
import type { WorkspaceInfo } from '../../../../shared/types';
import { PhoneLegacyChannelSources } from '../../agentApps/PhoneLegacyChannelSources';
import { isWebGateway } from '../../webGatewayEnvironment';
import { CustomSelect } from '../CustomSelect';
import { AnimatedDetails } from '../AnimatedDetails';
import { usePresenceValue } from '../motion';
import { Chevron, SettingsSection, SettingsSubsection } from './shared';
import { channelProviderLabel, isChannelCancellation, useLogicalChannelClient } from './logicalChannelClient';
import '../../styles/logical-channels.css';

const ChannelAccountsPanel = lazy(() => import('./ChannelAccountsPanel'));

function ExistingChannelAccounts({ workspaceId, active }: { workspaceId: string; active: boolean }): React.JSX.Element | null {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.api.agentApps.snapshot(workspaceId).then(value => { if (!cancelled) { setSnapshot(value); setError(''); } })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [workspaceId, active, revision]);
  if (error) return <><ErrorTip message={t('无法读取已有连接：{{message}}', { message: error })} /><button type="button" className="btn tiny" onClick={() => setRevision(value => value + 1)}>{t('重试')}</button></>;
  if (!snapshot?.connections.length) return null;
  return <PhoneLegacyChannelSources workspaceId={workspaceId} snapshot={snapshot} refresh={() => setRevision(value => value + 1)} />;
}

type ChannelsSettingsProps = {
  workspaceId: string; workspaces?: Pick<WorkspaceInfo, 'id' | 'name'>[]; active?: boolean; onOpenRemote?: () => void;
};

export function ChannelsSettingsPanel(props: ChannelsSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  if (isWebGateway()) return <div className="settings-section logical-channels">
    <p className="s-sec-desc">{t('请在桌面端设置 Channels 和连接账号；配置完成后可在手机 Channel App 中使用。')}</p>
  </div>;
  return <DesktopChannelsSettingsPanel {...props} />;
}

function DesktopChannelsSettingsPanel({ workspaceId, workspaces, active = true, onOpenRemote }: ChannelsSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const request = useLogicalChannelClient(undefined, active);
  const [legacyWorkspace, setLegacyWorkspace] = useState(workspaceId);
  const availableWorkspaces = workspaces ?? (workspaceId ? [{ id: workspaceId, name: t('当前工作区') }] : []);
  const legacyWorkspaceId = availableWorkspaces.some(item => item.id === legacyWorkspace) ? legacyWorkspace : availableWorkspaces[0]?.id;
  const [channels, setChannels] = useState<LogicalChannel[]>([]);
  const [sources, setSources] = useState<LogicalChannelSource[]>([]);
  const [selection, setSelection] = useState('');
  const [page, setPage] = useState<'channels' | 'accounts'>('channels');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [permission, setPermission] = useState<LogicalChannelPermission>('read');
  const [rename, setRename] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const { presence, value: visiblePage } = usePresenceValue(page);
  const selected = channels.find(channel => channel.id === selection) ?? channels[0];

  const refresh = useCallback(async () => {
    const [nextChannels, nextSources] = await Promise.all([
      request<LogicalChannel[]>('list'), request<LogicalChannelSource[]>('sources.list')
    ]);
    setChannels(nextChannels);
    setSources(nextSources);
    setLoading(false);
  }, [request]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    setError('');
    void refresh().catch(error => { if (!disposed && !isChannelCancellation(error)) { setError(String(error.message ?? error)); setLoading(false); } });
    return () => { disposed = true; };
  }, [active, refresh]);
  useEffect(() => { setRename(selected?.name ?? ''); setSourceOpen(false); setRemoveOpen(false); }, [selected?.id, selected?.name]);
  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current || !active) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); }
    catch (error) { if (!isChannelCancellation(error)) setError(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  const available = sources.filter(source => !selected?.sources.some(grant => grant.sourceId === source.id));
  const chosen = available.find(source => source.id === sourceId) ?? available[0];
  const sourceOwner = (source: LogicalChannelSource): string | undefined => source.legacyOwnerWorkspaceId
    ? availableWorkspaces.find(item => item.id === source.legacyOwnerWorkspaceId)?.name ?? source.legacyOwnerWorkspaceId : undefined;
  const notifyOptions = [
    { value: 'digest', label: t('汇总通知') }, { value: 'wake', label: t('立即通知') }, { value: 'mute', label: t('不通知，仅收件') }
  ];
  const accounts = visiblePage === 'accounts';

  return <div className="settings-section logical-channels" data-settings-item="channels-main">
    <div className="logical-channel-toolbar">
      {accounts ? <button type="button" className="btn" onClick={() => { setPage('channels'); void perform(async () => {}); }}>{t('返回 Channels')}</button>
        : <p className="s-sec-desc">{t('全局管理 Channel 和消息来源。各工作区在手机 Channel App 中选择绑定。')}</p>}
      {!accounts && <button type="button" className="btn" onClick={() => setPage('accounts')}>{t('连接账号')}</button>}
    </div>
    {presence.mounted && <div className="mp-panel logical-channel-page" {...presence.spread}>
      {accounts ? <SettingsSection title={t('连接账号')} desc={t('连接一次，即可在多个 Channel 中使用。连接后，在目标对话发一条消息，群聊请 @机器人，再返回添加消息源。')}>
        <Suspense fallback={<p className="s-sec-desc" role="status">{t('正在初始化消息渠道…')}</p>}>
          <ChannelAccountsPanel active={active && page === 'accounts'} />
        </Suspense>
        {legacyWorkspaceId && <SettingsSubsection title={t('已有连接')}>
          {availableWorkspaces.length > 1 && <CustomSelect value={legacyWorkspaceId} ariaLabel={t('已有连接所在工作区')} menuEnabled={active && page === 'accounts'}
            options={availableWorkspaces.map(item => ({ value: item.id, label: item.name }))} onChange={setLegacyWorkspace} />}
          <ExistingChannelAccounts key={legacyWorkspaceId} workspaceId={legacyWorkspaceId} active={active && page === 'accounts'} />
        </SettingsSubsection>}
      </SettingsSection> : <>
        {loading ? <p className="s-sec-desc" role="status">{t('正在读取 Channels…')}</p> : <div className="logical-channel-grid">
          <aside className="logical-channel-sidebar">
            <nav aria-label={t('Channels 列表')} className="logical-channel-list">
              {channels.map(channel => <button type="button" key={channel.id} className="logical-channel-choice"
                aria-current={selected?.id === channel.id ? 'page' : undefined} onClick={() => { setSelection(channel.id); setError(''); setNotice(''); }}>
                <span>{channel.name}</span><small>{t('{{count}} 个消息源', { count: channel.sources.length })}</small>
              </button>)}
            </nav>
            <AnimatedDetails className="s-adv" open={createOpen} onToggle={setCreateOpen} summary={<><Chevron />{t('新建 Channel')}</>}>
              <form className="logical-channel-form s-adv-body" onSubmit={event => { event.preventDefault(); if (newName.trim()) void perform(async () => {
                const created = await request<LogicalChannel>('create', { name: newName.trim() });
                setSelection(created.id); setNewName(''); setCreateOpen(false); setNotice(t('Channel 已创建。'));
              }); }}>
                <label>{t('Channel 名称')}<input value={newName} onChange={event => setNewName(event.target.value)} maxLength={120} required disabled={busy} /></label>
                <button type="submit" className="btn primary" disabled={busy || !newName.trim()}>{t('创建')}</button>
              </form>
            </AnimatedDetails>
          </aside>
          {selected ? <div className="logical-channel-detail" key={selected.id}>
            <SettingsSection title={selected.name} desc={t('全局 Channel · 各工作区按需绑定')}>
              <SettingsSubsection title={t('消息源')}>
                {!selected.sources.length && <p className="s-sec-desc">{t('添加消息源后，在需要使用它的工作区手机中绑定此 Channel。')}</p>}
                <div className="logical-channel-sources">
                  {selected.sources.map(grant => <div className="logical-channel-source" key={grant.sourceId}>
                    <div className="logical-channel-source-heading"><div><strong>{grant.source.label}</strong><p>{t(channelProviderLabel(grant.source.provider))} · {grant.source.connected ? t('已连接') : t('连接不可用')}</p>
                      {sourceOwner(grant.source) && <p>{t('来自 {{workspace}} 的已有连接', { workspace: sourceOwner(grant.source) })}</p>}
                      {workspaces && grant.source.legacyOwnerWorkspaceId && !workspaces.some(item => item.id === grant.source.legacyOwnerWorkspaceId) &&
                        <p>{t('此连接的原工作区未打开。请重新打开原工作区恢复连接，或连接新账号并替换此消息源。')}</p>}
                      {grant.source.threadId && <p>{t('独立线程：{{id}}', { id: grant.source.threadId })}</p>}</div>
                      <button type="button" className="btn tiny" disabled={busy} aria-label={t('移除消息源 {{name}}', { name: grant.source.label })}
                        onClick={() => void perform(async () => { await request('sources.remove', { channelId: selected.id, sourceId: grant.sourceId }); setNotice(t('已移除消息源，相关远程授权已撤销。')); })}>{t('移除')}</button>
                    </div>
                    <div className="logical-channel-source-controls">
                      <CustomSelect value={grant.permission} disabled={busy} menuEnabled={active} ariaLabel={t('{{name}} 的读写权限', { name: grant.source.label })}
                        options={[{ value: 'read', label: t('只读') }, { value: 'reply', label: t('读取和回复'), disabled: !grant.source.canSend }]}
                        onChange={permission => void perform(async () => { await request('sources.update', { channelId: selected.id, sourceId: grant.sourceId, permission }); })} />
                      <CustomSelect value={grant.notify ?? ''} disabled={busy} menuEnabled={active} ariaLabel={t('{{name}} 的通知方式', { name: grant.source.label })}
                        options={[{ value: '', label: t('跟随 Channel 通知') }, ...notifyOptions]}
                        onChange={notify => void perform(async () => { await request('sources.update', { channelId: selected.id, sourceId: grant.sourceId, notify: notify || null }); })} />
                    </div>
                  </div>)}
                </div>
                <AnimatedDetails className="s-adv" open={sourceOpen} onToggle={open => { setSourceOpen(open); if (open) void perform(async () => {}); }} summary={<><Chevron />{t('添加消息源')}</>}>
                  <form className="logical-channel-form s-adv-body" onSubmit={event => { event.preventDefault(); if (chosen) void perform(async () => {
                    await request('sources.add', { channelId: selected.id, sourceId: chosen.id, permission: chosen.canSend ? permission : 'read' });
                    setSourceOpen(false); setSourceId(''); setPermission('read'); setNotice(t('消息源已加入。远程输入需单独授权。'));
                  }); }}>
                    {available.length ? <>
                      <CustomSelect value={chosen?.id ?? ''} ariaLabel={t('选择消息源')} disabled={busy} menuEnabled={active && sourceOpen}
                        options={available.map(source => ({ value: source.id, label: `${t(channelProviderLabel(source.provider))} · ${source.label}`, description: [source.connected ? t('已连接') : t('连接不可用'), sourceOwner(source)].filter(Boolean).join(' · ') }))}
                        onChange={value => { setSourceId(value); setPermission('read'); }} />
                      <CustomSelect value={permission} ariaLabel={t('允许的操作')} disabled={busy} menuEnabled={active && sourceOpen}
                        options={[{ value: 'read', label: t('只读') }, { value: 'reply', label: t('读取和回复'), disabled: !chosen?.canSend }]}
                        onChange={value => setPermission(value as LogicalChannelPermission)} />
                      <button type="submit" className="btn primary" disabled={busy}>{t('加入 Channel')}</button>
                    </> : <p className="s-sec-desc">{t('暂无可添加的对话。连接账号后，先在目标聊天发一条消息，群聊请 @机器人。')}</p>}
                    <div className="logical-channel-actions"><button type="button" className="btn" disabled={busy} onClick={() => void perform(async () => {})}>{t('刷新来源')}</button>
                      <button type="button" className="btn" onClick={() => setPage('accounts')}>{t('连接新账号')}</button></div>
                  </form>
                </AnimatedDetails>
              </SettingsSubsection>
              <SettingsSubsection title={t('消息处理')}>
                <label className="logical-channel-setting"><span>{t('通知已绑定的工作区')}</span>
                  <CustomSelect value={selected.notify} disabled={busy} menuEnabled={active} ariaLabel={t('通知已绑定的工作区')} options={notifyOptions}
                    onChange={notify => void perform(async () => { await request('update', { channelId: selected.id, notify: notify as LogicalChannelNotify }); })} /></label>
                <p className="s-sec-desc">{t('远程指令只进入绑定会话，不会再触发一遍手机通知。')}</p>
              </SettingsSubsection>
              <SettingsSubsection title={t('使用位置')}>
                <div className="logical-channel-setting"><div>{t('手机 Channel App')}<p className="s-sec-desc">{t('进入工作区的手机 → Channel → 绑定 Channel。绑定后，该区调度 Agent 可以读取和处理消息。')}</p></div></div>
                <div className="logical-channel-setting"><div>{t('远程输入')}<p className="s-sec-desc">{selected.sources.some(source => source.remoteTarget) ? t('已开启全局远程输入') : t('未开启，需验证操作人')}</p></div>
                  {onOpenRemote && <button type="button" className="btn" onClick={onOpenRemote}>{t('配置远程输入')}</button>}</div>
              </SettingsSubsection>
              <AnimatedDetails className="s-adv" summary={<><Chevron />{t('Channel 设置')}</>}>
                <div className="logical-channel-form s-adv-body">
                  <form className="logical-channel-actions" onSubmit={event => { event.preventDefault(); if (rename.trim()) void perform(async () => { await request('update', { channelId: selected.id, name: rename.trim() }); }); }}>
                    <label>{t('Channel 名称')}<input value={rename} onChange={event => setRename(event.target.value)} maxLength={120} required disabled={busy} /></label>
                    <button type="submit" className="btn" disabled={busy || !rename.trim() || rename === selected.name}>{t('保存名称')}</button>
                  </form>
                  <AnimatedDetails className="s-adv" open={removeOpen} onToggle={setRemoveOpen} summary={<><Chevron />{t('移除 Channel')}</>}>
                    <div className="logical-channel-form s-adv-body"><p>{t('移除将影响所有已绑定工作区，并停止此 Channel 的收件与远程输入。已连接账号可继续用于其他 Channel。')}</p>
                      <button type="button" className="btn danger" disabled={busy} onClick={() => void perform(async () => { await request('remove', { channelId: selected.id }); setSelection(''); setRemoveOpen(false); })}>{t('确认移除 Channel')}</button></div>
                  </AnimatedDetails>
                </div>
              </AnimatedDetails>
            </SettingsSection>
          </div> : <div className="logical-channel-empty"><h3>{t('创建第一个 Channel')}</h3><p className="s-sec-desc">{t('例如“项目 A”，把相关群聊、私聊和邮件放在一起。')}</p></div>}
        </div>}
      </>}
    </div>}
    {error && <><ErrorTip message={t('Channel 操作失败：{{message}}', { message: error })} /><button type="button" className="btn tiny" disabled={busy} onClick={() => void perform(async () => {})}>{t('重试')}</button></>}
    <p className="logical-channel-notice" role="status" aria-live="polite">{notice}</p>
  </div>;
}
