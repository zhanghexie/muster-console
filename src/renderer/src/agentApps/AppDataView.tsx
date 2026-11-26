import { showTip } from '../tips';
import { ErrorTip } from '../components/ErrorTip';
import { randomUuid } from '../../../shared/randomUuid';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { t } from '../../../shared/i18n';
import type { AgentAppDefinition, AppCollection, AppCommand, AppConnection, AppField, AppRecord, AppValues, AppView } from '../../../shared/agentApps';
import { appRecordFieldText } from '../../../shared/appRecordPlaceholders';
import { appConnectionNameText } from '../../../shared/appConnectionName';
import type { PhoneRoute } from './presentation';
import { commandChangesRecord, commandPresentation, PhoneActionIcon } from './commandPresentation';
import { CustomSelect } from '../components/CustomSelect';
import { ImageAsset, ImageField } from './ImageAsset';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const display = (value: unknown) => value == null ? '' : typeof value === 'boolean' ? value ? t('是') : t('否') : String(value);
const isNew = (command: AppCommand) => ['records.create', 'rss.subscribe', 'reminders.set', 'messages.send'].includes(command.handler);
const isSync = (command: AppCommand) => command.handler.endsWith('.sync');
const displayTime = (value: unknown) => {
  const date = new Date(String(value ?? ''));
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : display(value);
};
function localTime(value: unknown): string {
  const date = new Date(String(value ?? '')); if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function AppFieldInput({ field, value, set, connections, invalid = false }: { field: AppField; value: unknown; set: (value: string | number | boolean | null) => void; connections: AppConnection[]; invalid?: boolean }) {
  const { t } = useTranslation();
  const props = { 'aria-label': field.label, required: field.required, id: `phone-field-${field.id}` };
  if (field.id === 'accountId' || field.type === 'select') {
    const options = field.id === 'accountId' ? connections.map(c => ({ value: c.id, label: appConnectionNameText(c) })) : (field.options ?? []).map(v => ({ value: v, label: v }));
    return <div className="ap-field"><label htmlFor={props.id}>{field.label}</label><CustomSelect id={props.id} ariaLabel={field.label} ariaInvalid={invalid} ariaDescribedBy={invalid ? `${props.id}-error` : undefined} className="ap-select" value={display(value)} onChange={set} options={[{ value: '', label: field.id === 'accountId' ? t('选择连接') : t('选择') }, ...options]}/>{invalid && <span id={`${props.id}-error`} className="sr-only">{t('请选择{{field}}', { field: field.label })}</span>}</div>;
  }
  if (field.type === 'boolean') return <label className="ap-check"><input {...props} type="checkbox" checked={value === true} onChange={e => set(e.target.checked)}/>{field.label}</label>;
  return <label className="ap-field">{field.label}{field.type === 'multiline' ? <textarea {...props} rows={5} value={display(value)} onChange={e => set(e.target.value)}/> : <input {...props} type={field.type === 'datetime' ? 'datetime-local' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'} value={field.type === 'datetime' ? localTime(value) : display(value)} onChange={e => set(field.type === 'datetime' ? e.target.value ? new Date(e.target.value).toISOString() : null : field.type === 'number' ? e.target.value === '' ? null : Number(e.target.value) : e.target.value)}/>}</label>;
}

function RecordForm({ workspaceId, appId, collection, command, record, connections, save, cancel, busy }: { workspaceId: string; appId: string; collection: AppCollection; command: AppCommand; record?: AppRecord; connections: AppConnection[]; save: (values: AppValues) => void; cancel: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<AppValues>(() => {
    const writable = Object.fromEntries(Object.entries(record?.values ?? {}).filter(([key]) => collection.fields.some(f => f.id === key && !f.readOnly)));
    if (command.handler === 'messages.send') return { body: '', accountId: record?.values.accountId ?? connections[0]?.id ?? '', ...(record?.values.messageId ? { replyTo: record.values.messageId } : {}) };
    if (!record && collection.fields.some(f => f.id === 'accountId')) writable.accountId = connections[0]?.id ?? '';
    return writable;
  });
  const [invalidField, setInvalidField] = useState<string>(), [pendingImages, setPendingImages] = useState<Set<string>>(() => new Set()), [cancelError, setCancelError] = useState('');
  const fields = collection.fields.filter(f => !f.readOnly && !(command.handler === 'reminders.set' && f.id === 'enabled') && (command.handler !== 'messages.send' || f.id === 'body'));
  return <form className="ap-form" onSubmit={e => {
    e.preventDefault();
    const missing = fields.find(f => f.required && (f.type === 'select' || f.type === 'image' || f.id === 'accountId') && !display(values[f.id]));
    if (missing) {
      setInvalidField(missing.id);
      showTip(t('请选择{{field}}', { field: missing.label }), { tone: 'error' });
      Array.from(e.currentTarget.querySelectorAll('button')).find(button => button.id === `phone-field-${missing.id}`)?.focus();
      return;
    }
    setInvalidField(undefined); save(values);
  }}>
    {record && <p className="ap-muted">{command.handler === 'messages.send' ? t('正在回复') : t('正在编辑')} · {display(appRecordFieldText(record, collection.titleField))}</p>}
    {fields.map(field => field.type === 'image' ? <ImageField key={field.id} workspaceId={workspaceId} appId={appId} id={field.id} label={field.label} value={values[field.id]} invalid={invalidField === field.id} setPending={pending => setPendingImages(old => { const next = new Set(old); if (pending) next.add(field.id); else next.delete(field.id); return next; })} set={value => { setValues(old => ({ ...old, [field.id]: value })); if (invalidField === field.id) setInvalidField(undefined); }}/> : <AppFieldInput key={field.id} field={command.handler === 'reminders.set' && field.id === 'dueAt' && values.dailyTime ? { ...field, required: false } : field} value={values[field.id]} connections={connections} invalid={invalidField === field.id} set={value => { setValues(old => { const next = { ...old, [field.id]: value }; if (command.handler === 'reminders.set' && ((field.id === 'dailyTime' && value && value !== old.dailyTime) || (field.id === 'weekdays' && value !== old.weekdays && old.dailyTime))) delete next.dueAt; return next; }); if (invalidField === field.id) setInvalidField(undefined); }}/>) }
    {cancelError && <ErrorTip message={cancelError} />}
    <div className="ap-form-actions"><button className="ap-primary" type="submit" disabled={busy || pendingImages.size > 0}><PhoneActionIcon name={command.handler === 'messages.send' ? 'send' : 'save'}/>{busy || pendingImages.size > 0 ? t('处理中…') : command.handler === 'messages.send' ? t('发送') : t('保存')}</button><button type="button" onClick={() => void (async () => { try { for (const field of fields.filter(item => item.type === 'image')) { const id = values[field.id]; if (typeof id === 'string' && id && id !== record?.values[field.id]) await window.api.agentApps.releaseImage(workspaceId, appId, id); } cancel(); } catch (error) { setCancelError(errorText(error)); } })()}><PhoneActionIcon name="close"/>{t('取消')}</button></div>
  </form>;
}

export function AppDataView({ workspaceId, app, view, route, navigate, connections, search, revision, scrollPositions, custom }: {
  workspaceId: string; app: AgentAppDefinition; view: AppView; route: PhoneRoute; navigate: (route: PhoneRoute) => void;
  connections: AppConnection[]; search: string; revision: number; scrollPositions: Map<string, number>;
  custom?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const collection = app.collections.find(c => c.id === view.collection)!;
  const [rows, setRows] = useState<AppRecord[]>([]), [record, setRecord] = useState<AppRecord>();
  const [total, setTotal] = useState(0), [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [account, setAccount] = useState('');
  const generation = useRef(0), alive = useRef(true), scroll = useRef<HTMLDivElement>(null);
  const commands = (view.commands ?? []).flatMap(id => app.commands.filter(c => c.id === id));
  const isReminder = commands.some(c => c.handler === 'reminders.cancel');
  const accounts = connections.filter(c => c.enabled && c.grants[app.id]?.length);
  const selectedAccount = route.accountId ?? (accounts.some(c => c.id === account) ? account : accounts[0]?.id ?? '');
  const editCommand = commands.find(c => c.id === route.editCommand);
  const listRoute = { appId: app.id, viewId: view.id, ...(route.accountId ? { accountId: route.accountId } : {}), ...(route.folder ? { folder: route.folder } : {}) };
  const key = `${app.id}:${view.id}:${route.accountId ?? ''}:${route.entityId ?? 'list'}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const load = useCallback(async () => {
    const version = ++generation.current; setLoading(true);
    try {
      const filter = { ...(route.accountId ? { accountId: route.accountId } : {}), ...(collection.purpose === 'mail' ? { folder: route.folder ?? 'inbox' } : {}) };
      const result = await window.api.agentApps.query(workspaceId, { appId: app.id, collection: collection.id, ...(route.entityId ? { id: route.entityId } : {}), filter, search, limit });
      if (version !== generation.current || !alive.current) return;
      setRows(result.records ?? []); setRecord(result.record); setTotal(result.total ?? 0); setError('');
    } catch (err) { if (version === generation.current && alive.current) setError(errorText(err)); }
    finally { if (version === generation.current && alive.current) setLoading(false); }
  }, [workspaceId, app.id, collection.id, collection.purpose, route.entityId, route.accountId, route.folder, search, limit]);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => { const node = scroll.current; if (node) node.scrollTop = scrollPositions.get(key) ?? 0; return () => { if (node) scrollPositions.set(key, node.scrollTop); }; }, [key, scrollPositions]);
  const run = async (command: AppCommand, values?: AppValues) => {
    if (busy) return; setBusy(true); setError('');
    try {
      const params: Record<string, unknown> = { ...(record ? { id: record.id, expectedRevision: record.revision } : {}), ...(values ? { values } : {}) };
      if (command.handler === 'messages.send') params.accountId = values?.accountId ?? selectedAccount;
      if (command.handler === 'mail.sync' || command.handler === 'messages.sync') params.accountId = selectedAccount;
      // A feed sync's id is a feed reference, never the currently viewed article.
      if (command.handler === 'rss.sync') delete params.id;
      const result = await window.api.agentApps.call(workspaceId, { appId: app.id, commandId: command.id, params, requestId: randomUuid() });
      if (!alive.current) return;
      if (command.handler === 'mail.reply') navigate({ ...listRoute, entityId: result.record?.id, editCommand: app.commands.find(c => c.handler === 'records.update' && !c.patch)?.id });
      else if (editCommand || result.removed) {
        navigate({ ...listRoute, ...(collection.purpose === 'mail' && result.record?.values.folder === 'drafts' ? { folder: 'drafts' } : {}) });
        if (editCommand && !route.entityId && !result.removed) await load();
      }
      else await load();
    } catch (err) { if (alive.current) setError(errorText(err)); }
    finally { if (alive.current) setBusy(false); }
  };
  const itemCommands = record ? commands.filter(c => {
    if (['records.list', 'records.get', 'records.create', 'rss.subscribe'].includes(c.handler) || isSync(c)) return false;
    if (!commandChangesRecord(c, record)) return false;
    if (collection.purpose === 'mail') {
      if (c.handler === 'mail.reply') return record.values.folder === 'inbox';
      if (c.handler === 'mail.send' || c.handler === 'records.update' && !c.patch) return record.values.folder === 'drafts' && record.values.status === 'draft';
    }
    return true;
  }) : [];
  const activate = (command: AppCommand) => {
    if (command.handler === 'records.update' && !command.patch || command.handler === 'reminders.set' || command.handler === 'messages.send' || isNew(command)) navigate({ ...route, editCommand: command.id });
    else void run(command);
  };
  return <>
    {collection.purpose === 'mail' && !record && !editCommand && <nav className="ap-pivot" aria-label={t('邮件文件夹')}>{[['inbox', '收件箱'], ['drafts', '草稿'], ['sent', '已发送']].map(([folder, title]) => <button key={folder} aria-pressed={(route.folder ?? 'inbox') === folder} onClick={() => navigate({ ...listRoute, folder })}>{t(title)}</button>)}</nav>}
    {error && <div className="ap-empty"><ErrorTip message={error} /><button onClick={() => void load()}>{t('重试读取')}</button></div>}
    <div className="ap-scroll" ref={scroll} aria-busy={loading || busy}>
      {editCommand && (!route.entityId || record) ? <RecordForm key={`${key}:${editCommand.id}`} workspaceId={workspaceId} appId={app.id} collection={collection} command={editCommand} record={record} connections={accounts.filter(c => !route.accountId || c.id === route.accountId)} save={values => void run(editCommand, values)} cancel={() => navigate({ ...route, editCommand: undefined })} busy={busy}/> : custom ? custom : view.kind === 'messages' && !route.accountId && !record ? <div className="ap-list">{accounts.map(connection => <button className="ap-record ap-flight" key={connection.id} onClick={() => navigate({ ...listRoute, accountId: connection.id })}><span><strong>{appConnectionNameText(connection)}</strong><small>{t('{{n}} 条未读', { n: rows.filter(r => r.values.accountId === connection.id && r.values.read === false).length })}</small></span></button>)}{!accounts.length && <p className="ap-empty">{t('还没有消息')}<small>{t('接入手机机器人后，私信和 @ 机器人的群会自动出现在这里')}</small><button onClick={() => navigate({ settings: true })}>{t('飞书接入设置')}</button></p>}</div> : view.kind === 'messages' && route.accountId && !record ? <div className="ap-thread">{[...rows].sort((a,b) => String(a.values.date ?? a.createdAt).localeCompare(String(b.values.date ?? b.createdAt))).map(row => <button className={`ap-message ap-flight${row.values.mine ? ' is-mine' : ''}`} key={row.id} onClick={() => navigate({ ...listRoute, entityId: row.id })}><small>{display(appRecordFieldText(row, 'sender')) || (row.values.mine ? t('我') : t('消息'))}</small><span>{display(appRecordFieldText(row, 'body'))}</span><small>{display(row.values.date)} · {row.values.status === 'uncertain' ? t('发送未确认') : row.values.status === 'sent' ? t('已发送') : row.values.read ? t('已读') : t('未读')}</small></button>)}{!rows.length && !loading && <p className="ap-empty">{t('还没有消息')}</p>}</div> : record ? <article className={`ap-detail ${view.kind === 'messages' ? 'ap-conversation' : ''}`}>
        <h3 className="ap-flight">{display(appRecordFieldText(record, collection.titleField)) || t('消息')}</h3>
        {isReminder && <><p className="ap-meta"><span>{t('状态')}</span>{record.values.enabled === false ? t('已停用') : t('已启用')}</p><p className="ap-meta"><span>{t('重复')}</span>{record.values.dailyTime ? record.values.weekdays ? t('每周 {{days}} · {{time}}', { days: record.values.weekdays, time: record.values.dailyTime }) : t('每天 {{time}}', { time: record.values.dailyTime }) : record.values.repeatMinutes ? t('每 {{n}} 分钟', { n: record.values.repeatMinutes }) : t('单次提醒')}</p></>}
        {collection.fields.filter(f => f.id !== collection.titleField && f.id !== collection.bodyField && !(isReminder && ['enabled', 'repeatMinutes', 'dailyTime', 'weekdays'].includes(f.id)) && !['uid', 'messageId', 'sourceId', 'externalId', ...(view.kind === 'messages' ? ['accountId', 'chatId', 'replyTo'] : [])].includes(f.id) && record.values[f.id] != null && record.values[f.id] !== '').map(field => field.type === 'image' ? <ImageAsset key={field.id} workspaceId={workspaceId} appId={app.id} assetId={String(record.values[field.id])} alt={display(appRecordFieldText(record, collection.titleField)) || field.label} className="ap-image-full"/> : <p className="ap-meta" key={field.id}><span>{field.label}</span>{field.type === 'url' && /^https?:\/\//i.test(String(record.values[field.id])) ? <a href={String(record.values[field.id])} onClick={e => { e.preventDefault(); void window.api.shell.openExternal(String(record.values[field.id])).then(result => { if (!result.ok) setError(result.error || t('无法打开链接')); }).catch(err => setError(errorText(err))); }}>{display(record.values[field.id])}</a> : field.type === 'datetime' ? displayTime(record.values[field.id]) : display(appRecordFieldText(record, field.id))}</p>)}
        {collection.bodyField && <p className={`ap-reading ap-flight${record.values.mine ? ' is-mine' : ''}`}>{display(appRecordFieldText(record, collection.bodyField))}</p>}
      </article> : <div className="ap-list">
        {!loading && !rows.length && <p className="ap-empty">{search ? t('没有匹配的内容') : t('这里还没有内容')}<small>{t('你的记录会保存在这里')}</small></p>}
        {loading && !rows.length && <p className="ap-muted">{t('正在读取…')}</p>}
        {rows.map((row, index) => <button key={row.id} className={`ap-record ap-flight${row.values.done ? ' is-done' : ''}${row.values.read === false ? ' is-unread' : ''}`} style={{ '--ap-i': Math.min(index, 6) } as React.CSSProperties} onClick={() => navigate({ ...listRoute, entityId: row.id })}>
          {view.kind === 'checklist' && <span className="ap-tick" aria-hidden>{row.values.done ? '✓' : ''}</span>}
          {collection.fields.filter(field => field.type === 'image' && typeof row.values[field.id] === 'string' && row.values[field.id]).slice(0, 1).map(field => <ImageAsset key={field.id} workspaceId={workspaceId} appId={app.id} assetId={String(row.values[field.id])} thumbnail alt="" className="ap-image-thumb"/>)}
          <span><strong>{display(appRecordFieldText(row, collection.titleField)) || (view.kind === 'messages' ? row.values.mine ? t('我') : t('消息') : t('无标题'))}</strong>{isReminder && <small>{displayTime(row.values.dueAt)} · {row.values.enabled === false ? t('已停用') : t('已启用')}</small>}<small>{display(appRecordFieldText(row, collection.subtitleField ?? '') || appRecordFieldText(row, collection.bodyField ?? '')).slice(0, 110)}</small>{row.values.status === 'uncertain' && <em>{t('发送结果未确认')}</em>}</span>
        </button>)}
        {rows.length < total && <button disabled={loading || limit >= 200} onClick={() => setLimit(value => Math.min(200, value + 50))}>{limit >= 200 ? t('请搜索查找更多内容') : t('加载更多')}</button>}
      </div>}
    </div>
    {!editCommand && <div className="ap-command-bar">
      {view.kind !== 'messages' && commands.some(c => ['mail.sync', 'messages.sync'].includes(c.handler)) && <CustomSelect className="ap-account-select" ariaLabel={t('当前连接')} value={selectedAccount} onChange={setAccount} options={[{ value: '', label: t('选择连接') }, ...accounts.map(c => ({ value: c.id, label: appConnectionNameText(c) }))]}/>}
      <div>{(record ? itemCommands : commands.filter(c => (isNew(c) || isSync(c)) && (view.kind !== 'messages' || !!route.accountId))).map(command => {
        const presentation = commandPresentation(command, record);
        return <button key={command.id} title={presentation.title} disabled={busy || (['mail.sync', 'messages.sync'].includes(command.handler) && !selectedAccount)} onClick={() => activate(command)}><PhoneActionIcon name={presentation.icon}/>{presentation.title}</button>;
      })}</div>
    </div>}
  </>;
}
