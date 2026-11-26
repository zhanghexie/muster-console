import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GuiWorkerMode, LlmProviderConfig } from '../../../shared/types';
import { guiPermissionOptions } from '../../../shared/guiPermissionOptions';
import { resolveModelParameters, type ModelParameterContext, type ModelParameterValues, type ModelParameterProfile } from '../../../shared/modelParameters';
import { CustomSelect } from './CustomSelect';
import { parseModelKey } from '../modelKey';
import type { TaskSourceTarget } from './TaskSourceField';
import { useHarnessModelSelections } from '../hooks/useHarnessModelSelections';
import { harnessModelId, harnessModelSelectionKey, isHarnessModelSelected } from '../../../shared/harnessModelSelection';
import { notifyComposerError } from './agentComposer/composerNotice';
import { localizeGuiHostError } from '../../../shared/guiHostError';

type TaskCatalogRuntime = 'claude' | 'pi-external' | 'omp' | 'muse-gui' | 'zcode-gui';
const TASK_LOCAL_CATALOGS = new Set<string>(['claude', 'pi-external', 'omp', 'muse-gui', 'zcode-gui']);

/** 与 NewTaskDialog 会话态字段对齐：guiMode / Pi·ACP 模式 / 模型 / 思考档 */
export function TaskSessionFields({
  runtime,
  disabled,
  guiMode,
  onGuiMode,
  piMode,
  onPiMode,
  modelKey,
  onModelKey,
  thinking,
  onThinking,
  modelParameters,
  onModelParameters,
  acpAgents = [],
  source
}: {
  runtime: string;
  disabled: boolean;
  guiMode: string;
  onGuiMode: (v: string) => void;
  piMode: string;
  onPiMode: (v: string) => void;
  /** `${providerId}|${modelId}`；空=跟随默认 */
  modelKey: string;
  onModelKey: (v: string) => void;
  thinking: string;
  onThinking: (v: string) => void;
  modelParameters?: ModelParameterValues;
  onModelParameters?: (values: ModelParameterValues) => void;
  acpAgents?: Array<{ id: string; name: string }>;
  source?: TaskSourceTarget;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [piModes, setPiModes] = useState<Array<{ id: string; name: string }> | null>(null);
  const [providers, setProviders] = useState<LlmProviderConfig[]>([]);
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string }>>([]);
  const [loadedCatalogKey, setLoadedCatalogKey] = useState('');
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogRevision, setCatalogRevision] = useState(0);
  const modelSelections = useHarnessModelSelections();
  const catalogRequest = useRef<{ id: string; sequence: number; cancellable: boolean } | null>(null);
  const catalogSequence = useRef(0);
  const pendingStartup = useRef(false);
  const sourceKey = JSON.stringify(source ?? null);
  const catalogKey = JSON.stringify([runtime, runtime === 'acp' ? piMode : '', sourceKey]);
  const catalogKeyRef = useRef(catalogKey);
  catalogKeyRef.current = catalogKey;
  const hasCatalog = runtime === 'codex-gui' || runtime === 'acp' || TASK_LOCAL_CATALOGS.has(runtime);

  useEffect(() => {
    let cancelled = false;
    if (runtime === 'pi') {
      void window.api.agentSession
        .listPiModes()
        .then((r) => {
          if (!cancelled) setPiModes((r ?? []).filter((p) => !p.broken));
        })
        .catch(() => {});
      void window.api.config
        .get()
        .then((cfg) => {
          if (!cancelled) {
            setProviders((cfg.llm?.providers ?? []).filter((p) => p.enabled !== false && p.models?.length));
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  /** Ordinary reads reuse the saved snapshot; only a button click refreshes it. */
  const loadCatalog = async (refresh: boolean): Promise<void> => {
    if (!hasCatalog || !source || (runtime === 'acp' && !piMode) || catalogRequest.current) return;
    const sequence = ++catalogSequence.current;
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
    const request = { id, sequence, cancellable: runtime !== 'codex-gui' };
    catalogRequest.current = request;
    setCatalogBusy(true); setCatalogError('');
    try {
      const selectedModel = parseModelKey(modelKey);
      const selectedModelId = selectedModel?.providerId === runtime ? selectedModel.modelId : undefined;
      const result = runtime === 'codex-gui'
          ? await window.api.agentSession.listCodexModels(source, refresh)
          : runtime === 'acp'
            ? await window.api.agentSession.listAcpModels({ source, agentId: piMode, requestId: id, modelId: selectedModelId, refresh })
            : await window.api.agentSession.listLocalHarnessModels({ source, runtimeId: runtime as TaskCatalogRuntime, requestId: id, refresh });
      if (catalogRequest.current !== request || catalogKeyRef.current !== catalogKey) {
        if (!result.ok && 'cleanupFailed' in result && result.cleanupFailed)
          notifyComposerError(t('模型探测进程回收失败：{{message}}', { message: localizeGuiHostError(result.error) }));
        return;
      }
      if (!result.ok) { setCatalogError(result.error); return; }
      setCatalog(result.items.map(item => ({ id: item.id, name: 'displayName' in item ? item.displayName : item.name })));
      setLoadedCatalogKey(catalogKey);
      if ('warning' in result && result.warning) setCatalogError(result.warning);
      setCatalogRevision(value => value + 1);
    } catch (error) {
      if (catalogRequest.current === request && catalogKeyRef.current === catalogKey) setCatalogError((error as Error).message || String(error));
    } finally {
      if (catalogRequest.current === request) {
        catalogRequest.current = null;
        if (catalogKeyRef.current === catalogKey) {
          setCatalogBusy(false);
          if (pendingStartup.current) { pendingStartup.current = false; void loadCatalog(false); }
        }
      }
    }
  };

  useEffect(() => {
    setCatalog([]); setLoadedCatalogKey(''); setCatalogBusy(false); setCatalogError('');
    if (hasCatalog && source && (runtime !== 'acp' || piMode)) void loadCatalog(false);
    return () => {
      const request = catalogRequest.current;
      catalogRequest.current = null;
      pendingStartup.current = false;
      if (request?.cancellable) void window.api.agentSession.cancelHarnessModels(request.id)
        .catch(error => console.warn('模型目录取消失败', error));
    };
  }, [catalogKey]);

  useEffect(() => {
    if (!hasCatalog || !source) return;
    let live = true;
    const off = window.api.on('agentSession:modelCatalogUpdated', event => {
      if (!live || event.error || event.runtimeId !== runtime || (runtime === 'acp' && event.agentId !== piMode) ||
          (event.workspaceId !== source.workspaceId || event.rootId !== source.rootId)) return;
      if (event.requestId && event.requestId === catalogRequest.current?.id) return;
      if (catalogRequest.current) pendingStartup.current = true;
      else void loadCatalog(false);
    });
    return () => { live = false; off(); };
  }, [catalogKey]);

  const providerModelOptions = providers.flatMap((p) =>
    (p.models ?? []).map((m) => ({
      value: `${p.id}|${m.id}`,
      label: `${p.name || p.id} · ${m.name || m.id}`
    }))
  );
  const selectionKey = harnessModelSelectionKey(runtime, runtime === 'acp' ? piMode : undefined);
  const selectedIds = Object.hasOwn(modelSelections.selections, selectionKey) ? modelSelections.selections[selectionKey] : undefined;
  const manual = runtime === 'glm' || runtime === 'mimo';
  const rawModelOptions = runtime === 'pi' ? providerModelOptions
    : manual && selectedIds !== undefined ? selectedIds.map(id => ({ value: `${runtime}|${id}`, label: id }))
      : loadedCatalogKey === catalogKey ? catalog.map(item => ({ value: `${runtime}|${item.id}`, label: item.name })) : [];
  const modelOptions = modelSelections.ready ? rawModelOptions.filter(option => {
    const model = parseModelKey(option.value);
    return !!model?.modelId && isHarnessModelSelected(modelSelections.selections, selectionKey, harnessModelId(runtime, model.providerId, model.modelId));
  }) : [];
  const selectedModel = parseModelKey(modelKey);
  const selectedModelAllowed = !modelKey || !!selectedModel && modelSelections.ready &&
    isHarnessModelSelected(modelSelections.selections, selectionKey, harnessModelId(runtime, selectedModel.providerId, selectedModel.modelId));
  const selectedModelMissing = !!modelKey && !modelOptions.some(option => option.value === modelKey);
  const selectedModelLabel = rawModelOptions.find(option => option.value === modelKey)?.label ?? selectedModel?.modelId ?? modelKey;
  const modelFollowLabel = runtime === 'pi' ? t('跟随全局激活服务商') : t('跟随引擎默认');
  const manualInput = manual && modelSelections.ready && selectedIds === undefined &&
    (!modelKey || selectedModel?.providerId === runtime);
  const permissionOptions = guiPermissionOptions(runtime, guiMode ? guiMode as GuiWorkerMode : undefined);
  const unsupportedPermission = !!guiMode && !permissionOptions.some(option => option.mode === guiMode && !option.disabled);

  return (
    <>
      {runtime === 'pi' ? <div>
        <label>{t('权限档')}</label>
        <CustomSelect
          ariaLabel={t('权限档')}
          disabled={disabled}
          value={guiMode}
          onChange={onGuiMode}
          options={[
            { value: '', label: t('跟随默认') },
            ...permissionOptions.filter(option => !option.disabled || option.mode === guiMode).map(option => ({
              value: option.mode,
              label: option.disabled ? t('{{mode}}（不支持，请另选）', { mode: t(option.label) }) : t(option.label),
              disabled: option.disabled || option.legacy
            }))
          ]}
        />
        {unsupportedPermission ? <span role="alert">{t('当前引擎不支持此权限档，请重新选择')}</span> : null}
      </div> : null}
      {runtime === 'pi' ? (
        <div>
          <label>{t('引擎模式')}</label>
          <CustomSelect
            ariaLabel={t('引擎模式')}
            disabled={disabled}
            value={piMode}
            onChange={onPiMode}
            options={[
              { value: '', label: t('标准（无自定义模式）') },
              ...(piModes ?? []).map((p) => ({ value: p.id, label: p.name }))
            ]}
          />
        </div>
      ) : null}
      {runtime === 'acp' ? (
        <div>
          <label>{t('ACP 引擎')}</label>
          <CustomSelect
            ariaLabel={t('ACP 引擎')}
            disabled={disabled}
            value={piMode}
            onChange={onPiMode}
            placeholder={piMode ? t('{{label}}（当前不可用）', { label: piMode }) : t('跟随默认')}
            options={acpAgents.map((p) => ({ value: p.id, label: p.name }))}
          />
        </div>
      ) : null}
      {manualInput ? <div>
        <label>{t('会话模型')}</label>
        <input className="s-input mono" aria-label={t('会话模型')} disabled={disabled} maxLength={512}
          placeholder={t('留空使用服务默认模型')} value={modelKey.startsWith(`${runtime}|`) ? modelKey.slice(runtime.length + 1) : ''}
          onChange={event => onModelKey(event.target.value ? `${runtime}|${event.target.value}` : '')} />
      </div> : hasCatalog || runtime === 'pi' || manual || !!modelKey ? (
        <div>
          <label>{t('会话模型')}</label>
          <CustomSelect
            ariaLabel={t('会话模型')}
            disabled={disabled}
            value={modelKey}
            onChange={onModelKey}
            options={[
              { value: '', label: modelFollowLabel },
              ...(selectedModelMissing ? [{ value: modelKey, label: t('{{model}}（{{reason}}）', {
                model: selectedModelLabel,
                reason: modelSelections.ready && !selectedModelAllowed ? t('当前已隐藏') : t('当前目录未确认')
              }), disabled: true }] : []),
              ...modelOptions
            ]}
          />
        </div>
      ) : null}
      {hasCatalog ? <div>
        <button type="button" className="btn tiny" disabled={disabled || catalogBusy || !source || (runtime === 'acp' && !piMode)}
          onClick={() => void loadCatalog(true)}>{catalogBusy ? t('读取中…') : t('刷新模型目录')}</button>
        {catalogError ? <span role="status">{localizeGuiHostError(catalogError)}</span> : null}
      </div> : null}
      {modelSelections.error ? <span role="status">{modelSelections.error}</span> : null}
      <TaskModelParameterFields runtime={runtime} modelKey={modelKey} piMode={piMode} disabled={disabled}
        source={source} values={modelParameters} legacyThinking={thinking} catalogRevision={catalogRevision} onChange={values => {
          if (onModelParameters) onModelParameters(values); else onThinking(values.reasoning ?? '');
        }} />
    </>
  );
}

/** Resolve exactly the selected runtime/model, including any user-visible parameter aliases. */
export function useTaskModelParameterState({ runtime, modelKey, piMode, cwd, source, values, onChange, legacyThinking, enabled = true, catalogRevision = 0, preserveOverrides = false }: {
  runtime: string; modelKey: string; piMode?: string; values?: ModelParameterValues;
  onChange: (values: ModelParameterValues) => void; legacyThinking?: string; cwd?: string; source?: TaskSourceTarget; enabled?: boolean; catalogRevision?: number; preserveOverrides?: boolean;
}) {
  const { t } = useTranslation();
  const [context, setContext] = useState<ModelParameterContext | null>(null);
  const [profiles, setProfiles] = useState<ModelParameterProfile[]>([]);
  const [error, setError] = useState('');
  const [resolvedKey, setResolvedKey] = useState('');
  const [requestState, setRequestState] = useState({ key: '', loading: false });
  const [coreCatalogRevision, setCoreCatalogRevision] = useState(0);
  const sourceKey = JSON.stringify(source ?? null);
  const requestKey = JSON.stringify([runtime, modelKey, piMode ?? '', cwd ?? '', sourceKey, enabled]);
  useEffect(() => {
    if (!enabled || runtime !== 'pi') return;
    return window.api.on('agentSession:coreReasoningCatalogUpdated', () => setCoreCatalogRevision(value => value + 1));
  }, [enabled, runtime]);
  useEffect(() => {
    let cancelled = false;
    setContext(null); setError('');
    if (!enabled) { setRequestState({ key: requestKey, loading: false }); return () => { cancelled = true; }; }
    setRequestState({ key: requestKey, loading: true });
    const { providerId, modelId } = parseModelKey(modelKey) ?? {};
    const describe = window.api.agentSession.describeModelParameters({ runtimeId: runtime, ...(providerId ? { providerId, modelId } : {}), piModeId: piMode,
      ...(cwd ? { cwd } : {}), ...(source ? { source } : {}) });
    void Promise.all([describe, window.api.config.get()]).then(([next, cfg]) => {
      if (cancelled) return;
      setContext(next); setProfiles(cfg.modelParameterProfiles ?? []); setResolvedKey(requestKey); setError(next?.warning ?? '');
    }).catch(e => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setRequestState({ key: requestKey, loading: false }); });
    return () => { cancelled = true; };
  }, [runtime, modelKey, piMode, cwd, sourceKey, enabled, catalogRevision, coreCatalogRevision]);
  const reasoning = context?.parameters.find(d => d.semantic === 'reasoning')?.id;
  const snapshot = enabled && resolvedKey === requestKey && context ? resolveModelParameters({ ...context, ...(values === undefined && legacyThinking && reasoning ? { legacyValues: { [reasoning]: legacyThinking } } : {}) }, profiles, values ?? {}) : null;
  useEffect(() => {
    if (preserveOverrides || !context || !snapshot || context.unavailable || context.runtimeId !== runtime || values === undefined) return;
    const next = Object.fromEntries(Object.entries(values).filter(([id, value]) => snapshot?.controls.some(c => c.descriptor.id === id && c.descriptor.options.some(o => o.value === value))));
    if (Object.keys(next).length !== Object.keys(values).length) { setError(t('已清除当前模型不支持的参数')); onChange(next); }
  }, [context, runtime, values, onChange, snapshot, preserveOverrides]);
  const loading = enabled && (requestState.key !== requestKey || requestState.loading);
  return { snapshot, error, loading };
}

/** Creation and scheduled tasks use the same runtime-neutral controls as live sessions. */
export function TaskModelParameterFields({ runtime, modelKey, piMode, cwd, source, disabled, values, onChange, legacyThinking, catalogRevision }: {
  runtime: string; modelKey: string; piMode?: string; disabled: boolean; values?: ModelParameterValues; source?: TaskSourceTarget;
  onChange: (values: ModelParameterValues) => void; legacyThinking?: string; cwd?: string; catalogRevision?: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const needsSource = runtime === 'claude' || runtime === 'acp' || runtime === 'codex-gui';
  const model = parseModelKey(modelKey);
  const validModelIdentity = !modelKey || !!model?.modelId && (runtime === 'pi' || model.providerId === runtime);
  const { snapshot, error } = useTaskModelParameterState({ runtime, modelKey, piMode, cwd, source, values, onChange, legacyThinking, catalogRevision,
    enabled: validModelIdentity && (!needsSource || !!source) && (runtime !== 'acp' || !!piMode) });
  return <>{snapshot?.controls.map(control => <div key={control.descriptor.id} className="new-task-field">
    <label>{control.descriptor.label}</label>
    <CustomSelect ariaLabel={control.descriptor.label} menuClassName="task-options-menu" disabled={disabled} value={control.override ?? ''}
      onChange={value => { const next = { ...(values ?? {}) }; if (value) next[control.descriptor.id] = value; else delete next[control.descriptor.id]; onChange(next); }}
      options={[...(control.descriptor.supportsDefault ? [{ value: '', label: t('跟随默认') }] : []), ...control.descriptor.options.map(o => ({ value: o.value, label: o.label }))]} />
  </div>)}{error && <p className="hint" role="status">{error}</p>}</>;
}

