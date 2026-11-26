import { ErrorTip } from '../ErrorTip';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig, WorkspaceRoot } from '../../../../shared/types';
import { defaultRootFor, sourceRootsFor } from '../../../../shared/workspaceRoots';
import { harnessModelId, harnessModelSelectionKey, isHarnessModelSelected } from '../../../../shared/harnessModelSelection';
import { useHarnessModelSelections } from '../../hooks/useHarnessModelSelections';
import { CustomSelect } from '../CustomSelect';
import { SettingsSection } from './shared';
import { SettingsPathControl } from './SettingsPathField';
import { notifyComposerError } from '../agentComposer/composerNotice';
import { localizeGuiHostError } from '../../../../shared/guiHostError';
import type { HarnessModelGroup } from '../../../../shared/harnessPicker';
import { pickerModelGroups, pickerModelRows, pickerModelTitle } from '../../../../shared/harnessModelPresentation';

export interface HarnessSettingsModel { id: string; name: string; providerId?: string; modelId?: string; group?: HarnessModelGroup; nativeLaunchModel?: string }
type ModelRow = HarnessSettingsModel;
const LOCAL_RUNTIMES = new Set(['claude', 'pi-external', 'omp', 'muse-gui', 'zcode-gui']);

export function HarnessModelSelectionPanel({ cfg, runtimeId, agentId, acpAgents, active, compact = false, onCatalogChange }: {
  cfg: AppConfig; runtimeId: string; agentId?: string; acpAgents?: Array<{ id: string; name: string }>; active: boolean; compact?: boolean; onCatalogChange?: (models: HarnessSettingsModel[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { selections, setSelections, error: selectionError, ready, revision } = useHarnessModelSelections(active);
  const [chosenAgentId, setChosenAgentId] = useState('');
  const currentAgentId = agentId || chosenAgentId;
  const agentMissing = runtimeId === 'acp' && !currentAgentId;
  const key = harnessModelSelectionKey(runtimeId, currentAgentId);
  const local = runtimeId === 'pi';
  const supportsCatalog = runtimeId === 'codex-gui' ||
    (runtimeId === 'acp' && !!currentAgentId) || LOCAL_RUNTIMES.has(runtimeId);
  const workspace = cfg.workspaces.find(item => item.id === cfg.activeWorkspaceId);
  const sourceInfo = useMemo((): { roots: readonly WorkspaceRoot[]; defaultId?: string; error?: string } => {
    if (!workspace) return { roots: [], error: t('请先打开工作区') };
    try { return { roots: sourceRootsFor(workspace), defaultId: defaultRootFor(workspace).id }; }
    catch (error) { return { roots: [], error: (error as Error).message || String(error) }; }
  }, [workspace, t]);
  const [selectedRootId, setSelectedRootId] = useState('');
  const root = sourceInfo.roots.find(item => item.id === selectedRootId) ?? sourceInfo.roots.find(item => item.id === sourceInfo.defaultId);
  const [items, setItems] = useState<ModelRow[]>([]);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [catalogReady, setCatalogReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const sequence = useRef(0);
  const requestId = useRef<string | null>(null);
  const pendingStartup = useRef(false);
  const mounted = useRef(true);
  const source = workspace && root ? { workspaceId: workspace.id, rootId: root.id, rootsRevision: workspace.rootsRevision } : undefined;
  const catalogIdentity = JSON.stringify([runtimeId, currentAgentId, workspace?.id, root?.id, root?.path, workspace?.rootsRevision]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = async (refresh: boolean): Promise<void> => {
    if (!active || !supportsCatalog || !source || requestId.current) return;
    const seq = ++sequence.current;
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2)}`;
    requestId.current = id;
    setLoading(true); setError('');
    try {
      const result = runtimeId === 'codex-gui'
          ? await window.api.agentSession.listCodexModels(source, refresh)
          : runtimeId === 'acp'
            ? await window.api.agentSession.listAcpModels({ source, agentId: currentAgentId, requestId: id, refresh })
            : await window.api.agentSession.listLocalHarnessModels({ source, runtimeId: runtimeId as 'claude' | 'pi-external' | 'omp' | 'muse-gui' | 'zcode-gui', requestId: id, refresh });
      if (!mounted.current || sequence.current !== seq) {
        if (!result.ok && 'cleanupFailed' in result && result.cleanupFailed) {
          notifyComposerError(t('模型探测进程回收失败：{{message}}', { message: localizeGuiHostError(result.error) }));
        }
        return;
      }
      if (!result.ok) { setError(result.error); return; }
      setItems(result.items.map(item => ({ id: item.id, name: 'displayName' in item ? item.displayName : item.name,
        ...('group' in item && item.group ? { group: item.group } : {}),
        ...('resolvedModel' in item && typeof item.resolvedModel === 'string' ? { nativeLaunchModel: item.resolvedModel } : {}) })));
      setLoadedIdentity(catalogIdentity);
      setCatalogReady(true);
      if ('warning' in result && result.warning) setError(result.warning);
    } catch (cause) {
      if (mounted.current && sequence.current === seq) setError((cause as Error).message || String(cause));
    } finally {
      if (requestId.current === id) requestId.current = null;
      if (mounted.current && sequence.current === seq) {
        setLoading(false);
        if (pendingStartup.current) { pendingStartup.current = false; void load(false); }
      }
    }
  };

  useEffect(() => {
    setItems([]); setLoadedIdentity(''); setCatalogReady(false); setLoading(false); setError(''); setQuery('');
    if (active && supportsCatalog && source) void load(false);
    return () => {
      sequence.current++;
      const id = requestId.current;
      requestId.current = null;
      pendingStartup.current = false;
      if (id && runtimeId !== 'codex-gui') {
        void window.api.agentSession.cancelHarnessModels(id).catch(cause => notifyComposerError((cause as Error).message || String(cause)));
      }
    };
  }, [active, catalogIdentity]);

  useEffect(() => {
    if (!active || !source) return;
    return window.api.on('agentSession:modelCatalogUpdated', event => {
      if (event.runtimeId !== runtimeId || event.error || (runtimeId === 'acp' && event.agentId !== currentAgentId) ||
          (event.workspaceId !== source.workspaceId || event.rootId !== source.rootId)) return;
      if (event.requestId && event.requestId === requestId.current) return;
      if (requestId.current) pendingStartup.current = true;
      else void load(false);
    });
  }, [active, catalogIdentity]);

  const catalog = useMemo<ModelRow[]>(() => local
    ? (cfg.llm?.providers ?? []).filter(provider => provider.enabled !== false).flatMap(provider =>
      (provider.models ?? []).map(model => ({ id: harnessModelId('pi', provider.id, model.id), name: model.name || model.id,
        providerId: provider.id, modelId: model.id, group: { id: provider.id, label: provider.name || provider.id } })))
    : loadedIdentity === catalogIdentity ? items : [], [local, cfg.llm?.providers, loadedIdentity, catalogIdentity, items]);
  useEffect(() => { onCatalogChange?.(catalog); }, [catalog, onCatalogChange]);
  const selected = !agentMissing && Object.hasOwn(selections, key) ? selections[key] : undefined;
  const known = new Set(catalog.map(item => item.id));
  const missing: ModelRow[] = (selected ?? []).filter(id => !known.has(id)).map(id => ({ id, name: id }));
  const missingIds = new Set(missing.map(item => item.id));
  const rows = pickerModelRows([...catalog, ...missing].map(item => ({ ...item, label: item.name,
    providerId: item.providerId ?? runtimeId, modelId: item.modelId ?? item.id })))
    .filter(item => [item.label, item.group?.label, item.group?.id, item.detail, item.id, item.modelId, item.nativeLaunchModel]
      .some(value => value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));

  const save = async (modelIds: string[] | null): Promise<boolean> => {
    if (busy || !ready) return false;
    setBusy(true); setError('');
    const savedAt = revision.current;
    try {
      const saved = await window.api.agentSession.setHarnessModelSelection({ key, modelIds });
      if (mounted.current && revision.current === savedAt) setSelections(saved);
      return true;
    } catch (cause) { if (mounted.current) setError((cause as Error).message || String(cause)); return false; }
    finally { if (mounted.current) setBusy(false); }
  };
  const toggle = (id: string, checked: boolean): void => {
    const baseline = selected ?? catalog.map(item => item.id);
    void save(checked ? [...new Set([...baseline, id])] : baseline.filter(item => item !== id));
  };

  return <SettingsSection title={t('可用模型')} desc={t('勾选在新建会话的模型菜单中显示的项。不会更改引擎默认模型或已有会话。')}
    side={supportsCatalog ? <button type="button" className="btn tiny" disabled={loading || !source} onClick={() => void load(true)}>{loading ? t('读取中…') : t('刷新模型目录')}</button> : undefined}>
    <div className="harness-model-settings">
      {runtimeId === 'acp' && !agentId ? <CustomSelect ariaLabel={t('选择 ACP Harness')} value={chosenAgentId}
        placeholder={t('选择 ACP Harness')} options={(acpAgents ?? []).map(item => ({ value: item.id, label: item.name }))} onChange={setChosenAgentId}/> : null}
      {supportsCatalog && sourceInfo.roots.length > 1 ? <CustomSelect ariaLabel={t('模型目录来源')} value={root?.id ?? ''}
        options={sourceInfo.roots.map(item => ({ value: item.id, label: item.path }))} onChange={setSelectedRootId}/> : null}
      {supportsCatalog && root && !compact ? <SettingsPathControl label={t('模型目录来源')} path={root.path}/> : null}
      <div className="harness-model-actions">
        <input type="search" className="s-input" aria-label={t('搜索模型')} placeholder={t('搜索模型')} value={query} onChange={event => setQuery(event.target.value)}/>
        <button type="button" className="btn tiny" disabled={agentMissing || busy || !ready || (!catalog.length && !missing.length)} onClick={() => void save([])}>{t('全部取消')}</button>
        <button type="button" className="btn tiny" disabled={agentMissing || busy || !ready || selected === undefined} onClick={() => void save(null)}>{t('恢复全部')}</button>
      </div>
      {ready && !agentMissing ? <div className="harness-model-note">{selected === undefined
        ? t('显示全部模型') : t('已选择 {{count}} 个模型', { count: selected.length })}</div> : null}
      {!ready && !selectionError ? <div className="harness-model-note">{t('读取模型设置中…')}</div> : null}
      {selectionError || error || (supportsCatalog && !source ? sourceInfo.error : '') ? <ErrorTip message={localizeGuiHostError(selectionError || error || sourceInfo.error || '')} /> : null}
      {supportsCatalog && !catalogReady && !loading && !error ? <div className="harness-model-note">{t('尚未读取此目录，请手动刷新模型目录。')}</div> : null}
      {!agentMissing && !supportsCatalog && !local ? <div className="harness-model-note">{t('此引擎暂未提供可读取的模型目录。')}</div> : null}
      {ready && supportsCatalog && catalogReady && !loading && !error && !rows.length && !query ? <div className="harness-model-note">{t('目录暂未返回模型，可刷新目录或在引擎中检查模型配置。')}</div> : null}
      {rows.length ? <div className="harness-model-groups">{pickerModelGroups(rows).map(section => <div key={section.group?.id ?? ''}
        role={section.group ? 'group' : undefined} aria-label={section.label}>
        {section.group ? <div className="model-catalog-group-heading">{section.label}</div> : null}
        <div className="harness-model-list">{section.items.map(item => <label className="harness-model-item" key={item.id} title={pickerModelTitle(item)}>
          <input type="checkbox" checked={isHarnessModelSelected(selections, key, item.id)} disabled={busy || !ready}
            onChange={event => toggle(item.id, event.target.checked)}/>
          <span className="model-catalog-entry"><span className="model-catalog-name">{item.name}</span>{' '}
            {missingIds.has(item.id) ? <small className="model-catalog-detail">{t('当前目录未确认')}</small>
              : item.detail ? <small className="model-catalog-detail">{item.detail}</small> : null}
          </span>
        </label>)}</div>
      </div>)}</div> : null}
      {ready && !rows.length && query ? <div className="harness-model-note">{t('没有匹配的模型')}</div> : null}
    </div>
  </SettingsSection>;
}
