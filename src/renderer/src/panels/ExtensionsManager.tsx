import { ErrorTip, ErrorTipDetails } from '../components/ErrorTip';
import React, { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExtensionDiscoveredExtension, ExtensionListing, ExtensionTransactionProblem } from '../../../shared/extension';
import { EXTENSION_CENTER_CATEGORIES, type ExtensionCenterListing, type ExtensionCenterRelease } from '../../../shared/extensionCenter';
import { AppConfirmDialog } from '../components/AppConfirmDialog';
import { usePresence, usePresenceValue } from '../components/motion';
import { CustomSelect } from '../components/CustomSelect';
import { localizeExtensionReason } from './extensionReason';
import { ExtensionIcon } from '../extensionIcons';
import type { ExtensionPublishingApi, ExtensionSubmission } from '../../../shared/extensionPublishing';
import { ExtensionPublishingAdminDialog, ExtensionSubmissionDialog, SubmissionStatus, useExtensionPublishing } from './ExtensionPublishing';
import { showTip } from '../tips';

type Scope = 'global' | 'project';
const MANAGEMENT_TABS = ['global', 'project', 'center'] as const;
export type ExtensionManagementTab = typeof MANAGEMENT_TABS[number];

interface Props {
  workspaceId: string;
  sourceRootId: string;
  projectLabel: string;
  projects?: Array<{ id: string; label: string }>;
  onProjectChange?: (sourceRootId: string) => void;
  selectedTab?: ExtensionManagementTab;
  onTabChange?: (tab: ExtensionManagementTab) => void;
  listing: ExtensionListing;
  setEnabled: (scope: Scope, extensionId: string, enabled: boolean) => Promise<void>;
  setEnabledAll?: (extensionId: string, enabled: boolean) => Promise<void>;
  preserveTransaction?: (id: string) => Promise<string>;
  uninstallGlobal?: (extensionId: string, fingerprint: string) => Promise<void>;
  installLocal?: () => Promise<{ canceled: true } | { extensionId: string }>;
  onRefresh?: () => void;
  centerCatalog?: ExtensionCenterListing | null;
  centerLoading?: boolean;
  centerError?: string;
  installCenter?: (packageKey: string) => Promise<void>;
  uninstallCenter?: (packageKey: string) => Promise<void>;
  onCenterOpen?: () => void;
  onCenterRefresh?: () => void;
  publishingApi?: ExtensionPublishingApi;
}

function TransactionProblem({ problem, preserve, onPreserved }: { problem: ExtensionTransactionProblem; preserve?: (id: string) => Promise<string>; onPreserved: (path: string) => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const presence = usePresence(confirming);
  const confirm = async (): Promise<void> => {
    if (!preserve) return;
    setBusy(true); setError('');
    try { onPreserved(await preserve(problem.id)); setConfirming(false); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="ext-extension-issue ext-extension-transaction" role="alert">
    <div className="ui-row">{problem.extensionId && <strong>{problem.extensionId}</strong>}
      <ErrorTipDetails message={localizeExtensionReason(problem.reason)} />
    </div>
    <div className="ext-extension-transaction-paths"><span>{t('事务相关路径')}：</span>{problem.paths.map(path => <div key={path}><code>{path}</code></div>)}</div>
    {preserve && !confirming && <button type="button" className="ui-btn tiny" disabled={busy} onClick={() => setConfirming(true)}>{t('保留现场并结束恢复')}</button>}
    {presence.mounted && <div className="mp-panel" data-mp-stage={presence.stage} aria-hidden={!confirming} {...(!confirming ? { inert: '' as unknown as boolean } : {})}>
      <p>{t('事务记录和相关目录都会保留。结束恢复后，工作台可能继续同步；请先检查路径中是否有需要手动取回的数据。')}</p>
      <div className="ext-extension-transaction-actions"><button type="button" className="ui-btn tiny" disabled={busy} onClick={() => void confirm()}>{t('确认保留并结束恢复')}</button>
      <button type="button" className="ui-btn ghost tiny" disabled={busy} onClick={() => setConfirming(false)}>{t('取消')}</button></div>
    </div>}
    <ErrorTip message={error ? localizeExtensionReason(error) : null} />
  </div>;
}

function ExtensionRow({ entry, scope, setEnabled, setEnabledAll, uninstallGlobal, submission, onSubmit }: {
  entry: ExtensionDiscoveredExtension; scope: Scope; setEnabled: Props['setEnabled']; setEnabledAll?: Props['setEnabledAll'];
  uninstallGlobal?: Props['uninstallGlobal']; submission?: ExtensionSubmission; onSubmit?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const presence = usePresence(expanded);
  const name = entry.manifest?.name ?? entry.id;
  const installed = entry.status === 'installed' || entry.status === 'approved';
  const enabledAnywhere = entry.enabledInAnyWorkspace ?? entry.enabled;
  const canUninstall = scope === 'global' && uninstallGlobal && !entry.bundled && Boolean(entry.fingerprint);
  const status = installed ? (entry.enabled ? t('已启用') : t('已禁用'))
    : entry.status === 'reviewing' ? t('审核中') : entry.status === 'rejected' ? t('审核未通过')
    : entry.status === 'pending' ? t('待审核') : entry.status === 'conflict' ? t('有冲突') : t('校验失败');
  const toggle = async (): Promise<void> => {
    setBusy(true); setError('');
    try { await setEnabled(scope, entry.id, !entry.enabled); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const toggleAll = async (): Promise<void> => {
    if (!setEnabledAll) return;
    setBusy(true); setError('');
    try { await setEnabledAll(entry.id, !enabledAnywhere); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const uninstall = async (): Promise<void> => {
    if (!uninstallGlobal || !entry.fingerprint) return;
    setConfirmUninstall(false); setBusy(true); setError('');
    try { await uninstallGlobal(entry.id, entry.fingerprint); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <article className="prompt-task-row ext-manager-row ext-extension-row">
    <div className="ext-manager-row-main">
      <ExtensionIcon className="ext-manager-icon" value={entry.manifest?.icon} size={22} fallback={name.slice(0, 1)} />
      <button type="button" className="ext-extension-summary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <span className="ext-manager-name-line"><span className="ext-manager-name">{name}</span><span className={`ext-status ${installed ? (entry.enabled ? 'on' : 'off') : ['reviewing', 'pending', 'conflict'].includes(entry.status) ? 'warning' : 'error'}`}>{status}</span></span>
        {entry.manifest && <span className="ext-manager-desc">{entry.manifest.surface.kind}{entry.manifest.version ? ` · v${entry.manifest.version}` : ''}</span>}
        {entry.manifest?.description && <span className="ext-manager-desc">{entry.manifest.description}</span>}
        {submission?.status === 'changes' && submission.reason && <span className="ext-manager-desc">{submission.reason}</span>}
      </button>
      <div className="ui-row ext-extension-actions">
        {submission && <SubmissionStatus submission={submission} />}
        {onSubmit && <button type="button" className="ui-btn ghost tiny" disabled={submission?.status === 'checking'} onClick={onSubmit}>{t(submission ? '提交更新' : '提交到扩展中心')}</button>}
        <button type="button" className="ui-btn tiny ext-extension-toggle" role="switch" aria-label={t('启用 {{name}}', { name })} aria-checked={entry.enabled === true} disabled={busy} onClick={() => void toggle()}>{entry.enabled ? t('禁用') : t('启用')}</button>
        {scope === 'global' && setEnabledAll && <button type="button" className="ui-btn ghost tiny" aria-label={t(enabledAnywhere ? '全部工作区关闭 {{name}}' : '全部工作区启用 {{name}}', { name })} disabled={busy} onClick={() => void toggleAll()}>{enabledAnywhere ? t('全部工作区关闭') : t('全部工作区启用')}</button>}
        {canUninstall && <button type="button" className="ui-btn ghost tiny" aria-label={t('卸载 {{name}}', { name })} disabled={busy || enabledAnywhere} onClick={() => setConfirmUninstall(true)}>{t('卸载')}</button>}
      </div>
    </div>
    {presence.mounted && <div className="ext-extension-detail mp-panel" data-mp-stage={presence.stage} aria-hidden={!expanded} {...(!expanded ? { inert: '' as unknown as boolean } : {})}>
      <div><strong>{t('扩展 ID')}：</strong><code>{entry.id}</code></div>
      <div><strong>{t('源码位置')}：</strong><code>{entry.directory || t('不可用')}</code></div>
      <div><strong>{t('版本指纹')}：</strong><code>{entry.fingerprint || t('不可用')}</code></div>
      {entry.reason && <ErrorTipDetails message={localizeExtensionReason(entry.reason)} />}
    </div>}
    {error && <ErrorTip message={localizeExtensionReason(error)} />}
    {canUninstall && <AppConfirmDialog open={confirmUninstall} title={t('卸载「{{name}}」？', { name })} detail={t('扩展文件会移到系统回收站，工作区数据会保留。')} confirmLabel={t('移到回收站')} danger focusCancel onCancel={() => setConfirmUninstall(false)} onConfirm={() => void uninstall()} />}
  </article>;
}

function CenterReleaseDetail({ release, sourceLabel, onBack, actionLabel, canInstall, canUninstall, busy, onInstall, onUninstall }: {
  release: ExtensionCenterRelease;
  sourceLabel: string;
  onBack: () => void;
  actionLabel: string;
  canInstall: boolean;
  canUninstall: boolean;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const hasUpdate = release.installed && Boolean(release.installedVersion) && release.installedVersion !== release.version;
  return <article className="ext-extension-center-detail" aria-label={release.name}>
    <div className="ext-extension-center-detail-toolbar"><button type="button" className="ui-btn ghost tiny" onClick={onBack}>{t('返回扩展中心')}</button></div>
    <div className="ext-extension-center-detail-header">
      <ExtensionIcon className="ext-manager-icon" value={undefined} size={38} fallback={release.name.slice(0, 1)} />
      <div className="ext-extension-center-detail-title"><h2>{release.name}</h2><p>{release.publisherId}/{release.extensionId}</p></div>
      <span className={`ext-status ${hasUpdate ? 'warning' : release.installed ? 'on' : 'off'}`}>{hasUpdate ? t('有更新') : release.installed ? t('已安装') : t('可安装')}</span>
    </div>
    {release.description && <p className="ext-extension-center-detail-description">{release.description}</p>}
    <dl className="ext-extension-center-detail-meta">
      <div><dt>{t('发布者')}</dt><dd>{release.publisherId}</dd></div>
      {release.publisherName && <div><dt>{t('发布者名称')}</dt><dd>{release.publisherName}</dd></div>}
      <div><dt>{t('发布版本')}</dt><dd>v{release.version}</dd></div>
      <div><dt>{t('安装状态')}</dt><dd>{release.installed ? (release.installedVersion ? `v${release.installedVersion}` : t('已安装')) : t('未安装')}</dd></div>
      {release.updatedAt && <div><dt>{t('更新时间')}</dt><dd>{release.updatedAt}</dd></div>}
      {release.license && <div><dt>{t('许可证')}</dt><dd>{release.license}</dd></div>}
      <div><dt>{t('版本指纹')}</dt><dd><code>{release.fingerprint}</code></dd></div>
      {release.sha256 && <div><dt>{t('包 SHA-256')}</dt><dd><code>{release.sha256}</code></dd></div>}
      <div><dt>{t('中心来源')}</dt><dd>{sourceLabel}</dd></div>
    </dl>
    {release.releaseNotes && <section className="ext-extension-center-detail-section"><h3>{t('发布说明')}</h3><p>{release.releaseNotes}</p></section>}
    <section className="ext-extension-center-detail-section"><h3>README</h3><div className="ext-extension-center-detail-readme">{release.readme || release.description || t('暂无 README')}</div></section>
    {release.repositoryUrl && <p className="ext-extension-center-detail-link"><a href={release.repositoryUrl} target="_blank" rel="noreferrer">{t('查看仓库')}</a></p>}
    <div className="ext-extension-center-detail-actions"><button type="button" className="ui-btn tiny" disabled={!canInstall || busy} onClick={onInstall}>{actionLabel}</button>{canUninstall && <button type="button" className="ui-btn ghost tiny" disabled={busy} onClick={onUninstall}>{busy ? t('卸载中…') : t('卸载')}</button>}</div>
  </article>;
}

/** Presentation-only component; host adapters supply the current project and actual statuses. */
export function ExtensionsManager({ workspaceId, sourceRootId, projectLabel, projects, onProjectChange, selectedTab, onTabChange, listing, setEnabled, setEnabledAll, preserveTransaction, uninstallGlobal, installLocal, onRefresh, centerCatalog, centerLoading, centerError, installCenter, uninstallCenter, onCenterOpen, onCenterRefresh, publishingApi }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const publishing = useExtensionPublishing(publishingApi);
  const [publication, setPublication] = useState<ExtensionDiscoveredExtension>();
  const [submissionOpen, setSubmissionOpen] = useState(false), [publishingAdminOpen, setPublishingAdminOpen] = useState(false), [connecting, setConnecting] = useState(false);
  const latestSubmission = (id: string) => publishing.mine.filter(item => item.extensionId === id).at(-1);
  const refreshPublishing = () => { void publishing.refresh().catch(cause => showTip(String(cause), { tone: 'error' })); };
  const [localTab, setLocalTab] = useState<ExtensionManagementTab>('global');
  const [localBusy, setLocalBusy] = useState(false), [localError, setLocalError] = useState('');
  const [centerBusy, setCenterBusy] = useState(''), [centerInstallError, setCenterInstallError] = useState('');
  const [selectedCenterPackageKey, setSelectedCenterPackageKey] = useState<string | null>(null);
  const centerReleases = centerCatalog?.releases;
  const selectedCenterRelease = centerReleases?.find(release => release.packageKey === selectedCenterPackageKey) ?? null;
  const centerDetail = usePresenceValue(centerCatalog && selectedCenterRelease ? { release: selectedCenterRelease, source: centerCatalog.source } : null);
  const centerSourceLabels = {
    github: t('GitHub 扩展中心'),
    remote: t('自定义远程扩展目录'),
    file: t('本地扩展目录'),
    bundled: t('内置扩展目录'),
  };
  const categoryLabels = {
    creative: t('创作'),
    reading: t('阅读'),
    productivity: t('效率'),
    games: t('游戏'),
    other: t('其他'),
  };
  const [preservedPath, setPreservedPath] = useState('');
  const tab = selectedTab ?? localTab;
  const tabId = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const adminGesture = useRef<{ count: number; started: number } | null>(null);
  const labels = { global: t('全局扩展'), project: t('项目扩展'), center: t('扩展中心') };
  const select = (next: ExtensionManagementTab): void => {
    setLocalTab(next);
    onTabChange?.(next);
    if (next === 'center') onCenterOpen?.();
  };
  const activateTab = (item: ExtensionManagementTab, event: React.MouseEvent<HTMLButtonElement>): void => {
    select(item);
    if (item !== 'center' || !publishingApi || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      adminGesture.current = null;
      return;
    }
    const previous = adminGesture.current;
    if (!previous || event.timeStamp - previous.started > 3000) {
      adminGesture.current = { count: 1, started: event.timeStamp };
    } else if (previous.count === 2) {
      adminGesture.current = null;
      setPublishingAdminOpen(true);
    } else {
      previous.count++;
    }
  };
  const keyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const count = MANAGEMENT_TABS.length;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
      : event.key === 'ArrowRight' ? (index + 1) % count
      : event.key === 'ArrowLeft' ? (index + count - 1) % count : null;
    if (next === null) return;
    event.preventDefault();
    tabs.current[next]?.focus();
  };
  const panelProps = (panel: ExtensionManagementTab) => ({
    role: 'tabpanel' as const,
    id: `${tabId}-panel-${panel}`,
    'aria-labelledby': `${tabId}-tab-${panel}`,
    'aria-hidden': panel !== tab,
    tabIndex: panel === tab ? 0 : -1,
    ...(panel !== tab ? { inert: '' as unknown as boolean } : {}),
  });
  const globalGroups = [
    { label: t('下载的扩展'), items: listing.global.filter(entry => entry.sourceKind === 'center' && !entry.bundled) },
    { label: t('本地扩展'), items: listing.global.filter(entry => entry.sourceKind !== 'center' || entry.bundled) },
  ];
  const renderRow = (entry: ExtensionDiscoveredExtension, scope: Scope) => (
    <ExtensionRow key={`${workspaceId}:${sourceRootId}:${scope}:${entry.id}`} entry={entry} scope={scope} setEnabled={setEnabled} setEnabledAll={setEnabledAll} uninstallGlobal={uninstallGlobal}
      submission={scope === 'global' ? latestSubmission(entry.id) : undefined}
      onSubmit={scope === 'global' && publishing.session?.available && entry.manifest && !entry.bundled && entry.sourceKind !== 'center'
        ? () => { setPublication(entry); setSubmissionOpen(true); } : undefined} />
  );
  const installLocalPackage = async (): Promise<void> => {
    if (!installLocal) return;
    setLocalBusy(true); setLocalError('');
    try {
      await installLocal();
    } catch (cause) { setLocalError(String(cause)); }
    finally { setLocalBusy(false); }
  };
  const installCenterRelease = async (packageKey: string): Promise<void> => {
    if (!installCenter) return;
    setCenterBusy(packageKey); setCenterInstallError('');
    try { await installCenter(packageKey); }
    catch (cause) { setCenterInstallError(String(cause)); }
    finally { setCenterBusy(''); }
  };
  const uninstallCenterRelease = async (packageKey: string): Promise<void> => {
    if (!uninstallCenter) return;
    setCenterBusy(packageKey); setCenterInstallError('');
    try { await uninstallCenter(packageKey); }
    catch (cause) { setCenterInstallError(String(cause)); }
    finally { setCenterBusy(''); }
  };
  return <main className="prompt-task-panel ext-manager-panel ext-extension-manager">
    <header className="prompt-task-toolbar"><div><h1>{t('扩展管理')}</h1></div></header>
    <div role="tablist" aria-label={t('扩展管理')} className="ext-extension-tabs">
      {MANAGEMENT_TABS.map((item, index) => <button key={item} ref={node => { tabs.current[index] = node; }}
        type="button" role="tab" id={`${tabId}-tab-${item}`} aria-controls={`${tabId}-panel-${item}`}
        aria-selected={tab === item} tabIndex={tab === item ? 0 : -1}
        onKeyDown={event => keyDown(event, index)} onClick={event => activateTab(item, event)}>
        {labels[item]}{item !== 'center' && <span>{listing[item].length}</span>}
      </button>)}
    </div>
    {tab !== 'center' && <div className="ext-extension-problems">
      {localError && <ErrorTip message={localError} />}
      <ErrorTip message={[...listing.issues.map(localizeExtensionReason), ...listing.problems.map(item =>
        item.id + '：' + (item.reason ? localizeExtensionReason(item.reason) : t('校验失败')))].join('\n')} />
      {preservedPath && <p className="ext-extension-issue" role="status">{t('事务记录已保留至 {{path}}', { path: preservedPath })}</p>}
      {(listing.transactions ?? []).map(problem => <TransactionProblem key={problem.id} problem={problem} preserve={preserveTransaction} onPreserved={setPreservedPath}/>)}
    </div>}
    <div className="xfade-stack ext-extension-views">
      <section {...panelProps('global')} className={`xfade ext-extension-list${tab === 'global' ? ' is-shown' : ''}`}>
        {(onRefresh || installLocal) && <div className="ext-extension-installed-toolbar ext-extension-global-toolbar">
          <div className="ui-row">
            {onRefresh && <button type="button" className="ui-btn tiny" onClick={onRefresh}>{t('刷新')}</button>}
            {installLocal && <button type="button" className="ui-btn tiny" disabled={localBusy} onClick={() => void installLocalPackage()}>{t('安装本地扩展')}</button>}
          </div>
        </div>}
        {listing.global.length ? <div className="ext-extension-global-groups">
          {globalGroups.map(group => group.items.length > 0 && (
            <section className="ext-extension-group" key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map(entry => renderRow(entry, 'global'))}
            </section>
          ))}
        </div> : <div className="ui-empty prompt-task-empty"><p className="ui-empty-title">{t('还没有全局扩展')}</p></div>}
      </section>
      <section {...panelProps('project')} className={`xfade ext-extension-list${tab === 'project' ? ' is-shown' : ''}`}>
        <div className="ext-extension-installed-toolbar">
          {projects && (projects.length > 1 || !projects.some(item => item.id === sourceRootId)) && onProjectChange
            ? <div className="ext-extension-project">
              <span>{t('当前项目')}</span>
              <CustomSelect ariaLabel={t('选择当前项目')} placeholder={t('选择当前项目')} value={sourceRootId}
                options={projects.map(item => ({ value: item.id, label: item.label }))} onChange={onProjectChange} />
            </div>
            : <span>{t('当前项目：{{project}}', { project: projectLabel })}</span>}
          {onRefresh && <button type="button" className="ui-btn tiny" onClick={onRefresh}>{t('刷新')}</button>}
        </div>
        {listing.project.length ? listing.project.map(entry => renderRow(entry, 'project'))
          : <div className="ui-empty prompt-task-empty"><p className="ui-empty-title">{t('当前项目还没有扩展')}</p></div>}
      </section>
      <section {...panelProps('center')} className={`xfade ext-extension-center${tab === 'center' ? ' is-shown' : ''}`}>
        <div className="ext-extension-center-toolbar"><span>{centerCatalog && centerSourceLabels[centerCatalog.source]}</span>
          {publishingApi && publishing.session?.available && !publishing.session.login && <button type="button" className="ui-btn tiny" disabled={connecting} onClick={() => {
            setConnecting(true);
            void publishingApi.signIn().then(refreshPublishing, cause => showTip(String(cause), { tone: 'error' })).finally(() => setConnecting(false));
          }}>{t('登录 GitHub')}</button>}
          {onCenterRefresh && <button type="button" className="ui-btn tiny" onClick={onCenterRefresh}>{t('刷新')}</button>}</div>
        {centerError && <ErrorTip message={centerError} />}
        {centerInstallError && <ErrorTip message={centerInstallError} />}
        {centerLoading ? <div className="ui-empty" role="status"><p>{t('加载中…')}</p></div> : !centerReleases?.length ? <div className="ui-empty"><p className="ui-empty-title">{t('扩展中心暂无可用扩展')}</p></div> : <div className="xfade-stack ext-extension-center-views">
          <div className={`xfade ext-extension-center-list-view${selectedCenterRelease ? '' : ' is-shown'}`} aria-hidden={Boolean(selectedCenterRelease)} {...(selectedCenterRelease ? { inert: '' as unknown as boolean } : {})}>
            <div className="ext-extension-center-list">{[...EXTENSION_CENTER_CATEGORIES, 'other' as const].map(category => {
              const releases = centerReleases.filter(release => (release.category ?? 'other') === category);
              if (!releases.length) return null;
              return <section className="ext-extension-group" key={category}>
                <h2>{categoryLabels[category]}</h2>
                {releases.map(release => {
                  const hasUpdate = release.installed && Boolean(release.installedVersion) && release.installedVersion !== release.version;
                  const actionLabel = centerBusy === release.packageKey ? (hasUpdate ? t('更新中…') : t('安装中…')) : hasUpdate ? t('更新') : release.installed ? t('已安装') : t('安装');
                  const canUninstall = release.installed && !hasUpdate && !!uninstallCenter;
                  return <article className="prompt-task-row ext-manager-row ext-extension-row" key={release.packageKey}>
                    <div className="ext-manager-row-main"><ExtensionIcon className="ext-manager-icon" value={undefined} size={22} fallback={release.name.slice(0, 1)} />
                      <button type="button" className="ext-extension-summary" aria-label={t('查看扩展详情 {{name}}', { name: release.name })} onClick={() => setSelectedCenterPackageKey(release.packageKey)}><span className="ext-manager-name-line"><span className="ext-manager-name">{release.name}</span><span className={`ext-status ${hasUpdate ? 'warning' : release.installed ? 'on' : 'off'}`}>{hasUpdate ? t('有更新') : release.installed ? t('已安装') : t('可安装')}</span></span><span className="ext-manager-desc">{release.publisherId}/{release.extensionId} · v{release.version}{hasUpdate && release.installedVersion ? ` · ${t('当前版本')} v${release.installedVersion}` : ''}</span>{release.description && <span className="ext-manager-desc">{release.description}</span>}</button>
                      <div className="ui-row ext-extension-actions"><button type="button" className="ui-btn tiny" disabled={(!hasUpdate && release.installed) || centerBusy === release.packageKey || !installCenter} onClick={() => void installCenterRelease(release.packageKey)}>{actionLabel}</button>{canUninstall && <button type="button" className="ui-btn ghost tiny" disabled={centerBusy === release.packageKey} onClick={() => void uninstallCenterRelease(release.packageKey)}>{centerBusy === release.packageKey ? t('卸载中…') : t('卸载')}</button>}</div>
                    </div>
                  </article>;
                })}
              </section>;
            })}</div>
          </div>
          <div className={`xfade ext-extension-center-detail-view${selectedCenterRelease ? ' is-shown' : ''}`} aria-hidden={!selectedCenterRelease} {...(!selectedCenterRelease ? { inert: '' as unknown as boolean } : {})}>
            {centerDetail.presence.mounted && centerDetail.value && (() => {
              const { release, source } = centerDetail.value;
              const detailHasUpdate = release.installed && Boolean(release.installedVersion) && release.installedVersion !== release.version;
              return <div className="mp-panel" data-mp-stage={centerDetail.presence.stage}><CenterReleaseDetail release={release} sourceLabel={centerSourceLabels[source]} onBack={() => setSelectedCenterPackageKey(null)} actionLabel={centerBusy === release.packageKey ? (detailHasUpdate ? t('更新中…') : t('安装中…')) : detailHasUpdate ? t('更新') : release.installed ? t('已安装') : t('安装')} canInstall={Boolean(installCenter) && (!release.installed || detailHasUpdate)} canUninstall={Boolean(uninstallCenter && release.installed && !detailHasUpdate)} busy={centerBusy === release.packageKey} onInstall={() => void installCenterRelease(release.packageKey)} onUninstall={() => void uninstallCenterRelease(release.packageKey)} /></div>;
            })()}
          </div>
        </div>}
      </section>
    </div>
    {publishingApi && publication && <ExtensionSubmissionDialog key={publication.id} open={submissionOpen} id={publication.id}
      name={publication.manifest?.name ?? publication.id} previous={latestSubmission(publication.id)} api={publishingApi}
      session={publishing.session} close={() => setSubmissionOpen(false)} submitted={refreshPublishing} />}
    {publishingApi && <ExtensionPublishingAdminDialog open={publishingAdminOpen} api={publishingApi} session={publishing.session}
      close={() => setPublishingAdminOpen(false)} refresh={publishing.refresh} refreshCatalog={onCenterRefresh} />}
  </main>;
}
