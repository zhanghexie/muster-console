import { ErrorTip, ErrorTipDetails } from '../components/ErrorTip';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isLegacyChannelApp, type AppConnection, type AppConnectionInput, type AppSnapshot } from '../../../shared/agentApps';
import { appConnectionNameText } from '../../../shared/appConnectionName';
import { localizeAppUserErrorText } from '../../../shared/appUserErrors';
import { builtInAgentApps } from '../../../shared/agentAppsBuiltins';
import { CustomSelect } from '../components/CustomSelect';
import { usePresence } from '../components/motion';
import { phoneAppName } from './appName';
import { PhoneActionIcon } from './commandPresentation';
import './phone.css';

export function PhoneLegacyChannelSources({ workspaceId, snapshot, refresh, active = true }: {
  workspaceId: string; snapshot: AppSnapshot; refresh(): void; active?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<AppConnectionInput>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const presence = usePresence(active && open);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    setOpen(false); setBusy(false); pending.current = false; setError(''); setNotice('');
    return () => { generation.current++; };
  }, [workspaceId, active]);
  const legacyApps = builtInAgentApps().filter(app => app.id === 'mail' || app.id === 'messages');
  const run = async (fn: () => Promise<unknown>, success: string, done?: () => void) => {
    if (!active || pending.current) return;
    const current = generation.current;
    pending.current = true;
    setBusy(true); setError(''); setNotice('');
    try { await fn(); if (current === generation.current) { done?.(); setNotice(success); refresh(); } }
    catch (error) { if (current === generation.current) setError(localizeAppUserErrorText(error instanceof Error ? error.message : String(error))); }
    finally { if (current === generation.current) { pending.current = false; setBusy(false); } }
  };
  const update = (key: string, value: unknown) => setEditing(old => {
    if (!old) return old;
    if (key === 'name') { const { namePlaceholder: _namePlaceholder, ...rest } = old; return { ...rest, [key]: value } as AppConnectionInput; }
    return { ...old, [key]: value } as AppConnectionInput;
  });
  const text = (key: string, label: string, type = 'text') => <label className="ap-field" key={key}>{label}<input aria-label={label} type={type} value={String((editing as unknown as Record<string, unknown>)[key] ?? '')} onChange={e => update(key, type === 'number' ? Number(e.target.value) : e.target.value)} autoComplete={type === 'password' ? 'new-password' : 'off'}/></label>;
  const connectionRow = (connection: AppConnection) => <section className="ap-connection" key={connection.id}>
    <strong>{appConnectionNameText(connection)}</strong>
    {connection.kind === 'imap-smtp' && <small>{connection.address}</small>}
    <small>{connection.enabled ? connection.lastSyncAt ? t('最近收取 {{time}}', { time: new Date(connection.lastSyncAt).toLocaleString() }) : t('等待新消息') : t('已停用')}</small>
    {connection.lastError && <ErrorTipDetails message={localizeAppUserErrorText(connection.lastError)} />}
    <div><button type="button" disabled={busy} aria-expanded={open && editing?.id === connection.id} onClick={() => { setError(''); setNotice(''); setEditing({ ...connection, expectedRevision: connection.revision }); setOpen(true); }}>{connection.kind === 'feishu' ? t('通知与权限') : t('编辑')}</button>
      {connection.kind === 'imap-smtp' && <button disabled={busy} onClick={() => void run(() => window.api.agentApps.testConnection(workspaceId, connection.id), t('连接测试通过'))}>{t('测试连接')}</button>}
      <button disabled={busy} onClick={() => void run(() => window.api.agentApps.saveConnection(workspaceId, { ...connection, expectedRevision: connection.revision, enabled: !connection.enabled }), connection.enabled ? t('已停用') : t('已启用'))}>{connection.enabled ? t('停用') : t('启用')}</button></div>
  </section>;
  return <section className="ap-settings ap-legacy-channels">
    <h3>{t('已有连接')}</h3>
    {error && <ErrorTip message={error} />}{notice && <p role="status">{notice}</p>}
    {snapshot.connections.map(connectionRow)}
    {editing && presence.mounted && <div className={`acc${presence.stage === 'in' ? ' is-open' : ''}`} {...presence.spread} {...(!open || !active ? { inert: '' } : {}) as object}><div className="acc-body"><form onSubmit={e => { e.preventDefault(); void run(() => window.api.agentApps.saveConnection(workspaceId, editing), t('设置已保存'), () => setOpen(false)); }}>
      {text('name', editing.kind === 'imap-smtp' ? t('连接名称') : t('对话名称'))}
      {editing.kind === 'imap-smtp' ? <>
        {text('address', t('邮箱地址'), 'email')}{text('user', t('登录用户名'))}{text('password', t('密码或应用专用密码'), 'password')}{text('smtpPassword', t('SMTP 密码（不同才填写）'), 'password')}
        <p className="ap-muted">{t('编辑已有连接时，密码留空会保留原密码。密码保存在系统凭据存储中。')}</p>
        {(['imap', 'smtp'] as const).map(protocol => <fieldset key={protocol}><legend>{protocol.toUpperCase()}</legend>{text(`${protocol}Host`, t('{{protocol}} 服务器', { protocol: protocol.toUpperCase() }))}{text(`${protocol}Port`, t('{{protocol}} 端口', { protocol: protocol.toUpperCase() }), 'number')}<div className="ap-field"><span>{t('加密')}</span><CustomSelect className="ap-select" ariaLabel={t('{{protocol}} 加密', { protocol: protocol.toUpperCase() })} value={editing[`${protocol}Tls`]} onChange={value => update(`${protocol}Tls`, value)} options={[{ value: 'tls', label: 'TLS' }, { value: 'starttls', label: 'STARTTLS' }]}/></div></fieldset>)}
        {text('mailbox', t('收信文件夹'))}
      </> : <p className="ap-muted">{t('此处只调整当前已有连接。')}</p>}
      <label className="ap-check"><input type="checkbox" checked={editing.enabled} onChange={e => update('enabled', e.target.checked)}/>{t('启用后台收取')}</label>
      <div className="ap-field"><span>{t('收到新内容时')}</span><CustomSelect className="ap-select" ariaLabel={t('新内容通知')} value={editing.notify ?? 'wake'} onChange={value => update('notify', value)} options={[{ value: 'wake', label: t('通知并唤醒 AI') }, { value: 'digest', label: t('保留通知，稍后处理') }, { value: 'mute', label: t('静默收取') }]}/></div>
      <label className="ap-field">{t('收到后怎么处理')}<textarea aria-label={t('收到后怎么处理')} maxLength={2000} value={editing.notificationHint ?? ''} placeholder={t('留空由 AI 按当前任务判断，需要你关注时再汇报')} onChange={e => update('notificationHint', e.target.value)}/></label>
      <h3>{t('允许哪些应用使用')}</h3><p className="ap-muted">{t('读取和发送分别授权。AI 可在已有授权范围内发送。')}</p>
      {[...legacyApps, ...snapshot.apps.filter(a => a.enabled && !isLegacyChannelApp(a.definition.id)).map(a => a.definition)].filter(a => a.permissions?.some(p => p.startsWith(editing.kind === 'imap-smtp' ? 'mail.' : 'messages.'))).map(a => <fieldset key={a.id}><legend>{legacyApps.includes(a) ? t('渠道') : phoneAppName(a)}</legend>{a.permissions!.filter(p => p.startsWith(editing.kind === 'imap-smtp' ? 'mail.' : 'messages.')).map(permission => <label className="ap-check" key={permission}><input type="checkbox" checked={editing.grants[a.id]?.includes(permission) ?? false} onChange={e => update('grants', { ...editing.grants, [a.id]: e.target.checked ? [...(editing.grants[a.id] ?? []), permission] : (editing.grants[a.id] ?? []).filter(p => p !== permission) })}/>{permission.endsWith('.read') ? t('读取') : t('发送')}</label>)}</fieldset>)}
      <div className="ap-form-actions"><button className="ap-primary" disabled={busy} type="submit"><PhoneActionIcon name="save"/>{t('保存')}</button><button type="button" onClick={() => setOpen(false)}><PhoneActionIcon name="close"/>{t('取消')}</button></div>
    </form></div></div>}
  </section>;
}
