import { ErrorTip } from '../ErrorTip';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageKind, UsageSnapshot, UsageState, UsageScope } from '../../../../shared/capabilityUsage';
import { CustomSelect } from '../CustomSelect';
import { SearchBar } from '../SearchBar';
import { Segmented } from './shared';
import './capability-usage.css';

export interface CapabilityUsagePanelProps {
  runtimeId?: string;
  workspaceId?: string;
  workspaces?: Array<{ id: string; name: string }>;
  kind?: UsageKind;
  /** '*' renders only the category control; otherwise one resource, or the full list. */
  resourceId?: string;
  compact?: boolean;
  active?: boolean;
}

export function CapabilityUsagePanel({ runtimeId, workspaceId, workspaces, kind, resourceId, compact = false, active = true }: CapabilityUsagePanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<UsageKind>(kind ?? 'skill');
  const selectedKind = kind ?? tab;
  const [workspaceChoice, setWorkspaceChoice] = useState('');
  const contextWorkspace = workspaceId ?? (workspaceChoice || undefined);
  const initialScope = runtimeId ? `harness:${runtimeId}` : workspaceId ? 'workspace' : 'global';
  const [scopeChoice, setScopeChoice] = useState(initialScope);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const writing = useRef(false);
  const effectiveScope = scopeChoice === 'workspace' && !contextWorkspace ? 'global' : scopeChoice;
  const contextRuntime = effectiveScope.startsWith('harness:') ? effectiveScope.slice(8) : runtimeId;
  const key = JSON.stringify([selectedKind, contextRuntime, contextWorkspace, resourceId]);
  const currentKey = useRef(key); currentKey.current = key;
  const read = useCallback(async () => {
    if (!active) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const next = await window.api.capabilityManagement.usageList({ kind: selectedKind, runtimeId: contextRuntime, workspaceId: contextWorkspace });
      if (!next || !Array.isArray(next.resources)) throw new Error(t('无法读取能力使用设置。'));
      if (mounted.current && request === generation.current) { setSnapshot(next); setError(''); }
    } catch (e) { if (mounted.current && request === generation.current) setError((e as Error).message); }
    finally { if (mounted.current && request === generation.current) setLoading(false); }
  }, [active, selectedKind, contextRuntime, contextWorkspace, t]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { setSnapshot(null); setSelected([]); void read(); return () => { generation.current++; }; }, [read, resourceId]);
  useEffect(() => window.api.on('capabilityManagement:changed', () => { if (!writing.current) void read(); }), [read]);
  const scope: UsageScope = effectiveScope.startsWith('harness:') ? { kind: 'harness', runtimeId: effectiveScope.slice(8) } : effectiveScope === 'workspace' && contextWorkspace ? { kind: 'workspace', workspaceId: contextWorkspace } : { kind: 'global' };
  const change = async (ids: string[], enabled: boolean): Promise<void> => {
    if (!snapshot || writing.current) return;
    const origin = key;
    writing.current = true; setBusy(true); setError('');
    try {
      await window.api.capabilityManagement.usageSet({ kind: selectedKind, scope, resourceIds: ids, enabled, expectedRevision: snapshot.revision });
      if (mounted.current && currentKey.current === origin) { setSelected([]); await read(); }
    } catch (e) { if (mounted.current && currentKey.current === origin) setError((e as Error).message); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  };
  const localEnabled = (state: UsageState): boolean => scope.kind === 'global' ? state.globalEnabled : scope.kind === 'harness' ? state.harnessEnabled : state.workspaceEnabled;
  const reason = (state: UsageState): string => state.blockedBy === 'global' ? t('已关闭 · 全局') : state.blockedBy === 'harness' ? t('已关闭 · 此 Harness') : state.blockedBy === 'workspace' ? t('已关闭 · 当前工作区') : state.blockedBy === 'configuration' ? t('配置或来源未启用') : t('允许使用');
  const blockedAbove = (state: UsageState): boolean => scope.kind !== 'global' && !state.globalEnabled;
  const renderSwitch = (id: string, name: string, state: UsageState): React.JSX.Element => <div className="usage-row" key={id}>
    {!resourceId && bulkMode && id !== '*' && <label className="settings-check usage-selection"><input type="checkbox" aria-label={`${t('选择')} ${name}`} checked={selected.includes(id)} disabled={busy || loading} onChange={e => setSelected(values => e.target.checked ? [...values, id] : values.filter(value => value !== id))}/><span>{t('选择')}</span></label>}
    <div className="usage-row-copy"><strong>{name}</strong><span>{reason(state)}{state.categoryBlocked ? ` · ${t('类别开关已关闭')}` : ''}</span></div>
    {state.blockedBy === 'global' && scope.kind !== 'global' && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setScopeChoice('global')}>{t('查看全局设置')}</button>}
    <label className="usage-toggle"><input type="checkbox" aria-label={`${t('允许使用')} ${name}`} checked={localEnabled(state) && !blockedAbove(state)} disabled={busy || loading || blockedAbove(state) || state.categoryBlocked || state.blockedBy === 'configuration'} onChange={e => { void change([id], e.target.checked); }}/><span>{scope.kind === 'global' ? t('全局允许') : t('本层允许')}</span></label>
    {!localEnabled(state) && !blockedAbove(state) && !state.categoryBlocked && <button type="button" className="btn btn-ghost" disabled={busy || loading} onClick={() => { void change([id], true); }}>{t('恢复本层允许')}</button>}
  </div>;
  const resources = snapshot?.resources.filter(resource => resource.kind === selectedKind && (!resourceId || resource.id === resourceId) && (!query || resource.name.toLowerCase().includes(query.toLowerCase()))) ?? [];
  const scopeOptions = [{ value: 'global', label: t('全局') }, ...(snapshot?.runtimes ?? []).filter(runtime => !runtimeId || runtime.id === runtimeId).map(runtime => ({ value: `harness:${runtime.id}`, label: runtime.label })), ...(contextWorkspace ? [{ value: 'workspace', label: t('当前工作区') }] : [])];
  return <section className={`capability-usage${compact ? ' is-compact' : ''}`} aria-label={t('能力使用设置')}>
    <div className="usage-heading"><strong>{t('使用范围')}</strong>{!kind && <Segmented label={t('能力类别')} disabled={busy} value={selectedKind} onChange={setTab} options={[{ value: 'skill', label: 'Skills' }, { value: 'mcp', label: 'MCP' }]}/>}<CustomSelect ariaLabel={t('编辑使用范围')} value={effectiveScope} disabled={busy} onChange={setScopeChoice} options={scopeOptions}/>
      {workspaces && !workspaceId && <CustomSelect ariaLabel={t('查看工作区使用状态')} value={workspaceChoice} disabled={busy} onChange={setWorkspaceChoice} options={[{ value: '', label: t('全局资源') }, ...workspaces.map(item => ({ value: item.id, label: item.name }))]}/>}</div>
    <div className="settings-group-body">
    {error && <><ErrorTip message={error} /><button type="button" className="btn btn-ghost" disabled={busy || loading} onClick={() => { void read(); }}>{t('刷新')}</button></>}
    {loading && !snapshot && <p role="status">{t('正在读取使用设置…')}</p>}
    {snapshot && (!resourceId || resourceId === '*' || resources.some(resource => resource.state.categoryBlocked)) && renderSwitch('*', selectedKind === 'skill' ? t('Skills 总开关') : t('MCP 使用开关'), snapshot.categories[selectedKind])}
    {!resourceId && <><div className="usage-heading"><SearchBar aria-label={t('搜索可用能力')} value={query} onChange={setQuery} placeholder={t('搜索名称…')}/><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setBulkMode(value => !value); setSelected([]); }}>{bulkMode ? t('结束选择') : t('批量管理')}</button></div>{selected.length > 0 && <div className="usage-bulk"><span>{t('已选择')} {selected.length}</span><button className="btn" disabled={busy || loading} onClick={() => { void change(selected, false); }}>{t('批量关闭')}</button><button className="btn" disabled={busy || loading} onClick={() => { void change(selected, true); }}>{t('恢复本层允许')}</button></div>}</>}
    <div className="usage-resources">{resources.map(resource => renderSwitch(resource.id, resource.name, resource.state))}</div>
    {snapshot && resourceId !== '*' && !resources.length && <p className="usage-note">{t('此范围没有匹配的资源。')}</p>}
    <p className="usage-note">{t('全局、Harness、工作区任一关闭即停止提供；开启仅解除本层限制，不安装或关联资源。')}</p>
    {selectedKind === 'skill' && (resourceId === '*' || resources.some(resource => resource.externalDiscovery)) && <p className="usage-note">{t('仅控制工作台提供的技能；外部 CLI 仍可能读取原生目录。已进入会话上下文的内容无法撤回，新设置在重新加载后生效。')}</p>}
    </div>
  </section>;
}
