import { ErrorTip } from '../ErrorTip';
import { SettingsResourceItem, SettingsResourceStatus, SettingsDetailSection } from './SettingsResource';
import { SettingsDetailHeader } from './SettingsDetailHeader';
import { SettingsPathControl, SettingsPathField } from './SettingsPathField';
import { SettingsTabs } from './SettingsViews';
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AppConfig, McpServerConfig } from '../../../../shared/types';
import { controlRootFor } from '../../../../shared/workspaceRoots';
import type {
  CapabilityScope, ManagedSkill, SkillDocument,
  SkillManagementSnapshot, SkillConsolidationPreview
} from '../../../../shared/capabilityManagement';
import type {
  ManagedMcpEntry, McpManagementInventory, McpConnectionTestResult
} from '../../../../shared/mcpManagement';
import { usePresence, usePresenceValue } from '../motion';
import { CustomSelect } from '../CustomSelect';
import { AdvancedDetails, SettingRow } from './shared';
import { CapabilityCatalog } from './CapabilityCatalog';
import { InboundMcpStatusView, useInboundMcpStatus } from './InboundMcpStatus';
import { CapabilityUsagePanel } from './CapabilityUsagePanel';
import { CapabilityManagementResourcePage } from './CapabilityManagementResourcePage';
import type { CapabilityCatalogInfo } from '../../../../shared/types';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { localizeSkillConsolidationError } from '../../panels/skillConsolidationDisplay';
import './capability-management.css';

type Page = 'skills' | 'mcp' | 'review' | 'catalog' | 'host';
type InventoryKind = 'skills' | 'mcp';
type Selection = { kind: 'skill' | 'mcp'; id: string } | null;
type DialogContent =
  | { kind: 'usage'; usageKind: 'skill' | 'mcp' }
  | { kind: 'skill-edit'; document: SkillDocument }
  | { kind: 'skill-new' }
  | { kind: 'compare'; preview: SkillConsolidationPreview }
  | { kind: 'mcp-edit'; entry?: ManagedMcpEntry }
  | { kind: 'mcp-import' }
  | { kind: 'mcp-remove'; entry: ManagedMcpEntry };
type Dialog = DialogContent & { context: {
  key: string; scope: CapabilityScope; mcpScope: 'global' | 'project'; workspaceId?: string;
  skills: SkillManagementSnapshot | null; mcp: McpManagementInventory | null;
} };


/** CustomSelect returns Tab to its trigger before this enclosing panel handles the boundary. */
function trapPanelTab(event: KeyboardEvent, node: HTMLElement | null): void {
  if (event.key !== 'Tab' || !node) return;
  const active = document.activeElement as HTMLElement | null;
  if (!node.contains(active)) return;
  const fields = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')).filter(field => {
    const folded = field.closest('details:not([open])');
    return !folded || !!field.closest('summary');
  });
  if (!fields.length) { event.preventDefault(); node.focus(); return; }
  if (event.shiftKey && active === fields[0]) {
    event.preventDefault(); fields[fields.length - 1].focus({ preventScroll: true });
  } else if (!event.shiftKey && active === fields[fields.length - 1]) {
    event.preventDefault(); fields[0].focus({ preventScroll: true });
  }
}

function SkillDiagnostics({ messages }: { messages: string[] }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  return <section className="cm-diagnostics">
    <button className="cm-text-button" aria-expanded={open} aria-controls="cm-skill-diagnostics" onClick={() => setOpen(value => !value)}><Icon name="alert" size={14}/>{t('{{n}} 条技能发现诊断', { n: messages.length })}</button>
    {presence.mounted && <div className={`acc${presence.stage === 'in' ? ' is-open' : ''}`} {...presence.spread} aria-hidden={!open || undefined} ref={node => { if (node) node.inert = !open; }} id="cm-skill-diagnostics"><div className="acc-body"><ul className="cm-diagnostics-list">{messages.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul></div></div>}
  </section>;
}

function Icon({ name, size = 18 }: { name: string; size?: number }): React.JSX.Element {
  const paths: Record<string, ReactNode> = {
    skill: <><path d="M8 4H5v16h14V4h-3M9 3h6v4H9z"/><path d="m9 12 2 2 4-4M9 17h6"/></>,
    mcp: <><path d="M8 3v5m8-5v5M5 8h14v4a7 7 0 0 1-7 7v3M8 12h8"/></>,
    folder: <path d="M3 6h6l2 2h10v12H3z"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    arrow: <path d="m9 5 7 7-7 7"/>,
    alert: <><path d="m12 3 10 18H2zM12 9v5M12 17h.01"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    file: <><path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6"/></>,
    edit: <path d="m14 4 6 6M4 20l5-1L21 7l-6-6L3 13z"/>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/></>,
    catalog: <><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><path d="M17 13v8M13 17h8"/></>,
    plug: <><path d="M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.file}</svg>;
}

/** Keep the complete dialog subtree during exit; dismissing it never clears an unsaved draft behind the animation. */
function ManagementDialog({ value, title, busy, error, onClose, children }: {
  value: Dialog | null; title: string; busy: boolean; error: string; onClose: () => void;
  children: (snapshot: Dialog) => ReactNode;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const frozen = usePresenceValue(value);
  const ref = useRef<HTMLDivElement>(null);
  useOverlayDismiss(!!value, () => { if (!busy) onClose(); });
  useEffect(() => {
    if (!value || !frozen.presence.mounted) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)')?.focus();
    const trap = (event: KeyboardEvent): void => trapPanelTab(event, node);
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [!!value, frozen.presence.mounted]);
  useEffect(() => { if (ref.current) ref.current.inert = frozen.presence.stage === 'out'; }, [frozen.presence.stage]);
  if (!frozen.presence.mounted || !frozen.value) return null;
  return createPortal(<div className="cm-modal-shade mp-scrim" {...frozen.presence.spread} data-overlay-root aria-hidden={frozen.presence.stage === 'out'} onMouseDown={e => { if (e.target === e.currentTarget && value && !busy) onClose(); }}>
    <div className="cm-modal mp-panel" {...frozen.presence.spread} ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <header className="cm-modal-head"><h2>{title}</h2><button type="button" className="cm-icon-button" aria-label={t('关闭')} disabled={busy} onClick={onClose}><Icon name="close"/></button></header>
      {error && <ErrorTip message={localizeSkillConsolidationError(error)} />}
      {children(frozen.value)}
    </div>
  </div>, document.body);
}

function SkillEditor({ document, busy, onCancel, onSave }: {
  document: SkillDocument; busy: boolean; onCancel: () => void; onSave: (body: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [body, setBody] = useState(document.body);
  return <form onSubmit={e => { e.preventDefault(); onSave(body); }}>
    <p className="cm-fine">{t('编辑原文件，使用同一源的入口都会读到修改。已有会话需要重新加载。')}</p>
    <SettingsPathControl label={t('技能文件')} path={document.filePath}/>
    <textarea className="cm-editor" aria-label={t('技能正文')} value={body} disabled={busy || document.readOnly} spellCheck={false} onChange={e => setBody(e.target.value)}/>
    <footer className="cm-modal-footer"><span>{t('保存前会检查原文件是否被外部修改。')}</span><button type="button" className="btn tiny cm-button" disabled={busy} onClick={onCancel}>{t('取消')}</button><button className="btn primary tiny cm-button cm-button-solid" disabled={busy || document.readOnly || !body.trim() || body === document.body}>{t('保存内容')}</button></footer>
  </form>;
}

function NewSkillForm({ scope, snapshot, busy, onCancel, onSave }: {
  scope: CapabilityScope; snapshot: SkillManagementSnapshot; busy: boolean; onCancel: () => void;
  onSave: (name: string, description: string, body: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const root = snapshot.directories.find(directory => directory.scope.kind === scope.kind);
  return <form className="cm-form" onSubmit={e => { e.preventDefault(); onSave(name.trim(), description.trim(), body); }}>
    <label>{t('技能名称')}<input aria-label={t('技能名称')} value={name} placeholder="release-notes" required disabled={busy} onChange={e => setName(e.target.value)}/></label>
    <label>{t('用途说明')}<input aria-label={t('用途说明')} value={description} disabled={busy} onChange={e => setDescription(e.target.value)}/></label>
    <label>{t('技能正文')}<textarea className="cm-editor" aria-label={t('技能正文')} value={body} disabled={busy} placeholder={t('写下这个技能的步骤和约定。')} onChange={e => setBody(e.target.value)}/></label>
    <div className="cm-source-summary"><strong>{t('通用技能目录')}</strong>{root ? <SettingsPathControl label={t('通用技能目录')} path={root.path} hideReveal={!root.exists}/> : <code>.agents/skills</code>}<p>{scope.kind === 'global' ? t('新技能保存在全局 .agents/skills，宿主内置技能由工作台私有加载。') : t('新技能保存在当前项目的 .agents/skills。')}</p></div>
    <footer className="cm-modal-footer"><button type="button" className="btn tiny cm-button" disabled={busy} onClick={onCancel}>{t('取消')}</button><button className="btn primary tiny cm-button cm-button-solid" disabled={busy || !name.trim()}>{t('创建技能')}</button></footer>
  </form>;
}

function SkillComparison({ initial, scope, revision, active, busy, onCancel, onSave }: {
  initial: SkillConsolidationPreview; scope: CapabilityScope; revision: number; active: boolean; busy: boolean;
  onCancel: () => void; onSave: (preview: SkillConsolidationPreview) => Promise<boolean>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [choice, setChoice] = useState('');
  const [preview, setPreview] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    setConfirmed(false);
    if (!active || !choice) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError('');
    void window.api.capabilityManagement.previewSkillConsolidation(scope, initial.name, choice).then(next => {
      if (!cancelled && request === generation.current) setPreview(next);
    }).catch(reason => {
      if (!cancelled && request === generation.current) setError(String(reason instanceof Error ? reason.message : reason));
    }).finally(() => { if (!cancelled && request === generation.current) setLoading(false); });
    return () => { cancelled = true; generation.current++; };
  }, [active, choice, scope, initial.name, revision, retry]);
  const selected = preview.candidates.find(candidate => candidate.skill.id === choice);
  const ready = active && !loading && !error && !!choice && preview.selectedId === choice && !!selected && !selected.skill.hostOwned;
  return <form className="cm-consolidation" onSubmit={event => { event.preventDefault(); if (ready && confirmed && !busy) { const request = generation.current; setConfirmed(false); void onSave(preview).then(ok => { if (!ok && request === generation.current) setPreview(value => ({ ...value, selectedId: undefined })); }); } }}>
    <p className="cm-fine">{t('选择一份保留其内容与资源。归并到统一技能源后，列出的旧目录将删除并改为入口链接。执行前会保存备份。')}</p>
    <div className="cm-comparison">{preview.candidates.map(({ skill, document }) => <div className={`cm-compare-card ${choice === skill.id ? 'is-selected' : ''}`} key={skill.id} onClick={event => {
      if (busy || skill.hostOwned || (event.target as HTMLElement).closest('button, input, label')) return;
      setChoice(skill.id); setConfirmed(false);
    }}>
      <label><input type="radio" name="retained-skill" aria-label={`${t('保留来源')} ${document.filePath}`} checked={choice === skill.id} disabled={busy || skill.hostOwned} onChange={() => { setChoice(skill.id); setConfirmed(false); }}/><strong>{t('保留这份内容')}</strong></label>
      <SettingsPathControl label={t('技能文件')} path={document.filePath}/>
      {(document.readOnly || skill.inherited) && !skill.hostOwned && <p className="cm-fine">{t('只读来源可以保留，不能在此编辑。')}</p>}
      {skill.hostOwned && <p className="cm-fine">{t('宿主维护的技能不能归并或删除。')}</p>}
      <pre>{document.body}</pre>
    </div>)}</div>
    {loading && <p className="cm-fine" role="status">{t('正在核对归并预览…')}</p>}
    {error && <ErrorTip message={localizeSkillConsolidationError(error)} />}
    {ready && <section className="cm-consolidation-plan" aria-label={t('归并变更预览')}>
      <div className="cm-source-summary"><strong>{t('保留到统一目录')}</strong><SettingsPathControl label={t('保留到统一目录')} path={preview.destination}/></div>
      <h3>{t('将删除的原目录')}</h3>
      {preview.removePaths.length ? <ul>{preview.removePaths.map(path => <li key={path}><SettingsPathControl label={t('将删除的原目录')} path={path}/></li>)}</ul> : <p className="cm-fine">{t('无需删除原目录。')}</p>}
      <h3>{t('将建立的入口链接')}</h3>
      {preview.linkPaths.length ? <ul>{preview.linkPaths.map(path => <li key={path}><SettingsPathControl label={t('将建立的入口链接')} path={path}/></li>)}</ul> : <p className="cm-fine">{t('无需新增链接。')}</p>}
      <label className="settings-check cm-delete-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/><span>{preview.removePaths.length ? t('我确认删除列出的原目录，保留所选内容并建立链接。') : t('我确认将所选内容归并到统一目录。')}</span></label>
    </section>}
    <footer className="cm-modal-footer"><button type="button" className="btn tiny cm-button" disabled={busy} onClick={onCancel}>{t('取消')}</button>{choice && <button type="button" className="btn tiny cm-button" disabled={busy || loading} onClick={() => setRetry(value => value + 1)}>{t('重新预览')}</button>}<button className="btn primary tiny cm-button cm-button-solid" disabled={busy || !ready || !confirmed}>{preview.removePaths.length ? t('确认归并并删除') : t('确认归并')}</button></footer>
  </form>;
}

type SecretRow = { key: string; value: string; retained: boolean; remove: boolean };
function secretRows(value?: Record<string, string>): SecretRow[] {
  return Object.entries(value ?? {}).map(([key, secret]) => ({ key, value: secret === '***' ? '' : secret, retained: secret === '***', remove: false }));
}
function secretValues(rows: SecretRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter(row => row.key.trim() && !row.remove).map(row => [row.key.trim(), row.retained && !row.value ? '***' : row.value]));
}
function SecretFields({ label, rows, busy, onChange }: { label: string; rows: SecretRow[]; busy: boolean; onChange: (rows: SecretRow[]) => void }): React.JSX.Element {
  const { t } = useTranslation();
  return <section className="cm-secret-fields"><h3>{label}</h3>{rows.map((row, i) => <div className="cm-secret-row" key={i}>
    <input aria-label={`${label} ${t('名称')} ${i + 1}`} placeholder={t('名称')} value={row.key} disabled={busy || row.retained} onChange={e => onChange(rows.map((r, n) => n === i ? { ...r, key: e.target.value } : r))}/>
    <input type="password" autoComplete="new-password" aria-label={`${label} ${t('值')} ${i + 1}`} placeholder={row.retained ? t('留空保留现有值') : t('值')} value={row.value} disabled={busy || row.remove} onChange={e => onChange(rows.map((r, n) => n === i ? { ...r, value: e.target.value } : r))}/>
    {row.retained ? <label className="cm-plain-option"><input type="checkbox" aria-label={`${t('移除')} ${row.key}`} checked={row.remove} disabled={busy} onChange={e => onChange(rows.map((r, n) => n === i ? { ...r, remove: e.target.checked } : r))}/>{t('移除')}</label> : <button type="button" className="cm-icon-button" aria-label={`${t('移除')} ${label} ${i + 1}`} disabled={busy} onClick={() => onChange(rows.filter((_, n) => n !== i))}><Icon name="close"/></button>}
  </div>)}<button type="button" className="cm-text-button" disabled={busy} onClick={() => onChange([...rows, { key: '', value: '', retained: false, remove: false }])}><Icon name="plus" size={14}/>{t('添加一项')}</button></section>;
}

function McpEditor({ entry, busy, onCancel, onSave }: {
  entry?: ManagedMcpEntry; busy: boolean; onCancel: () => void;
  onSave: (server: McpServerConfig) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(entry?.server.name ?? '');
  const [enabled, setEnabled] = useState(entry?.server.enabled ?? true);
  const [transport, setTransport] = useState(entry?.server.transport ?? 'stdio');
  const [command, setCommand] = useState(entry?.server.command ?? '');
  const [args, setArgs] = useState((entry?.server.args ?? []).join('\n'));
  const [cwd, setCwd] = useState(entry?.server.cwd ?? '');
  const [url, setUrl] = useState(entry?.server.url ?? '');
  const [env, setEnv] = useState(() => secretRows(entry?.server.env));
  const [headers, setHeaders] = useState(() => secretRows(entry?.server.headers));
  const submit = (): void => onSave({
    name: name.trim(), enabled, transport,
    ...(transport === 'stdio' ? { command: command.trim(), args: args.split('\n').filter(Boolean), cwd: cwd.trim() || undefined, env: secretValues(env) }
      : { url: url.trim(), headers: secretValues(headers) })
  });
  return <form className="cm-form" onSubmit={e => { e.preventDefault(); if (!busy) submit(); }}>
    <div className="cm-form-grid"><label>{t('服务器名称')}<input aria-label={t('服务器名称')} required value={name} disabled={busy} onChange={e => setName(e.target.value)}/></label><label>{t('连接方式')}<CustomSelect ariaLabel={t('连接方式')} value={transport} disabled={busy} className="cm-select cm-form-select" onChange={value => setTransport(value as 'stdio' | 'http')} options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'Streamable HTTP' }]}/></label></div>
    <label className="cm-plain-option"><input type="checkbox" aria-label={t('启用此服务器')} checked={enabled} disabled={busy} onChange={e => setEnabled(e.target.checked)}/>{t('启用此服务器')}</label>
    {transport === 'stdio' ? <>
      <label>{t('启动命令')}<input aria-label={t('启动命令')} required value={command} disabled={busy} placeholder="npx" onChange={e => setCommand(e.target.value)}/></label>
      <label>{t('启动参数（每行一项）')}<textarea aria-label={t('启动参数（每行一项）')} value={args} disabled={busy} rows={3} spellCheck={false} onChange={e => setArgs(e.target.value)}/></label>
      <SettingsPathField label={t('工作目录')} path={cwd} disabled={busy} onChange={setCwd}/>
      <SecretFields label={t('环境变量')} rows={env} busy={busy} onChange={setEnv}/>
    </> : <>
      <label>{t('服务地址')}<input aria-label={t('服务地址')} type="url" required value={url} disabled={busy} placeholder="https://example.com/mcp" onChange={e => setUrl(e.target.value)}/></label>
      <SecretFields label={t('HTTP 请求头')} rows={headers} busy={busy} onChange={setHeaders}/>
    </>}
    <p className="cm-fine">{t('凭据仅以隐藏值展示。留空保留已有值，勾选移除才会删除。')}{t('通过宿主中转（mcp.search / mcp.call）供各会话调用。')}</p>
    <footer className="cm-modal-footer"><button type="button" className="btn tiny cm-button" disabled={busy} onClick={onCancel}>{t('取消')}</button><button className="btn primary tiny cm-button cm-button-solid" disabled={busy || !name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())}>{t('保存服务器')}</button></footer>
  </form>;
}

function ImportMcpForm({ busy, onCancel, onImport }: { busy: boolean; onCancel: () => void; onImport: (json: string) => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [json, setJson] = useState('');
  return <form onSubmit={e => { e.preventDefault(); onImport(json); }}><p className="cm-fine">{t('粘贴包含 mcpServers 的 JSON 或服务器数组。已有同名配置不会被静默覆盖。')}</p><textarea className="cm-editor" aria-label={t('MCP JSON')} value={json} disabled={busy} spellCheck={false} placeholder={'{ "mcpServers": { "my-server": { "command": "npx", "args": [] } } }'} onChange={e => setJson(e.target.value)}/><footer className="cm-modal-footer"><button type="button" className="btn tiny cm-button" disabled={busy} onClick={onCancel}>{t('取消')}</button><button className="btn primary tiny cm-button cm-button-solid" disabled={busy || !json.trim()}>{t('导入配置')}</button></footer></form>;
}

function SkillDetail({ skill, busy, onGlobal, onEdit, onCompare }: {
  skill: ManagedSkill; busy: boolean; onGlobal: () => void;
  onEdit: () => void; onCompare: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const invalid = skill.status !== 'valid';
  return <>
    <SettingsDetailHeader title={skill.name} icon={<Icon name="skill" size={24}/>} description={skill.description}
      meta={<><ScopeNote inherited={skill.inherited} global={skill.scope.kind === 'global'} onGlobal={onGlobal}/>{skill.hostOwned && <span className="cm-badge">{t('宿主维护 · 只读')}</span>}</>}
      actions={<button className="btn tiny cm-button" disabled={busy || skill.inherited || skill.hostOwned || invalid} onClick={onEdit}><Icon name="edit" size={15}/>{t('编辑 SKILL.md')}</button>}/>
    <SettingsDetailSection title={t('基本信息')} desc={skill.hostOwned ? t('宿主用法文档只读，由应用安装和升级维护。') : undefined}>
      <SettingsPathField label={t('技能目录')} path={skill.directoryPath}/>
    </SettingsDetailSection>
    {invalid && <ErrorTip message={skill.error || t('技能来源无效，修复后刷新清单。')} />}
    <AdvancedDetails summary={t('内容来源')}><SettingsPathControl label={t('技能文件')} path={skill.filePath}/><div className="cm-source-list">{skill.sources.map(source => <div key={`${source.directoryId}-${source.path}`}><strong>{source.label}</strong><SettingsPathControl label={source.label} path={source.path}/>{source.managed && <small>{t('通用目录来源')}</small>}</div>)}</div><div className="cm-file-list">{skill.files.map(file => <span key={file}><Icon name="file" size={14}/>{file}</span>)}</div></AdvancedDetails>
    {skill.conflictGroup && <div className="cm-warning"><Icon name="alert"/><div><strong>{t('发现同名的另一份内容')}</strong><p>{t('比较内容后保留一份，归并并删除其他来源。')}</p><button className="cm-text-button" disabled={busy} onClick={onCompare}>{t('查看内容差异')}<Icon name="arrow" size={12}/></button></div></div>}
    {!skill.conflictGroup && !skill.hostOwned && !invalid && <div className="cm-detail-section"><button className="btn tiny cm-button" disabled={busy} onClick={onCompare}>{t('归并到统一目录')}</button></div>}
  </>;
}

function ScopeNote({ inherited, global, onGlobal }: { inherited: boolean; global: boolean; onGlobal: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  return <div className={`cm-scope-note ${inherited ? 'is-inherited' : ''}`} title={inherited ? t('此处只读，关联设置由全局决定。') : global ? t('适用于所有项目中的已关联入口。') : t('仅在这个项目的已关联入口中使用。')}><Icon name={global ? 'globe' : 'folder'} size={16}/><strong>{inherited ? t('来自全局') : global ? t('全局使用') : t('仅当前项目')}</strong>{inherited && <button className="cm-text-button" onClick={onGlobal}>{t('在全局管理')}<Icon name="arrow" size={12}/></button>}</div>;
}

function ConnectionStatus({ result }: { result?: McpConnectionTestResult }): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!result) return null;
  // 状态标签与总开关一致：relay-disabled = 中转未启用（握手未执行）；ok = 直连握手成功
  // （验证 server 配置），不宣称「中转可达」。
  return <div className={`cm-connection ${result.ok ? 'is-ok' : 'is-error'}`} role="status"><strong>{result.ok ? t('握手成功') : result.status === 'auth-required' ? t('需要认证') : result.status === 'relay-disabled' ? t('中转未启用') : t('连接测试失败')}</strong>{!result.ok && <p role="alert">{result.message}</p>}<span>{new Date(result.checkedAt).toLocaleString()} · {result.durationMs} ms · {result.tools.length} {t('个工具')}</span>{result.tools.length > 0 && <AdvancedDetails summary={t('查看发现的工具')}><ul>{result.tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong><span>{tool.description}</span></li>)}</ul></AdvancedDetails>}</div>;
}

function McpDetail({ entry, busy, onGlobal, onEdit, onRemove, onTest }: {
  entry: ManagedMcpEntry; busy: boolean;
  onGlobal: () => void; onEdit: () => void; onRemove: () => void; onTest: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <>
    <SettingsDetailHeader title={entry.server.name} icon={<Icon name="mcp" size={24}/>}
      description={entry.server.transport === 'http' ? 'Streamable HTTP' : 'stdio'}
      meta={<><ScopeNote inherited={!!entry.inherited} global={entry.scope === 'global'} onGlobal={onGlobal}/><SettingsResourceStatus state={entry.server.enabled ? 'success' : 'neutral'}>{entry.server.enabled ? t('已启用') : t('已停用')}</SettingsResourceStatus></>}
      actions={<button className="btn tiny cm-button" disabled={busy || entry.inherited} onClick={onEdit}>{t('编辑配置')}</button>}/>
    <SettingsDetailSection title={t('连接信息')} actions={<button className="btn tiny cm-button" disabled={busy} onClick={onTest}><Icon name="refresh" size={15}/>{busy ? t('处理中…') : t('连接测试')}</button>}>
      <ConnectionStatus result={entry.test}/>
    {entry.overridden && <p className="cm-fine">{t('此全局配置已被项目中的同名服务器覆盖。')}</p>}
    <AdvancedDetails summary={t('连接配置')}><pre className="cm-config">{JSON.stringify(entry.server, null, 2)}</pre></AdvancedDetails>
    </SettingsDetailSection>
    {!entry.inherited && <SettingRow divided title={<span className="cm-danger">{t('删除服务器')}</span>} desc={t('删除后服务器不再进入宿主中转清单；各引擎的原生配置文件不会被修改。')}><button className="btn danger tiny" aria-label={t('删除服务器')} disabled={busy} onClick={onRemove}>{t('删除')}</button></SettingRow>}
  </>;
}

/** The settings pane owns only domain resources. It never adds a utility-panel entry or joins the AppConfig draft save bar. */
export function CapabilityManagementPane({ cfg, focusItem, active = true }: { cfg: AppConfig; focusItem?: string; active?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState<Page>('skills');
  const hostSetup = useInboundMcpStatus(active);
  const hostPresence = usePresence(page === 'host');
  const hostFailures = hostSetup.status?.engines.filter(engine => engine.state === 'error').length ?? 0;
  const hostAttention = hostFailures || (hostSetup.status?.ok === false ? 1 : 0);
  const hostLabel = t('宿主接入') + (hostAttention ? ` · ${hostAttention} ${t('异常')}` : '');
  const pageRef = useRef(page); pageRef.current = page;
  const [scopeKind, setScopeKind] = useState<'global' | 'project'>(cfg.activeWorkspaceId ? 'project' : 'global');
  const [workspaceId, setWorkspaceId] = useState(cfg.activeWorkspaceId ?? cfg.workspaces?.[0]?.id ?? '');
  const [skills, setSkills] = useState<SkillManagementSnapshot | null>(null);
  const [mcp, setMcp] = useState<McpManagementInventory | null>(null);
  const [pendingMcpEnabled, setPendingMcpEnabled] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [globalExpanded, setGlobalExpanded] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [narrow, setNarrow] = useState(false);
  const workspaces = (cfg.workspaces ?? []).filter(item => !item.rootsError);
  const workspace = workspaces.find(item => item.id === workspaceId);
  const actualKind = workspace ? scopeKind : 'global';
  const projectPath = workspace ? controlRootFor(workspace) : undefined;
  const scope: CapabilityScope = actualKind === 'project' && projectPath ? { kind: 'project', projectPath } : { kind: 'global' };
  const scopeKey = actualKind === 'project' ? `project:${projectPath}` : 'global';
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const sequence = useRef(0);
  const requestGeneration = useRef({ skills: 0, mcp: 0 });
  const activeRef = useRef(active);
  activeRef.current = active;
  const pendingKinds = useRef(new Set<InventoryKind>());
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoaded = useRef(false);
  const mounted = useRef(true);
  const working = useRef(false);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const pendingDetailFocus = useRef<HTMLElement | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  useEffect(() => { if (paneRef.current) paneRef.current.scrollTop = 0; }, [page]);
  const inventoryRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const globalSelection = useRef<Selection>(null);
  useEffect(() => {
    const node = paneRef.current;
    if (!node) return;
    const measure = (): void => { const width = node.getBoundingClientRect().width; if (width > 0) setNarrow(width <= 620); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const refresh = useCallback(async (kinds: InventoryKind[] = ['skills', 'mcp'], showLoading = true): Promise<void> => {
    const scopeVersion = sequence.current;
    const requestedPage = pageRef.current;
    const key = scopeKey;
    const wantsSkills = kinds.includes('skills'), wantsMcp = kinds.includes('mcp');
    const request = {
      skills: wantsSkills ? ++requestGeneration.current.skills : 0,
      mcp: wantsMcp ? ++requestGeneration.current.mcp : 0
    };
    const requestedScope = actualKind === 'project' && projectPath ? { kind: 'project' as const, projectPath } : { kind: 'global' as const };
    if (showLoading) setLoading(true);
    const results = await Promise.allSettled([
      wantsSkills ? window.api.capabilityManagement.skillsList(requestedScope) : Promise.resolve(undefined),
      wantsMcp ? window.api.capabilityManagement.mcpList(actualKind === 'project' ? workspaceId : undefined) : Promise.resolve(undefined)
    ]);
    if (!mounted.current || scopeVersion !== sequence.current || scopeRef.current !== key) return;
    const failures: string[] = [];
    if (wantsSkills && request.skills === requestGeneration.current.skills) {
      if (results[0].status === 'fulfilled' && results[0].value) {
        setSkills(results[0].value);
        if (requestedScope.kind === 'global' && globalSelection.current) { setSelection(globalSelection.current); globalSelection.current = null; }
      } else failures.push(String(results[0].status === 'rejected' ? results[0].reason : t('技能清单返回无效数据')));
    }
    if (wantsMcp && request.mcp === requestGeneration.current.mcp) {
      if (results[1].status === 'fulfilled' && results[1].value) setMcp(results[1].value);
      else failures.push(String(results[1].status === 'rejected' ? results[1].reason : t('MCP 清单返回无效数据')));
    }
    if (failures.length && requestedPage === pageRef.current) setError(failures.join('\n'));
    if (showLoading) { initialLoaded.current = true; setLoading(false); }
  }, [scopeKey, workspaceId, t]);
  const flushPending = useCallback((): void => {
    pendingTimer.current = null;
    if (!activeRef.current || !pendingKinds.current.size) return;
    const kinds = [...pendingKinds.current];
    pendingKinds.current.clear();
    void refresh(kinds, !initialLoaded.current);
  }, [refresh]);
  useEffect(() => {
    if (!workspace && workspaces.length) setWorkspaceId(workspaces[0].id);
  }, [workspaceId, workspaces.map(item => item.id).join('\n')]);
  useEffect(() => {
    mounted.current = true;
    sequence.current++;
    initialLoaded.current = false;
    pendingDetailFocus.current = null;
    pendingKinds.current = new Set<InventoryKind>(['skills', 'mcp']);
    setSkills(null); setMcp(null); setSelection(null); setDialog(null); setError(''); setNotice('');
    flushPending();
    const off = window.api.on('capabilityManagement:changed', event => {
      if (event?.kind === 'skills' || event?.kind === 'mcp') pendingKinds.current.add(event.kind);
      else { pendingKinds.current.add('skills'); pendingKinds.current.add('mcp'); }
      if (activeRef.current && pendingTimer.current === null) pendingTimer.current = setTimeout(flushPending, 0);
    });
    const refreshAvailability = (): void => {
      pendingKinds.current.add('skills'); pendingKinds.current.add('mcp');
      if (activeRef.current && pendingTimer.current === null) pendingTimer.current = setTimeout(flushPending, 0);
    };
    const offRuntimes = window.api.on('runtimes:changed', refreshAvailability);
    const offAvailability = window.api.on('runtimes:availabilityChanged', refreshAvailability);
    window.addEventListener('focus', refreshAvailability);
    return () => {
      mounted.current = false; sequence.current++; off(); offRuntimes(); offAvailability();
      window.removeEventListener('focus', refreshAvailability);
      if (pendingTimer.current !== null) clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    };
  }, [refresh, flushPending]);
  useEffect(() => {
    if (active && initialLoaded.current) { pendingKinds.current.add('skills'); pendingKinds.current.add('mcp'); }
    if (active && pendingKinds.current.size && pendingTimer.current === null) pendingTimer.current = setTimeout(flushPending, 0);
    else if (!active && pendingTimer.current !== null) { clearTimeout(pendingTimer.current); pendingTimer.current = null; }
  }, [active, flushPending]);
  useEffect(() => {
    if (focusItem === 'cap-catalog') setPage('catalog');
    if (focusItem === 'inbound-mcp') { setPage('host'); setSelection(null); }
    if (focusItem === 'mcp-enabled' || focusItem === 'mcp-servers') { setPage('mcp'); setSelection(null); }
  }, [focusItem]);
  const perform = async (action: () => Promise<void>, message?: string): Promise<boolean> => {
    if (working.current) return false;
    working.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); if (mounted.current && scopeRef.current === scopeKey && message) setNotice(message); return true; }
    catch (e) { if (mounted.current && scopeRef.current === scopeKey) setError(String(e instanceof Error ? e.message : e)); return false; }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const applySkills = (snapshot: SkillManagementSnapshot, key = scopeKey): boolean => {
    if (!mounted.current || scopeRef.current !== key) return false;
    requestGeneration.current.skills++;
    setSkills(snapshot); return true;
  };
  const openDialog = (content: DialogContent): void => setDialog({ ...content, context: {
    key: scopeKey, scope, mcpScope: actualKind, workspaceId: actualKind === 'project' ? workspaceId : undefined, skills, mcp
  } });
  const closeDialog = (): void => { if (!working.current) { setDialog(null); setError(''); } };
  const closeDetail = (): void => {
    setSelection(null);
    const trigger = lastTrigger.current;
    if (inventoryRef.current?.inert) pendingDetailFocus.current = trigger;
    else { pendingDetailFocus.current = null; if (trigger?.isConnected) trigger.focus({ preventScroll: true }); }
  };
  useOverlayDismiss(active && !!selection, () => { if (!working.current && !dialog) closeDetail(); });
  const choose = (next: Selection, trigger: HTMLElement): void => { pendingDetailFocus.current = null; lastTrigger.current = trigger; setSelection(next); };
  const [capView, setCapView] = useState<CapabilityCatalogInfo | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogGeneration = useRef(0);
  const refreshCatalog = useCallback(async (): Promise<void> => {
    const generation = ++catalogGeneration.current;
    setCatalogLoading(true); setCatalogError('');
    try {
      const next = await window.api.catalog.get();
      if (!next?.tools) throw new Error(t('能力目录返回无效数据'));
      if (mounted.current && generation === catalogGeneration.current) setCapView(next);
    } catch (error) { if (mounted.current && generation === catalogGeneration.current) setCatalogError(String(error instanceof Error ? error.message : error)); }
    finally { if (mounted.current && generation === catalogGeneration.current) setCatalogLoading(false); }
  }, [t]);
  useEffect(() => {
    setCapView(null); setCatalogError('');
    if (page === 'catalog' && active) void refreshCatalog();
    return () => { catalogGeneration.current++; };
  }, [page, active, refreshCatalog, cfg.activeWorkspaceId]);
  const isResourcePage = page === 'skills' || page === 'mcp' || page === 'review';
  const changePage = (next: Page): void => { setPage(next); setSelection(null); setQuery(''); setGlobalExpanded(false); setError(''); setNotice(''); };
  const selectedSkill = selection?.kind === 'skill' ? skills?.skills.find(item => item.id === selection.id) : undefined;
  const selectedMcp = selection?.kind === 'mcp' ? mcp?.servers.find(item => item.id === selection.id) : undefined;
  const detailValue = selectedSkill && skills ? { kind: 'skill' as const, skill: selectedSkill, key: `${scopeKey}-${selectedSkill.id}` } : selectedMcp && mcp ? { kind: 'mcp' as const, entry: selectedMcp, key: `${scopeKey}-${selectedMcp.id}` } : null;
  const detail = usePresenceValue(detailValue);
  useEffect(() => { if (detailRef.current) detailRef.current.inert = detail.presence.stage === 'out'; }, [detail.presence.stage]);
  useEffect(() => {
    if (!selection || !detail.presence.mounted) return;
    const node = detailRef.current;
    if (node) node.scrollTop = 0;
  }, [selection?.id, scopeKey, detail.presence.mounted]);
  useEffect(() => {
    if (active && narrow && selection && detail.presence.mounted) detailRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [active, narrow, selection?.id, scopeKey, detail.presence.mounted]);
  useEffect(() => {
    if (inventoryRef.current) inventoryRef.current.inert = narrow && detail.presence.mounted;
    if (!detail.presence.mounted && pendingDetailFocus.current) {
      const trigger = pendingDetailFocus.current;
      pendingDetailFocus.current = null;
      // Chromium rejects focus inside inert. Restore only after exit has released the list.
      if (active && trigger.isConnected) trigger.focus({ preventScroll: true });
    }
  }, [active, narrow, detail.presence.mounted]);
  useEffect(() => {
    if (!active || !narrow || !selection || dialog) return;
    const trap = (event: KeyboardEvent): void => trapPanelTab(event, detailRef.current);
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [active, narrow, !!selection, !!dialog]);
  const dialogPresence = usePresenceValue(dialog);
  const dialogTitle: Record<Dialog['kind'], string> = {
    usage: '能力使用设置',
    'skill-edit': '编辑技能', 'skill-new': '新建技能', compare: '归并技能来源',
    'mcp-edit': '编辑 MCP 服务器', 'mcp-import': '导入 MCP 配置', 'mcp-remove': '删除服务器'
  };
  const filterQuery = query.trim().toLowerCase();
  const filteredSkills = (skills?.skills ?? []).filter(skill =>
    (page !== 'review' || !!skill.conflictGroup)
    && `${skill.name} ${skill.description} ${skill.filePath} ${skill.sources.map(source => source.label).join(' ')}`.toLowerCase().includes(filterQuery));
  const filteredMcp = (mcp?.servers ?? []).filter(entry =>
    `${entry.server.name} ${entry.server.command ?? ''} ${entry.server.url ?? ''}`.toLowerCase().includes(filterQuery));
  const reviewCount = skills?.conflicts.length ?? 0;
  const sortSkills = (items: ManagedSkill[]): ManagedSkill[] => [...items].sort((a, b) => {
    const rank = (skill: ManagedSkill): number => skill.conflictGroup ? 0 : skill.status !== 'valid' ? 1 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const sortMcp = (items: ManagedMcpEntry[]): ManagedMcpEntry[] => [...items].sort((a, b) => Number(!!b.overridden) - Number(!!a.overridden) || a.server.name.localeCompare(b.server.name));
  const projectSkills = sortSkills(filteredSkills.filter(skill => !skill.inherited));
  const inheritedSkills = actualKind === 'global' ? sortSkills(filteredSkills) : sortSkills(filteredSkills.filter(skill => skill.inherited));
  const projectMcp = sortMcp(filteredMcp.filter(entry => entry.scope === 'project'));
  const inheritedMcp = sortMcp(filteredMcp.filter(entry => entry.scope === 'global'));
  const inheritedCount = page === 'mcp' ? inheritedMcp.length : inheritedSkills.length;
  const inheritedConflictCount = page === 'mcp' ? inheritedMcp.filter(entry => entry.overridden).length : inheritedSkills.filter(skill => !!skill.conflictGroup).length;
  const showInherited = actualKind === 'global' || globalExpanded || !!filterQuery || page === 'review';
  useEffect(() => { setGlobalExpanded(false); }, [scopeKey, page]);
  const openEdit = (skill: ManagedSkill): void => {
    const key = scopeKey;
    void perform(async () => {
      const document = await window.api.capabilityManagement.readSkill(skill.id, scope);
      if (scopeRef.current === key && mounted.current) openDialog({ kind: 'skill-edit', document });
    });
  };
  const openComparison = (name: string): void => {
    const key = scopeKey, request = sequence.current;
    void perform(async () => {
      const preview = await window.api.capabilityManagement.previewSkillConsolidation(scope, name);
      if (scopeRef.current === key && mounted.current && activeRef.current && request === sequence.current) openDialog({ kind: 'compare', preview });
    });
  };
  const refreshMcp = async (): Promise<void> => {
    const request = ++requestGeneration.current.mcp;
    const next = await window.api.capabilityManagement.mcpList(actualKind === 'project' ? workspaceId : undefined);
    if (mounted.current && scopeRef.current === scopeKey && request === requestGeneration.current.mcp) setMcp(next);
  };
  const saveMcp = async (server: McpServerConfig, entry?: ManagedMcpEntry): Promise<void> => {
    await window.api.capabilityManagement.saveMcp({ id: entry?.id, scope: entry?.scope ?? actualKind, workspaceId: entry?.workspaceId ?? (actualKind === 'project' ? workspaceId : undefined), server, expectedRevision: entry?.revision });
    await refreshMcp();
  };
  const globalContext = (): void => { globalSelection.current = selection; setScopeKind('global'); setQuery(''); };
  const rowSkill = (skill: ManagedSkill): React.JSX.Element => {
    const warning = skill.status !== 'valid' || !!skill.conflictGroup;
    const status = skill.status !== 'valid' ? t('来源异常') : skill.conflictGroup ? t('同名差异')
      : skill.hostOwned ? t('宿主维护 · 只读') : skill.sources.length > 1 ? t('来自 {{n}} 个通用目录', { n: skill.sources.length }) : t('通用目录来源');
    return <SettingsResourceItem key={skill.id} name={skill.name} className="cm-asset-row" selected={selection?.id === skill.id}
      aria-label={`${t('查看')} ${skill.name} ${skill.filePath}`} icon={<Icon name="skill" size={20}/>}
      meta={<SettingsResourceStatus state={warning ? 'warning' : 'neutral'}>{status}</SettingsResourceStatus>}
      onClick={e => choose({ kind: 'skill', id: skill.id }, e.currentTarget)}
      trailing={warning && <span className="cm-row-alert" title={status}><Icon name="alert" size={14}/></span>}/>;
  };
  const rowMcp = (entry: ManagedMcpEntry): React.JSX.Element => {
    const status = entry.overridden ? t('项目已覆盖') : !entry.server.enabled ? t('已停用') : !mcp?.enabled ? t('中转未启用')
      : entry.test ? entry.test.ok ? t('握手成功') : entry.test.status === 'relay-disabled' ? t('中转未启用')
        : entry.test.status === 'auth-required' ? t('需要认证') : t('连接测试失败') : t('已启用');
    const warning = !!entry.overridden || (!!entry.test && !entry.test.ok && entry.test.status !== 'relay-disabled');
    return <SettingsResourceItem key={entry.id} name={entry.server.name} className="cm-asset-row" selected={selection?.id === entry.id}
      aria-label={`${t('查看')} ${entry.server.name}`} icon={<Icon name="mcp" size={20}/>}
      meta={<span role="img" aria-label={status}><SettingsResourceStatus state={warning ? 'warning' : !entry.server.enabled ? 'neutral' : !mcp?.enabled ? 'warning' : entry.test?.ok ? 'success' : 'neutral'}>{status}</SettingsResourceStatus></span>}
      onClick={e => choose({ kind: 'mcp', id: entry.id }, e.currentTarget)}
      trailing={warning && <span className="cm-row-alert" title={status}><Icon name="alert" size={14}/></span>}/>;
  };
  const hasResults = page === 'mcp' ? filteredMcp.length > 0 : filteredSkills.length > 0 || page === 'review';
  const renderDetail = (): ReactNode => {
    const current = detail.value;
    if (!current) return null;
    if (current.kind === 'skill') return <React.Fragment key={current.key}><SkillDetail skill={current.skill} busy={busy} onGlobal={globalContext} onEdit={() => openEdit(current.skill)} onCompare={() => openComparison(current.skill.name)}/><CapabilityUsagePanel kind="skill" resourceId={current.skill.id} workspaceId={actualKind === 'project' ? workspaceId : undefined} compact active={active}/></React.Fragment>;
    const entry = current.entry;
    return <React.Fragment key={current.key}><McpDetail entry={entry} busy={busy} onGlobal={globalContext}
      onEdit={() => { setError(''); openDialog({ kind: 'mcp-edit', entry }); }}
      onRemove={() => { setError(''); openDialog({ kind: 'mcp-remove', entry }); }}
      onTest={() => { void perform(async () => { const result = await window.api.capabilityManagement.testMcp(entry.id); setMcp(previous => previous ? { ...previous, servers: previous.servers.map(item => item.id === entry.id ? { ...item, test: result } : item) } : previous); }, t('连接测试已完成。')); }}/><CapabilityUsagePanel kind="mcp" resourceId={entry.server.name} workspaceId={actualKind === 'project' ? workspaceId : undefined} compact active={active}/></React.Fragment>;
  };

  return <section ref={paneRef} className={`cm-pane${narrow ? ' is-narrow' : ''}${page === 'mcp' ? ' is-mcp-page' : ''}`} data-settings-layout="flat" data-settings-item="skills-manager" aria-label={t('能力管理')}>
    <div className="cm-tabs-row"><SettingsTabs label={t('管理分类')} value={page === 'review' ? 'skills' : page} disabled={busy} onChange={changePage} options={[
      { value: 'skills', label: 'Skills' }, { value: 'mcp', label: 'MCP' },
      { value: 'catalog', label: t('应用能力') }, { value: 'host', label: hostLabel }
    ]}/><button className="btn tiny cm-refresh" aria-label={t('刷新')} disabled={busy || (page === 'host' ? hostSetup.busy : isResourcePage ? loading : catalogLoading)} onClick={() => { if (page === 'host') { void hostSetup.load(); return; } if (page === 'catalog') { void refreshCatalog(); return; } void perform(async () => { const next = await window.api.capabilityManagement.refresh(scope); applySkills(next); await refreshMcp(); }, t('已刷新技能和配置。')); }}><Icon name="refresh" size={15}/>{t('刷新')}</button></div>
    {hostPresence.mounted && <div className="cm-host-page settings-content mp-panel" {...hostPresence.spread} aria-hidden={page !== 'host'} ref={node => { if (node) node.inert = page !== 'host'; }}><InboundMcpStatusView setup={hostSetup}/></div>}
    {page !== 'host' && <p className="cm-page-description">{page === 'skills' || page === 'review' ? t('管理全局和项目 .agents/skills 中的技能内容。') : page === 'mcp' ? t('连接外部工具服务，并设置在何处使用。') : t('查看工作台提供的工具与操作。')}</p>}
    {error && !dialog && <><ErrorTip message={localizeSkillConsolidationError(error)} /><button className="cm-text-button" disabled={busy || loading} onClick={() => { setError(''); void refresh(page === 'mcp' ? ['mcp'] : ['skills']); }}>{t('重试')}</button></>}
    {(page === 'skills' || page === 'review') && !!skills?.errors.length && <SkillDiagnostics messages={skills.errors}/>}
    {isResourcePage && <CapabilityManagementResourcePage
      page={page}
      busy={busy}
      loading={loading}
      actualKind={actualKind}
      scopeKind={scopeKind}
      workspaces={workspaces}
      workspaceId={workspaceId}
      skills={skills}
      mcp={mcp}
      query={query}
      setQuery={setQuery}
      setScopeKind={setScopeKind}
      setWorkspaceId={setWorkspaceId}
      reviewCount={reviewCount}
      projectSkills={projectSkills}
      inheritedSkills={inheritedSkills}
      projectMcp={projectMcp}
      inheritedMcp={inheritedMcp}
      inheritedCount={inheritedCount}
      inheritedConflictCount={inheritedConflictCount}
      showInherited={showInherited}
      globalExpanded={globalExpanded}
      setGlobalExpanded={setGlobalExpanded}
      hasResults={hasResults}
      pendingMcpEnabled={pendingMcpEnabled}
      setPendingMcpEnabled={setPendingMcpEnabled}
      onReview={() => changePage('review')}
      onNewSkill={() => { setError(''); openDialog({ kind: 'skill-new' }); }}
      onNewMcp={() => { setError(''); openDialog({ kind: 'mcp-edit' }); }}
      onImportMcp={() => { setError(''); openDialog({ kind: 'mcp-import' }); }}
      onMcpEnabledChange={enabled => { void perform(async () => { const next = await window.api.capabilityManagement.setMcpEnabled(enabled, actualKind === 'project' ? workspaceId : undefined); if (scopeRef.current === scopeKey) setMcp(next); }, t('已保存 MCP 开关。')).finally(() => { if (mounted.current) setPendingMcpEnabled(null); }); }}
      onOpenUsage={() => { void openDialog({ kind: 'usage', usageKind: page === 'mcp' ? 'mcp' : 'skill' }); }}
      renderSkill={rowSkill}
      renderMcp={rowMcp}
      narrow={narrow}
      detail={detail.presence}
      detailRef={detailRef}
      inventoryRef={inventoryRef}
      onCloseDetail={closeDetail}
      renderDetail={renderDetail}
      detailVisible={!!detail.value}
      dialogOpen={!!dialog}
      icon={(name, size) => <Icon name={name} size={size}/>} />}    {isResourcePage && <footer className="cm-status" role="status">{busy ? t('处理中…') : notice}</footer>}
    {page === 'catalog' && <div className="cm-page-block">
      {catalogError && <><ErrorTip message={catalogError} /><button className="cm-text-button" disabled={catalogLoading} onClick={() => { void refreshCatalog(); }}>{t('重试')}</button></>}
      {catalogLoading && <p className="cm-loading" role="status">{t('正在读取应用能力目录…')}</p>}
      {capView && <CapabilityCatalog tools={capView.tools} version={capView.version} narrow={narrow} active={active}/>}
    </div>}
    <ManagementDialog value={dialog} title={t(dialogTitle[dialogPresence.value?.kind ?? 'skill-new'])} busy={busy} error={error} onClose={closeDialog}>{snapshot => {
      const visibleSkills = snapshot.context.key === scopeKey ? skills : snapshot.context.skills;
      switch (snapshot.kind) {
        case 'usage': return <CapabilityUsagePanel kind={snapshot.usageKind} workspaceId={snapshot.context.workspaceId} workspaces={cfg.workspaces} active={!!dialog}/>;
        case 'skill-edit': return <SkillEditor key={snapshot.document.id} document={snapshot.document} busy={busy} onCancel={closeDialog} onSave={body => { if (scopeKey !== snapshot.context.key) return; void perform(async () => { const next = await window.api.capabilityManagement.saveSkill({ id: snapshot.document.id, scope: snapshot.context.scope, body, expectedHash: snapshot.document.hash }); applySkills(next, snapshot.context.key); setDialog(null); }, t('技能内容已保存；使用同一源的入口需要重新加载。')); }}/>;
        case 'skill-new': return visibleSkills ? <NewSkillForm scope={snapshot.context.scope} snapshot={visibleSkills} busy={busy} onCancel={closeDialog} onSave={(name, description, body) => { if (scopeKey !== snapshot.context.key) return; void perform(async () => { const next = await window.api.capabilityManagement.createSkill({ scope: snapshot.context.scope, name, description, body }); setDialog(null); if (applySkills(next, snapshot.context.key)) { const created = next.skills.find((skill: ManagedSkill) => skill.name === name); if (created) setSelection({ kind: 'skill', id: created.id }); } }, t('技能已创建，保留当前作用范围。')); }}/> : null;
        case 'compare': return <SkillComparison key={`${snapshot.context.key}:${snapshot.preview.name}`} initial={snapshot.preview} scope={snapshot.context.scope} revision={visibleSkills?.revision ?? 0} active={active && !!dialog && scopeKey === snapshot.context.key} busy={busy} onCancel={closeDialog} onSave={preview => { if (scopeKey !== snapshot.context.key || !preview.selectedId) return Promise.resolve(false); return perform(async () => { const result = await window.api.capabilityManagement.consolidateSkill({ scope: snapshot.context.scope, name: preview.name, skillId: preview.selectedId!, expectedFingerprint: preview.fingerprint }); if (applySkills(result.snapshot, snapshot.context.key)) { setDialog(null); const retained = result.snapshot.skills.find(skill => skill.name === preview.name); if (retained) setSelection({ kind: 'skill', id: retained.id }); setNotice(t('技能已归并，备份保存在 {{path}}', { path: result.backupPath })); } }); }}/>;
        case 'mcp-edit': return <McpEditor key={snapshot.entry?.id ?? 'new'} entry={snapshot.entry} busy={busy} onCancel={closeDialog} onSave={server => { if (scopeKey !== snapshot.context.key) return; void perform(async () => { await saveMcp(server, snapshot.entry); setDialog(null); }, t('MCP 配置已保存。')); }}/>;
        case 'mcp-import': return <ImportMcpForm busy={busy} onCancel={closeDialog} onImport={json => { if (scopeKey !== snapshot.context.key) return; void perform(async () => { await window.api.capabilityManagement.importMcp({ scope: snapshot.context.mcpScope, workspaceId: snapshot.context.workspaceId, json }); await refreshMcp(); setDialog(null); }, t('MCP 配置已导入。')); }}/>;
        case 'mcp-remove': return <><p>{t('删除后服务器不再进入宿主中转清单；各引擎的原生配置文件不会被修改。')}</p><strong className="cm-delete-name">{snapshot.entry.server.name}</strong><footer className="cm-modal-footer"><button className="btn tiny cm-button" disabled={busy} onClick={closeDialog}>{t('取消')}</button><button className="btn primary tiny cm-button cm-button-solid" disabled={busy} onClick={() => { if (scopeKey !== snapshot.context.key) return; void perform(async () => { await window.api.capabilityManagement.removeMcp({ id: snapshot.entry.id, expectedRevision: snapshot.entry.revision }); await refreshMcp(); setSelection(null); setDialog(null); }, t('服务器配置已删除。')); }}>{t('确认删除')}</button></footer></>;
      }
    }}</ManagementDialog>
  </section>;
}
