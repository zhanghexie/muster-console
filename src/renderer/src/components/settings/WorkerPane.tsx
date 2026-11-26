import { ErrorTip } from '../ErrorTip';
import { SettingsResourceItem, SettingsResourceStatus, SettingsDetailSection } from './SettingsResource';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentRuntimeEntry, AppConfig, RuntimeMutationResult } from '../../../../shared/types';
import { runtimeSurface } from '../../../../shared/types';
import { localizePreflightFix } from '../../../../shared/runtimePreflight';
import {
  AdvancedDetails,
  FieldRow,
  SettingRow,
  SettingsRows,
  SettingsSection,
  Switch,
  formatExtraArgs,
  parseExtraArgs
} from './shared';
import { HarnessIcon } from '../HarnessIcon';
import { IconChevronLeft, IconRefresh, IconSliders } from '../icons';
import { SearchBar } from '../SearchBar';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import './worker-pane.css';
import { WorkerChatModels } from './WorkerChatModels';
import { workerProducts, type WorkerProduct } from './workerCatalog';
import { WorkerProductHeader, productStatus } from './WorkerProductHeader';
import { acpAgentEnabled } from '../../../../shared/acpAgentSettings';
import { WorkerDetailViews } from './WorkerDetailViews';
import { SettingsDetailHeadingScope } from './SettingsSectionJump';
import { useRuntimeAvailability } from '../../hooks/useRuntimeAvailability';
import { CustomSelect } from '../CustomSelect';
import { ClaudeAccountSettings } from './ClaudeAccountSettings';
import { SettingsPathField, canRevealSettingsPath } from './SettingsPathField';
import { normalizeRuntimeManifest } from '../../../../shared/runtimeManifest';
import { HarnessCatalogRefresh } from './HarnessCatalogRefresh';
import { WorkerRoutingPane, type WorkerRoutingDraftController } from './WorkerRoutingPane';
type RuntimeDraft = { label: string; extraArgs: string; };


function installationHintUrl(value?: string): string | null {
  if (!value || /[\s<>"']/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

/**
 * Worker 设置：左侧选择运行入口，右侧详情保活；默认/Shell 与注册/维护单独收纳。
 * Runtime 增删改即时生效（需确认）。工作区切换/打开在顶栏「工作区」菜单
 * 与左下角头像，不在此页重复收纳。
 */
export function WorkerPane({
  cfg,
  set,
  focusItem,
  active = true,
  onNavigate,
  onRoutingDraftChange
}: {
  cfg: AppConfig;
  focusItem?: string;
  active?: boolean;
  onNavigate?: (tab: 'agent' | 'capabilityManagement') => void;
  onRoutingDraftChange?: (draft: WorkerRoutingDraftController | null) => void;
  set: (patch: Partial<AppConfig>) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [runtimes, setRuntimes] = useState<AgentRuntimeEntry[]>([]);
  const [runtimeDrafts, setRuntimeDrafts] = useState<Record<string, RuntimeDraft>>({});
  const [executableDrafts, setExecutableDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState('');
  const [catalogTab, setCatalogTab] = useState<'mine' | 'all'>('mine');
  const [visited, setVisited] = useState<string[]>(['general']);
  const [query, setQuery] = useState('');
  const [routingWorkspace] = useState(() => cfg.workspaces.find(workspace => workspace.id === cfg.activeWorkspaceId));
  const [routingLayer] = useState<'global' | 'workspace'>(() =>
    routingWorkspace && Object.hasOwn(cfg.workerRoutingByWorkspace ?? {}, routingWorkspace.id) ? 'workspace' : 'global');
  const [narrow, setNarrow] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [resourceFocused, setResourceFocused] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null), listRef = useRef<HTMLElement>(null), detailRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null), restoreFocus = useRef(false);
  const listRequest = useRef(0), runtimeListRef = useRef<AgentRuntimeEntry[]>([]), mounted = useRef(true);

  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [manifestDraft, setManifestDraft] = useState('');
  const [runtimeMsg, setRuntimeMsg] = useState('');
  const [error, setError] = useState('');
  const [preflightError, setPreflightError] = useState('');
  const catalogAvailability = useRuntimeAvailability(active);
  const products = useMemo(() => workerProducts(runtimes, cfg, catalogAvailability.snapshot), [runtimes, cfg, catalogAvailability.snapshot]);
  useEffect(() => {
    if (!runtimes.length || selected === 'general') return;
    if (products.some(product => product.key === selected)) return;
    const preferred = products.find(product => product.runtime?.id === cfg.defaultRuntime || product.terminal?.id === cfg.defaultRuntime);
    setSelected(preferred?.key ?? products.find(product => product.mine && (product.runtime || product.terminal))?.key ?? products[0]?.key ?? 'general');
  }, [products, selected, cfg.defaultRuntime, runtimes.length]);


  const persistClaude = async (next: NonNullable<AppConfig['claude']>): Promise<void> => {
    setError(''); setRuntimeMsg('');
    await window.api.config.update({ claude: next.isolateConfig ? next : {} });
    if (mounted.current) set({ claude: next.isolateConfig ? next : undefined });
  };

  const reloadRuntimes = useCallback((): void => {
    const request = ++listRequest.current;
    void window.api.runtimes.list().then(list => {
      if (!mounted.current || request !== listRequest.current) return;
      const previousList = runtimeListRef.current;
      setRuntimeDrafts(previous => Object.fromEntries(list.map(entry => {
        const old = previousList.find(item => item.id === entry.id), draft = previous[entry.id];
        const dirty = old && draft && (draft.label !== old.label || draft.extraArgs !== formatExtraArgs(old.extraArgs));
        return [entry.id, dirty ? draft : { label: entry.label, extraArgs: formatExtraArgs(entry.extraArgs) }];
      })));
      runtimeListRef.current = list; setRuntimes(list);

    }).catch(e => { if (mounted.current && request === listRequest.current) setError((e as Error).message); });
  }, []);
  useEffect(() => {
    mounted.current = true; reloadRuntimes();
    const unsubscribe = window.api.on('runtimes:changed', reloadRuntimes);
    return () => { mounted.current = false; ++listRequest.current; unsubscribe(); };
  }, [reloadRuntimes]);
  useEffect(() => { setVisited(previous => previous.includes(selected) ? previous : [...previous, selected]); }, [selected]);
  useEffect(() => {
    const node = paneRef.current; if (!node) return;
    const measure = (): void => { const width = node.getBoundingClientRect().width; if (width > 0) setNarrow(width <= 680); };
    measure(); const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); observer?.observe(node);
    window.addEventListener('resize', measure); return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const choose = (value: string, trigger?: HTMLElement): void => {
    if (trigger) triggerRef.current = trigger;
    setSelected(value); setDetailOpen(true);
  };
  const back = (): void => { restoreFocus.current = true; setDetailOpen(false); };
  useOverlayDismiss(active && narrow && detailOpen && resourceFocused, back);
  useEffect(() => {
    if (!active || !focusItem) return;
    if (focusItem === 'worker-default') choose('general');
    if (focusItem === 'worker-claude-gui') choose('product:claude');
  }, [focusItem, active]);
  useEffect(() => {
    if (listRef.current) listRef.current.inert = narrow && detailOpen;
    if (detailRef.current) detailRef.current.inert = narrow && !detailOpen;
    if (narrow && detailOpen) detailRef.current?.focus({ preventScroll: true });
    if (!detailOpen && restoreFocus.current) { restoreFocus.current = false; triggerRef.current?.focus({ preventScroll: true }); }
  }, [narrow, detailOpen]);

  /** 可用性预检：只有用户点击检测时运行。 */
  const runPreflight = async (id?: string): Promise<void> => {
    try {
      const res = await window.api.runtimes.preflight(id);
      if (!res.ok) throw new Error(res.error || t('预检失败，请重试'));
      setPreflightError('');
      void catalogAvailability.refresh(true);
    } catch (error) {
      setPreflightError((error as Error).message || t('预检失败，请重试'));
    }
  };


  const mutateRuntime = async (
    fn: () => Promise<RuntimeMutationResult>,
    okMsg?: string
  ): Promise<boolean> => {
    try {
      setError('');
      setRuntimeMsg('');
      setRuntimeBusy(true);
      const res = await fn();
      if (res.ok) {
        reloadRuntimes();
        if (okMsg) setRuntimeMsg(okMsg);
        return true;
      }
      if (!res.cancelled) setError(res.error || t('操作失败'));
      return false;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setRuntimeBusy(false);
    }
  };

  const defaultRuntimeInvalid =
    !!cfg.defaultRuntime && !runtimes.some((e) => e.enabled && e.id === cfg.defaultRuntime);

  const renderRuntime = (rt: AgentRuntimeEntry, product?: WorkerProduct): React.JSX.Element => {
    const isGui = runtimeSurface(rt) === 'chat';
    const externalPiId = rt.id === 'pi-external' || rt.id === 'omp' ? rt.id : null;
    const externalHarnessId = rt.id === 'muse-gui' || rt.id === 'zcode-gui' ? rt.id : null;
    const executableId = externalPiId ?? externalHarnessId;
    const configuredExecutable = externalPiId ? cfg.externalPi?.[externalPiId]?.executable ?? ''
      : externalHarnessId ? cfg.externalHarness?.[externalHarnessId]?.executable ?? '' : '';
    const executable = executableId ? (executableDrafts[executableId] ?? configuredExecutable) : '';
    const draft = runtimeDrafts[rt.id] ?? { label: rt.label, extraArgs: formatExtraArgs(rt.extraArgs) };
    return <div className="worker-runtime-connection" role="group" aria-label={t(isGui ? '工作台聊天配置' : '原生终端配置')}>
      {isGui && rt.id !== 'acp' ? <div className="worker-connection-fields">
                    {executableId ? <>
                      <SettingRow title={t('外部引擎程序')} desc={rt.id === 'pi-external'
                        ? t('留空自动发现；指定时需绝对路径。外部 Pi 暂不自动加载扩展（部分版本的内置 MCP 也受影响），保留工作台桥接。')
                        : t('留空自动发现；填写绝对路径时只使用指定程序，不改动引擎自身配置。')}>{null}</SettingRow>
                      <SettingsPathField label={t('可执行文件路径')} path={executable} disabled={runtimeBusy} placeholder={t('留空自动发现')}
                        onChange={value => setExecutableDrafts(previous => ({ ...previous, [executableId]: value }))} action={
                          <button type="button" className="btn tiny" disabled={runtimeBusy || executable.trim() === configuredExecutable}
                            onClick={() => void (async () => {
                              setRuntimeBusy(true); setError(''); setRuntimeMsg('');
                              try {
                                if (externalPiId) {
                                  const result = await window.api.runtimes.setExternalPiExecutable({ id: externalPiId, executable });
                                  if (!result.ok) { setError(result.error); return; }
                                  set({ externalPi: result.externalPi });
                                } else if (externalHarnessId) {
                                  const result = await window.api.runtimes.setExternalHarnessExecutable({ id: externalHarnessId, executable });
                                  if (!result.ok) { setError(result.error); return; }
                                  set({ externalHarness: result.externalHarness });
                                }
                                setExecutableDrafts(previous => { const next = { ...previous }; delete next[executableId]; return next; });
                                setRuntimeMsg(t('程序路径已保存，请手动刷新 Harness 检测结果'));
                              } catch (error) { setError((error as Error).message || String(error)); }
                              finally { setRuntimeBusy(false); }
                            })()}>{t('保存')}</button>
                      }/>
                    </> : null}
                    {isGui && rt.id === 'claude' ? (
                      <ClaudeAccountSettings isolated={!!cfg.claude?.isolateConfig} busy={runtimeBusy} onChange={checked => persistClaude({ isolateConfig: checked })}/>
                    ) : null}
          {rt.id !== 'claude' && !executableId ? <p className="worker-connection-note">{rt.id === 'pi'
            ? t('模型与密钥在「模型服务商」中管理。') : t('沿用此引擎的原生账号与模型配置。')}</p> : null}
      </div> : null}
      {!isGui && rt.id !== 'acp' && (!rt.manifest || rt.builtin) ? <SettingsSection title={t('终端启动参数')}><SettingsRows>
        <FieldRow label={t('额外启动参数（空格分词）')}><input className="s-input mono" aria-label={t('额外启动参数（空格分词）')}
          value={draft.extraArgs} onChange={event => setRuntimeDrafts(previous => ({ ...previous, [rt.id]: { ...draft, extraArgs: event.target.value } }))}/></FieldRow>
        <SettingRow divided title={<span className="s-muted">{t('只影响新启动的原生终端，不改变聊天会话。')}</span>}>
          <button type="button" className="btn tiny" disabled={runtimeBusy}
            onClick={() => void mutateRuntime(() => window.api.runtimes.update({ id: rt.id, extraArgs: parseExtraArgs(draft.extraArgs) }), t('已保存参数'))}>
            {t('保存此项')}
          </button>
        </SettingRow>
      </SettingsRows></SettingsSection> : null}
    </div>;
  };
  const search = query.trim().toLocaleLowerCase();
  const catalogItems = products.filter(product => (catalogTab === 'all' || product.mine)
    && (!search || `${product.name} ${product.entry?.id ?? ''} ${product.runtime ? t('聊天') : ''} ${product.terminal ? t('终端') : ''}`.toLocaleLowerCase().includes(search)));
  const setEndpoint = async (product: WorkerProduct, terminal: boolean, enabled: boolean): Promise<void> => {
    const rt = terminal ? product.terminal : product.runtime;
    if (!rt || runtimeBusy) return;
    if (!terminal && product.acpPresetId) {
      setRuntimeBusy(true); setError(''); setRuntimeMsg('');
      try {
        const disabled = new Set(cfg.disabledAcpAgents ?? []);
        // Bringing back a legacy-disabled shared transport must not enable its other products.
        if (enabled && !rt.enabled) for (const preset of products) if (preset.acpPresetId) disabled.add(preset.acpPresetId);
        if (enabled) disabled.delete(product.acpPresetId); else disabled.add(product.acpPresetId);
        const patch = { disabledAcpAgents: [...disabled] };
        await window.api.config.update(patch); set(patch);
        if (enabled && !rt.enabled) {
          const result = await window.api.runtimes.update({ id: rt.id, enabled: true });
          if (!result.ok) throw new Error(result.error || t('操作失败'));
          reloadRuntimes();
        }
        if (enabled && product.manifestEntry && !product.manifestEntry.manifest?.terminal && !product.manifestEntry.enabled) {
          const result = await window.api.runtimes.update({ id: product.manifestEntry.id, enabled: true });
          if (!result.ok) throw new Error(result.error || t('操作失败'));
          reloadRuntimes();
        }
        setRuntimeMsg(t('使用方式已保存'));
        void catalogAvailability.refresh(true);
      } catch (cause) { setError((cause as Error).message || t('操作失败')); }
      finally { setRuntimeBusy(false); }
    } else {
      if (await mutateRuntime(() => window.api.runtimes.update({ id: rt.id, enabled }), t('使用方式已保存'))) void catalogAvailability.refresh(true);
    }
  };
  const renderInstallation = (product: WorkerProduct, terminal = !product.runtime && !!product.terminal): React.JSX.Element => {
    const check = terminal ? catalogAvailability.snapshot?.runtimePreflights?.[product.terminal?.id ?? ''] : product.check;
    const cliProgram = terminal ? catalogAvailability.snapshot?.cliPrograms?.[product.terminal?.id ?? ''] : undefined;
    const program = terminal ? check?.executable ?? cliProgram?.command : product.executable;
    // Chat and terminal are discovered independently; a CLI command name alone is not proof it exists.
    const installed = terminal && cliProgram ? cliProgram.status === 'found' : check?.status === 'available' || !!(terminal ? check?.executable : product.executable);
    return <>
    <SettingsSection title={t(terminal ? '终端程序' : '程序与连接')}
      desc={t(terminal ? '此处管理原生终端使用的程序；模型和登录由引擎自身配置管理。' : '此处管理工作台聊天使用的引擎程序，原生终端单独配置。')}>
    <div className="worker-install-status">
      {program ? (canRevealSettingsPath(program)
        ? <SettingsPathField label={t(terminal ? '终端程序位置' : '聊天程序位置')} path={program}/>
        : <SettingRow title={t('终端命令')}><code>{program}</code></SettingRow>) : null}
      {check?.problems.map((problem, index) => {
        const link = installationHintUrl(problem.fixHint);
        return <p className="settings-hint" key={index}>{problem.message}{problem.fix ? <> <code>{localizePreflightFix(problem.fix)}</code></> : null}
          {link ? <a href={link} target="_blank" rel="noreferrer">{t('安装或配置指南')}</a> : problem.fixHint ? <span>{problem.fixHint}</span> : null}</p>;
      })}
      {!installed ? <div className="worker-install-actions">
        <button type="button" className="btn tiny" disabled={catalogAvailability.loading} onClick={() => void catalogAvailability.refresh(true)}><IconRefresh size={13}/>{t('重新检测本机')}</button>
        {installationHintUrl(product.installUrl ?? product.entry?.installUrl) ? <a className="btn tiny" href={product.installUrl ?? product.entry?.installUrl} target="_blank" rel="noreferrer">{t('安装指南')}</a> : null}
      </div> : null}
    </div>
    </SettingsSection>
  </>;
  };
  const resources = (): React.JSX.Element => <SettingRow title={t('技能与 MCP')} desc={t('在能力管理中选择技能、MCP 和使用范围。')}>
    {onNavigate ? <button type="button" className="btn tiny" onClick={() => onNavigate('capabilityManagement')}>{t('管理能力')}</button> : null}
  </SettingRow>;
  const renderProduct = (product: WorkerProduct): React.JSX.Element => {
    const core = product.entry?.id === 'muster-core';
    const modes = <div className="worker-mode-rows">
      {product.runtime ? <SettingRow title={t('工作台聊天')} desc={t('在工作台内查看消息、工具记录与审批')}>
        <Switch label={t('启用 {{name}} 工作台聊天', { name: product.name })} disabled={runtimeBusy}
          checked={product.runtime.enabled && (!product.acpPresetId || acpAgentEnabled(cfg, product.acpPresetId)) &&
            (!product.manifestEntry || !!product.manifestEntry.manifest?.terminal || product.manifestEntry.enabled)}
          onChange={enabled => void setEndpoint(product, false, enabled)}/>
      </SettingRow> : null}
      {product.terminal ? <SettingRow title={t('原生终端')} desc={t('在终端内使用引擎自己的交互界面')}>
        <Switch label={t('启用 {{name}} 原生终端', { name: product.name })} disabled={runtimeBusy} checked={product.terminal.enabled}
          onChange={enabled => void setEndpoint(product, true, enabled)}/>
      </SettingRow> : null}
    </div>;
    const models = product.runtime ? <WorkerChatModels cfg={cfg} set={set} runtime={product.runtime} agentId={product.acpPresetId} active={active && selected === product.key}/> : null;
    const relationship = product.entry?.id === 'claude' ? t(cfg.claude?.isolateConfig
      ? '聊天已使用独立配置目录，与原生终端分开。'
      : '聊天默认复用本机 Claude 配置；可在聊天页开启独立配置目录。') : product.entry?.id === 'cursor'
      ? t('聊天通过 Cursor CLI 的 ACP 接入，使用 CLI 登录或 CURSOR_API_KEY 环境变量。')
      : t('聊天与终端分别配置；是否共用账号取决于引擎及其启动环境。');
    return <>
      <WorkerProductHeader product={product}/>
      {core ? <div className="worker-core-settings worker-task-view" data-settings-layout="flat">
        <SettingsDetailSection title={t('基本信息')}>{modes}</SettingsDetailSection>{models}
        <a className="worker-attribution" href="https://github.com/earendil-works/pi" target="_blank" rel="noreferrer">{t('Pi 项目及许可')}</a>
      </div> : <WorkerDetailViews requestedView={focusItem === 'worker-claude-gui' && product.key === 'product:claude' ? 'chat' : undefined} views={[
        { id: 'general', label: t('通用'), content: <>
          <SettingsDetailSection title={t('基本信息')}>{modes}
          <SettingRow title={t('账号与配置')} desc={relationship}/>
          {product.runtime && product.terminal ? <p className="worker-scope-note">{t('模型菜单与参数只作用于工作台聊天；终端启动参数只作用于原生终端。')}</p> : null}
          {!product.runtime && product.terminal ? <p className="worker-scope-note">{t('此接入仅支持原生终端，可以独立使用。')}</p> : null}
          </SettingsDetailSection>
          <SettingsDetailSection title={t('关联资源')}>{resources()}</SettingsDetailSection>
          {product.manifestEntry && !product.manifestEntry.builtin ? <button type="button" className="btn tiny" disabled={runtimeBusy}
            onClick={() => void mutateRuntime(() => window.api.runtimes.remove(product.manifestEntry!.id), t('已移除运行时'))}>{t('移除运行时')}</button> : null}
          {product.check?.problems.length || (!product.runtime && !product.terminal) ? renderInstallation(product) : null}
        </> },
        ...(product.runtime ? [{ id: 'chat', label: t('工作台聊天'), content: <>
          {renderInstallation(product)}{renderRuntime(product.runtime, product)}{models}
        </> }] : []),
        ...(product.terminal ? [{ id: 'terminal', label: t('原生终端'), content: <>
          {renderInstallation(product, true)}{renderRuntime(product.terminal, product)}
        </> }] : [])
      ]}/>}
    </>;
  };
  const pageClass = (id: string): string => `worker-page xfade${selected === id ? ' is-shown' : ''}`;
  return <div className="worker-layout" data-settings-layout="flat" ref={node => { if (node) node.inert = !active; }}>
    <SettingsSection title={t('引擎配置')} item="worker-engines" side={<HarnessCatalogRefresh active={active} detecting={catalogAvailability.loading} />}>
    {catalogAvailability.error ? <ErrorTip message={catalogAvailability.error} /> : null}
    <div className={`worker-pane settings-resource-layout${narrow ? ' is-narrow' : ''}${detailOpen ? ' is-detail-open' : ''}`} ref={paneRef} aria-label={t('Worker 设置')}
      onFocusCapture={() => setResourceFocused(true)} onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setResourceFocused(false);
      }}>
    <nav className={`worker-list settings-resource-nav xfade${!narrow || !detailOpen ? ' is-shown' : ''}`} ref={listRef} aria-label={t('Worker 列表')} aria-hidden={narrow && detailOpen || undefined}>
      <div className="worker-catalog-tabs" aria-label={t('目录范围')}>
        {(['mine', 'all'] as const).map(tab => <button type="button" key={tab} className={catalogTab === tab ? 'is-active' : ''} aria-pressed={catalogTab === tab} onClick={() => setCatalogTab(tab)}>{t(tab === 'mine' ? '我的 Agent' : '全部支持')}</button>)}
      </div>
      <SearchBar aria-label={t('搜索 Agent')} value={query} onChange={setQuery} placeholder={t('搜索名称…')}/>
      <div className="worker-list-scroll settings-resource-items">
        {catalogItems.map(product => { const status = productStatus(product); return <SettingsResourceItem key={product.key}
          name={product.name} selected={selected === product.key} className="worker-list-option"
          data-runtime-id={product.runtime?.id ?? product.terminal?.id} aria-label={t('配置 {{name}}', { name: product.name })}
          icon={<HarnessIcon harnessId={product.entry?.id ?? product.key} size={26}/>}
          meta={<SettingsResourceStatus state={status.cls === 'on' ? 'success' : status.cls === 'warn' ? 'warning' : 'neutral'}>{t(status.text)}</SettingsResourceStatus>}
          onClick={event => choose(product.key, event.currentTarget)}/>; })}
        {!catalogItems.length ? <p className="settings-hint worker-list-empty">{catalogAvailability.loading ? t('检测中…') : t('没有匹配的 Agent')}</p> : null}
      </div>
      <div className="worker-list-footer">
        <button type="button" className={`worker-text-action${selected === 'general' ? ' is-selected' : ''}`} onClick={event => choose('general', event.currentTarget)}><IconSliders size={14}/>{t('默认与通用')}</button>
      </div>
    </nav>
    <div className={`worker-detail settings-resource-detail xfade${!narrow || detailOpen ? ' is-shown' : ''}`} ref={detailRef} tabIndex={-1} aria-label={t('Worker 详情')} aria-hidden={narrow && !detailOpen || undefined}>
      <button type="button" className="worker-back btn ghost tiny" aria-hidden={!narrow} onClick={back}><IconChevronLeft size={14}/>{t('返回 Worker 列表')}</button>
      {preflightError && <><ErrorTip message={preflightError} /><button className="btn tiny" onClick={() => void runPreflight()}>{t('重试')}</button></>}
      {error && <ErrorTip message={error} />}
      {runtimeMsg && <p className="settings-ok" role="status">{runtimeMsg}</p>}
      <SettingsDetailHeadingScope><div className="worker-pages xfade-stack">
        <section className={pageClass('general')} aria-label={t('默认与通用')} aria-hidden={selected !== 'general'} ref={node => { if (node) node.inert = selected !== 'general'; }}>
      <SettingsSection title={t('默认 Worker')}>
      <SettingsRows>
      <SettingRow
        item="worker-default"
        title={t('新建会话默认用')}
        desc={
          defaultRuntimeInvalid
            ? t('当前默认 Worker 未启用或不存在，请改选已启用项。')
            : t('未指定运行方式时使用此默认值；新建对话框优先沿用上次选择。')
        }
      >
        <CustomSelect
          className="s-select is-wide"
          ariaLabel={t('默认 runtime')}
          value={cfg.defaultRuntime}
          onChange={(v) => set({ defaultRuntime: v })}
          options={[
            ...runtimes
              .filter((e) => e.enabled && (!e.manifest || !!e.manifest.terminal))
              .map((e) => ({
                value: e.id,
                label: `${e.label} (${e.id})${runtimeSurface(e) === 'chat' ? ' · GUI' : ''}`
              })),
            ...(defaultRuntimeInvalid
              ? [
                  {
                    value: cfg.defaultRuntime,
                    label: t('{{id}}（未启用或不存在）', { id: cfg.defaultRuntime })
                  }
                ]
              : [])
          ]}
        />
      </SettingRow>
      </SettingsRows>
      </SettingsSection>

      <SettingsSection title={t('注册 Agent Runtime')} desc={t('粘贴运行时的 JSON 声明，确认后即可在 Agent 列表中管理。')}>
        <FieldRow label={t('运行时 JSON 声明')}>
          <textarea className="s-input mono" aria-label={t('运行时 JSON 声明')} rows={5} maxLength={8000}
            value={manifestDraft} onChange={event => setManifestDraft(event.target.value)}/>
        </FieldRow>
        <button type="button" className="btn tiny" disabled={runtimeBusy || !manifestDraft.trim()} onClick={() => void (async () => {
          if (await mutateRuntime(async () => window.api.runtimes.register(normalizeRuntimeManifest(JSON.parse(manifestDraft))), t('已注册运行时'))) {
            setManifestDraft('');
          }
        })()}>{t('注册')}</button>
      </SettingsSection>


        <AdvancedDetails summary={t('维护')}>
          <div className="rt-row-body">
            <SettingRow
              title={t('恢复开箱 runtime')}
              desc={t('恢复内置入口与脚本；不影响已装 CLI')}
            >
              <button
                type="button"
                className="btn tiny"
                disabled={runtimeBusy}
                onClick={() =>
                  void mutateRuntime(
                    () => window.api.runtimes.restoreBuiltins(),
                    t('已恢复开箱种子')
                  )
                }
              >
                {t('恢复开箱')}
              </button>
            </SettingRow>
            <SettingRow
              title={t('清除检测 hooks')}
              desc={t('卸载各 CLI 设置里的可用性预检钩子')}
            >
              <button
                type="button"
                className="btn tiny"
                disabled={runtimeBusy}
                onClick={async () => {
                  try {
                    setError('');
                    setRuntimeMsg('');
                    setRuntimeBusy(true);
                    const res = await window.api.runtimes.clearDetectHooks();
                    if (res.ok) {
                      setRuntimeMsg(
                        res.removed
                          ? t('已清除检测 hooks（移除 {{removed}} 条）', { removed: res.removed })
                          : t('已清除检测 hooks（无可移除条目）')
                      );
                    } else if (!res.cancelled) {
                      setError(res.error || t('清除失败'));
                    }
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setRuntimeBusy(false);
                  }
                }}
              >
                {t('清除')}
              </button>
            </SettingRow>
          </div>
        </AdvancedDetails>
        </section>
        {products.filter(product => visited.includes(product.key)).map(product => <section key={product.key} className={pageClass(product.key)} aria-label={t('{{name}} 设置', { name: product.name })} aria-hidden={selected !== product.key} ref={node => { if (node) node.inert = selected !== product.key; }}>{renderProduct(product)}</section>)}
      </div></SettingsDetailHeadingScope>
    </div>
    </div>
    </SettingsSection>
    <WorkerRoutingPane workspace={routingWorkspace} initialLayer={routingLayer} modelProviders={cfg.llm?.providers}
      active={active} onDraftChange={onRoutingDraftChange} />
  </div>;
}
