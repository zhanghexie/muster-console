import { ErrorTip } from './ErrorTip';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  HarnessPickerCatalog, HarnessPickerChoice, HarnessPickerIdentity, HarnessPickerModel,
  HarnessPickerModelIdentity, HarnessPickerRequest
} from '../../../shared/harnessPicker';
import type { ModelParameterValues } from '../../../shared/modelParameters';
import { randomUuid } from '../../../shared/randomUuid';
import { localizeGuiHostError } from '../../../shared/guiHostError';
import { HARNESS_CATALOG } from '../../../shared/harnessCatalog';
import { firstGrapheme } from '../../../shared/userAvatar';
import { HarnessIcon } from './HarnessIcon';
import { ModelPickerLayout, ModelPickerParameterFields } from './ModelPickerLayout';
import { OperationButton } from './OperationButton';
import { pickerModelGroups, pickerModelRows, pickerModelSelectionLabel, pickerModelTitle } from '../../../shared/harnessModelPresentation';
export { pickerModelRows } from '../../../shared/harnessModelPresentation';

type Source = Extract<HarnessPickerRequest, { source: unknown }>['source'];
export type PickerBoundTarget = { sessionId: string } | { dispatch: { workspaceId: string } };

export interface PickerInitialSelection {
  harness?: HarnessPickerIdentity;
  model?: HarnessPickerModelIdentity | null;
  parameters?: ModelParameterValues;
  nativeLaunchModel?: string;
}

export interface PickerSelection {
  harness: HarnessPickerIdentity;
  harnessLabel: string;
  model: HarnessPickerModel | null;
  parameters: ModelParameterValues;
  nativeLaunchModel?: string;
  catalog: HarnessPickerCatalog;
}

const identityKey = (harness?: HarnessPickerIdentity): string => harness
  ? JSON.stringify([harness.surface, harness.harnessId, harness.runtimeId, harness.acpPresetId ?? '']) : '';
const modelKey = (model?: HarnessPickerModelIdentity | null): string => model
  ? JSON.stringify([model.providerId, model.modelId]) : model === null ? 'default' : '';

interface Props {
  target: { source: Source; surface: HarnessPickerIdentity['surface'] } | PickerBoundTarget;
  initial?: PickerInitialSelection;
  surfaceSelection?: { cliDisabledReason?: string };
  exact?: boolean;
  disabled?: boolean;
  active?: boolean;
  confirmLabel: string;
  defaultLabel?: string;
  manualModel?: (harness: HarnessPickerIdentity) => boolean;
  validate?: (selection: PickerSelection) => string | undefined;
  onCancel: () => void;
  onConfirm: (selection: PickerSelection) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
}

export function HarnessModelPicker(props: Props): React.JSX.Element {
  const active = props.active !== false;
  const opening = useRef({ active, generation: 0 });
  if (active && !opening.current.active) opening.current.generation++;
  opening.current.active = active;
  const key = JSON.stringify([props.target, opening.current.generation]);
  if (props.surfaceSelection && 'source' in props.target) {
    return <LaunchPicker key={key} {...props} target={props.target} />;
  }
  return <HarnessPickerDraft key={key} {...props} />;
}

function LaunchPicker(props: Props & { target: { source: Source; surface: HarnessPickerIdentity['surface'] } }) {
  const { t } = useTranslation();
  const [surface, setSurface] = useState(props.target.surface);
  const panelId = React.useId();
  const locked = props.surfaceSelection?.cliDisabledReason;
  return <>
    <div className="new-task-surfaces" role="tablist" aria-label={t('会话类型')}>
      {(['gui', 'cli'] as const).map(kind =>
        <button key={kind} id={panelId + kind} type="button" role="tab" aria-selected={surface === kind}
          aria-controls={panelId} tabIndex={surface === kind ? 0 : -1}
          disabled={kind === 'cli' && !!locked} title={kind === 'cli' ? locked : undefined}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = locked || event.key === 'Home' ? 'gui' : event.key === 'End' || kind === 'gui' ? 'cli' : 'gui';
            setSurface(next);
            document.getElementById(panelId + next)?.focus();
          }}
          onClick={() => setSurface(kind)}>{kind.toUpperCase()}</button>)}
    </div>
    {surface === 'gui' && locked ? <span className="new-task-note">{locked}</span> : null}
    <div className="launch-picker-panel" id={panelId} role="tabpanel" aria-labelledby={panelId + surface}>
      <HarnessPickerDraft key={surface} {...props} target={{ ...props.target, surface }}
        initial={surface === props.target.surface ? props.initial : undefined} />
    </div>
  </>;
}

function HarnessPickerDraft({ target, initial, exact, disabled, active = true, confirmLabel, defaultLabel, manualModel, validate, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const groupLabelPrefix = React.useId();
  const sourceTarget = 'source' in target ? target : undefined;
  const [availability, setAvailability] = useState<{ choices: HarnessPickerChoice[]; error?: string }>();
  const [draft, setDraft] = useState<PickerInitialSelection>(() => initial ?? {});
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [read, setRead] = useState<{ targetKey: string; modelKey: string; dataKey?: string; catalog?: HarnessPickerCatalog; error?: string; loading: boolean }>();
  const [refreshing, setRefreshing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [refreshRevision, setRefreshRevision] = useState(0);
  const request = useRef<{ id: string; key: string; refresh: boolean }>();
  const committed = useRef(false);
  const mountEpoch = useRef(0);
  const initialStamp = useRef<string>();
  const known = useRef(new Map<string, readonly HarnessPickerModel[]>());

  const sourceKey = sourceTarget && JSON.stringify(sourceTarget.source);
  const surface = sourceTarget?.surface;
  useEffect(() => {
    if (!active || !sourceTarget) return;
    let live = true, generation = 0;
    const load = (): void => {
      const turn = ++generation;
      void window.api.agentSession.listHarnessPickerChoices().then(result => {
        if (live && turn === generation) setAvailability({ choices: result.choices });
      }).catch(error => {
        if (live && turn === generation) setAvailability(previous => ({ choices: previous?.choices ?? [], error: String(error) }));
      });
    };
    known.current.clear();
    load();
    const off = (['runtimes:changed', 'runtimes:availabilityChanged'] as const).map(event => window.api.on(event, load));
    return () => { live = false; off.forEach(unsubscribe => unsubscribe()); };
  }, [active, sourceKey, surface]);
  useEffect(() => { mountEpoch.current++; return () => { mountEpoch.current++; }; }, [active]);

  const choices = availability?.choices.filter(choice => choice.surface === surface) ?? [];
  const requestedHarness = draft.harness ?? initial?.harness;
  const selected = choices.find(choice => choice.available && (!requestedHarness || identityKey(choice) === identityKey(requestedHarness)));
  const harnessKey = identityKey(selected);
  useEffect(() => {
    if (selected && !requestedHarness) setDraft(previous => ({ ...previous, harness: selected }));
  }, [harnessKey, !!requestedHarness]);
  const readTarget = 'source' in target ? selected && { source: target.source, harness: {
    harnessId: selected.harnessId, runtimeId: selected.runtimeId, surface: selected.surface, acpPresetId: selected.acpPresetId
  } } : target;
  const targetKey = readTarget && JSON.stringify(readTarget);
  const currentModelKey = modelKey(draft.model);
  const readKey = targetKey ? `${targetKey}\0${currentModelKey}` : '';
  const displayed = read?.targetKey === targetKey ? read : undefined;
  const catalog = displayed?.catalog;
  const loading = !!targetKey && (!displayed || displayed.loading || displayed.modelKey !== currentModelKey);
  const runtimeReady = !!catalog && displayed?.dataKey === currentModelKey;
  const fixedHarness = !sourceTarget ? catalog?.harness : undefined;
  const installedHarness = selected ?? fixedHarness;
  const harnessLabel = selected?.label || HARNESS_CATALOG.find(entry => entry.id === fixedHarness?.harnessId)?.name || fixedHarness?.harnessId || '';
  const parameterReady = !loading && runtimeReady && catalog?.parameterState === 'ready';
  const stampChanged = !sourceTarget && !!initialStamp.current && initialStamp.current !== catalog?.sessionStamp;

  const load = async (refresh: boolean): Promise<void> => {
    if (!active || !readTarget || !targetKey) return;
    const id = randomUuid();
    const operation = { id, key: readKey, refresh };
    request.current = operation;
    setRefreshing(refresh);
    const carry = (previous: typeof read) => previous?.targetKey === targetKey ? { catalog: previous.catalog, dataKey: previous.dataKey } : {};
    setRead(previous => ({ targetKey, modelKey: currentModelKey, loading: true, ...carry(previous) }));
    const current = (): boolean => request.current === operation;
    try {
      const result = await window.api.agentSession.readHarnessPickerCatalog({ ...readTarget, requestId: id, refresh,
        ...(draft.model === undefined ? {} : { model: draft.model && { providerId: draft.model.providerId, modelId: draft.model.modelId } }) });
      if (!current()) return;
      if (!result.ok) {
        setRead(previous => ({ targetKey, modelKey: currentModelKey, loading: false, ...carry(previous), error: result.error }));
        return;
      }
      const next = result.catalog;
      if (!sourceTarget && !initialStamp.current) initialStamp.current = next.sessionStamp;
      known.current.set(identityKey(next.harness), next.models);
      setRead({ targetKey, modelKey: currentModelKey, dataKey: currentModelKey, catalog: next, loading: false });
      if (!sourceTarget && draft.model === undefined) {
        setDraft({ model: next.selectedModel ?? null, parameters: next.selectedParameters ?? {} });
      } else if (sourceTarget && draft.model === undefined) {
        const native = next.models.find(row => row.nativeLaunchModel === draft.nativeLaunchModel && !!draft.nativeLaunchModel);
        const first = exact && !next.defaultModel && next.state === 'ready' ? next.models[0] : undefined;
        const chosen = native ?? first;
        setDraft(previous => ({ ...previous, model: chosen ? { providerId: chosen.providerId, modelId: chosen.modelId } : null }));
      }
    } catch (error) {
      if (current()) setRead(previous => ({ targetKey, modelKey: currentModelKey, loading: false, ...carry(previous), error: String(error) }));
    } finally {
      if (current()) { request.current = undefined; setRefreshing(false); }
    }
  };
  const cancelRead = (): void => {
    const previous = request.current;
    request.current = undefined;
    if (previous) void window.api.agentSession.cancelHarnessModels(previous.id).catch(error => console.warn('[harness picker] cancel read failed', error));
  };
  useEffect(() => {
    if (readKey) void load(false);
    return cancelRead;
  }, [active, readKey, refreshRevision]);
  useEffect(() => {
    if (!active || !catalog) return;
    return window.api.on('agentSession:modelCatalogUpdated', event => {
      if (request.current?.refresh || event.requestId === request.current?.id && !!event.requestId ||
          event.runtimeId !== catalog.harness.runtimeId || event.agentId !== catalog.harness.acpPresetId ||
          event.workspaceId !== catalog.source.workspaceId || event.rootId !== catalog.source.rootId ||
          event.cwd !== undefined && event.cwd !== catalog.source.cwd) return;
      if (event.error) setRead(previous => previous && { ...previous, error: event.error });
      else setRefreshRevision(value => value + 1);
    });
  }, [active, targetKey, catalog?.source.cwd, catalog?.harness.runtimeId, catalog?.harness.acpPresetId]);
  useEffect(() => {
    if (!active || !targetKey || (installedHarness && installedHarness.runtimeId !== 'pi')) return;
    return window.api.on('agentSession:coreReasoningCatalogUpdated', () => setRefreshRevision(value => value + 1));
  }, [active, targetKey, installedHarness?.runtimeId]);

  const search = query.trim().toLocaleLowerCase();
  const matches = (...parts: Array<string | undefined>): boolean => !search || parts.some(value => value?.toLocaleLowerCase().includes(search));
  const matchesModel = (row: HarnessPickerModel): boolean => matches(row.label, row.group?.label, row.group?.id, row.detail, row.modelId, row.providerId, row.nativeLaunchModel);
  const visibleHarnesses = choices.filter(choice => matches(choice.label) || known.current.get(identityKey(choice))?.some(matchesModel));
  const models = pickerModelRows(catalog?.models ?? []);
  const visibleModels = models.filter(row => matches(harnessLabel) || matchesModel(row));
  const chosenModel = models.find(row => modelKey(row) === currentModelKey || draft.nativeLaunchModel && row.nativeLaunchModel === draft.nativeLaunchModel);
  const manual = !!installedHarness && !!manualModel?.(installedHarness);
  const nativeLaunchModel = draft.nativeLaunchModel ?? chosenModel?.nativeLaunchModel;
  const follows = defaultLabel ?? t(installedHarness?.surface === 'cli' ? '跟随 CLI 配置' : '跟随引擎默认');
  const defaultAllowed = !!catalog && (!exact || !!catalog.defaultModel || catalog.state === 'unsupported');
  const modelEditable = catalog?.canSetModel !== false;
  const defaultVisible = defaultAllowed && modelEditable && catalog.state !== 'unsupported' && matches(follows, harnessLabel);
  const catalogControls = catalog?.parameterState === 'ready' ? catalog.parameters ?? [] : [];
  const controls = parameterReady ? catalogControls.map(control => {
    const override = draft.parameters?.[control.descriptor.id] ?? null;
    return { ...control, override, effectiveValue: override ?? (control.override === null ? control.effectiveValue : null) };
  }) : [];
  // The carried catalog is already scoped to this Harness and source. Its controls
  // preserve the column during a preview, but only the current controls are actionable.
  const visibleControls = loading ? catalogControls : controls;
  const overrides = draft.parameters ?? {};
  const supportedParameters = Object.fromEntries(Object.entries(overrides).filter(([id, value]) =>
    controls.some(control => control.descriptor.id === id && control.descriptor.options.some(option => option.value === value))));
  const parametersValid = Object.keys(overrides).length === Object.keys(supportedParameters).length;
  const fixedModel = !sourceTarget && !modelEditable && draft.model && modelKey(draft.model) === modelKey(catalog?.selectedModel)
    ? { ...draft.model, label: draft.model.modelId } : null;
  const choiceValid = !!chosenModel || !!fixedModel || !!(manual && nativeLaunchModel?.trim()) || draft.model === null && defaultAllowed;
  const selection = catalog && choiceValid ? { harness: catalog.harness, harnessLabel, model: chosenModel ?? fixedModel, parameters: overrides,
    ...(nativeLaunchModel?.trim() ? { nativeLaunchModel: nativeLaunchModel.trim() } : {}), catalog } : undefined;
  const validationError = selection && validate?.(selection);
  const canConfirm = active && !disabled && !committing && !loading && runtimeReady && !!selection && parametersValid && !stampChanged && !validationError;

  const selectHarness = (choice: HarnessPickerChoice): void => {
    if (identityKey(choice) === harnessKey) return;
    cancelRead(); setConfirmError('');
    setSelectionRevision(value => value + 1);
    setDraft({ harness: choice });
  };
  const selectModel = (row: HarnessPickerModel | null): void => {
    if (modelKey(row) === currentModelKey && !draft.nativeLaunchModel) return;
    cancelRead(); setConfirmError('');
    setSelectionRevision(value => value + 1);
    setDraft(previous => ({ ...previous, model: row && { providerId: row.providerId, modelId: row.modelId }, nativeLaunchModel: undefined, parameters: {} }));
  };
  const confirm = async (): Promise<void> => {
    if (!canConfirm || committed.current || !selection) return;
    const epoch = mountEpoch.current;
    committed.current = true;
    setCommitting(true); setConfirmError('');
    try {
      const result = await onConfirm(selection);
      if (epoch === mountEpoch.current && !result.ok) setConfirmError(result.error || t('模型切换失败'));
    } catch (error) {
      if (epoch === mountEpoch.current) setConfirmError(error instanceof Error ? error.message : String(error));
    } finally {
      committed.current = false;
      if (epoch === mountEpoch.current) setCommitting(false);
    }
  };

  const optionsLocked = !active || disabled || committing;
  const error = availability?.error || displayed?.error || validationError || confirmError || (stampChanged ? t('会话配置已变化，请重新读取') : '');
  const columns: React.ComponentProps<typeof ModelPickerLayout>['columns'] = [];
  if (sourceTarget) columns.push({ id: 'harness', label: t('Harness'), selectable: !optionsLocked && visibleHarnesses.some(choice => choice.available),
    content: <div role="tablist" aria-label={t('Harness')} aria-orientation="vertical">
      {visibleHarnesses.map(choice => <button key={identityKey(choice)} type="button" role="tab" data-picker-choice={identityKey(choice)}
        className="harness-picker-option" aria-selected={harnessKey === identityKey(choice)} disabled={optionsLocked || !choice.available}
        title={choice.warning || choice.label} onClick={() => selectHarness(choice)}>
        <HarnessIcon harnessId={choice.harnessId} size={17} /><span>{choice.label}</span>
        {!choice.available ? <small>{choice.warning || t('当前不可用')}</small> : null}
      </button>)}
      {!availability ? <p role="status">{t('正在检测 Worker…')}</p> : !visibleHarnesses.length ? <p role="status">{t('没有匹配的 Harness')}</p> : null}
      {availability && requestedHarness && !selected ? <p role="status">{t('所选 Agent 当前不可用，请重新选择或前往设置检查。')}</p> : null}
    </div>
  });
  const showModels = modelEditable && catalog?.state !== 'unsupported';
  if (!sourceTarget && (showModels || !visibleControls.length) || !!selected && showModels || manual) columns.push({
    id: 'models', label: t('模型'), selectable: !optionsLocked && showModels && (defaultVisible || visibleModels.length > 0),
    content: <>
      {fixedHarness ? <div className="model-picker-heading"><HarnessIcon harnessId={fixedHarness.harnessId} size={18} /><strong>{harnessLabel}</strong></div> : null}
      {showModels && (defaultVisible || visibleModels.length) ? <div className="harness-picker-model-list" role="listbox" aria-label={t('模型')}>
        {defaultVisible ? <button type="button" role="option" data-picker-choice="default" className="harness-picker-option" disabled={optionsLocked}
          aria-selected={draft.model === null && !draft.nativeLaunchModel} onClick={() => selectModel(null)}>{follows}</button> : null}
        {pickerModelGroups(visibleModels).map((section, index) => {
          const labelId = section.group ? `${groupLabelPrefix}-${index}` : undefined;
          const initial = firstGrapheme(section.label?.toUpperCase() ?? '');
          return <div key={section.group?.id ?? ''} role={section.group ? 'group' : 'presentation'} aria-labelledby={labelId}>
            {labelId ? <div className="model-catalog-group-heading" aria-hidden="true">
              {initial ? <span className="model-catalog-group-initial">{initial}</span> : null}
              <span id={labelId}>{section.label}</span>
            </div> : null}
            {section.items.map(row => <button key={modelKey(row)} type="button" role="option" data-picker-choice={modelKey(row)}
              className="harness-picker-option harness-picker-model-option" disabled={optionsLocked}
              aria-selected={modelKey(row) === modelKey(chosenModel)} title={pickerModelTitle(row)} onClick={() => selectModel(row)}>
              <span className="model-catalog-name">{row.label}</span>{row.detail ? <> <small className="model-catalog-detail">{row.detail}</small></> : null}
            </button>)}
          </div>;
        })}
      </div> : null}
      {loading && !catalog ? <p role="status">{t('正在读取模型目录…')}</p> : search && !visibleModels.length && !defaultVisible ? <p>{t('没有匹配的已读取模型')}</p> : null}
      {!sourceTarget && !loading && modelEditable && draft.model && !chosenModel ? <p role="status">{t('当前模型 {{model}} 不在可选目录中。', { model: draft.model.modelId })}</p> : null}
      {catalog?.warning ? <p role="status">{localizeGuiHostError(catalog.warning)}</p> : null}
      {catalog?.parameterWarning ? <p role="status">{localizeGuiHostError(catalog.parameterWarning)}</p> : null}
      {catalog?.canRefresh ? <OperationButton className="btn tiny harness-picker-refresh" type="button" disabled={optionsLocked}
        onAction={() => { cancelRead(); return load(true); }}>{t('刷新模型目录')}</OperationButton> : null}
      {displayed?.error && !catalog ? <button type="button" className="btn tiny" onClick={() => void load(false)}>{t('重新读取会话设置')}</button> : null}
      {refreshing ? <button type="button" className="btn tiny" onClick={() => {
        cancelRead(); setRefreshing(false); setRead(previous => previous && { ...previous, loading: false });
      }}>{t('取消读取')}</button> : null}
      {manual ? <label className="harness-picker-manual">{t('模型 ID')}
        <input className="s-input mono" value={nativeLaunchModel ?? ''} disabled={optionsLocked} maxLength={256}
          onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, model: null, nativeLaunchModel: value, parameters: {} })); }} />
      </label> : null}
    </>
  });
  if (visibleControls.length) columns.push({ id: 'parameters', label: t('模型参数'), selectable: !optionsLocked && parameterReady, pending: loading,
    content: <>{fixedHarness && !showModels ? <div className="model-picker-heading"><HarnessIcon harnessId={fixedHarness.harnessId} size={18} /><strong>{harnessLabel}</strong></div> : null}
    <ModelPickerParameterFields controls={visibleControls} disabled={optionsLocked} pending={loading} onChange={(id, value) => {
      setConfirmError('');
      setDraft(previous => {
        const parameters = { ...previous.parameters };
        if (value === null) delete parameters[id]; else parameters[id] = value;
        return { ...previous, parameters };
      });
    }} /></>
  });
  return <ModelPickerLayout columns={columns} query={query} onQuery={setQuery} searchLabel={t(sourceTarget ? '搜索 Harness 或已读取的模型' : '搜索模型')}
    onConfirm={() => void confirm()} canConfirm={canConfirm} selectionKey={`${targetKey}\0${selectionRevision}`}
    narrowSummary={[harnessLabel, chosenModel ? pickerModelSelectionLabel(chosenModel) : fixedModel?.label || nativeLaunchModel || (draft.model === null ? follows : draft.model?.modelId)].filter(Boolean).join(' · ')}
    pendingColumn={loading ? displayed?.catalog ? 'parameters' : 'models' : undefined}>
    {error ? <ErrorTip message={localizeGuiHostError(error)} /> : null}
    {parameterReady && !parametersValid && <p role="status">
      {t('部分已选模型参数不再可用。')}
      <button type="button" className="btn tiny" disabled={optionsLocked}
        onClick={() => { setConfirmError(''); setDraft(previous => ({ ...previous, parameters: supportedParameters })); }}>
        {t('清除失效参数')}
      </button>
    </p>}
    <div className="harness-picker-actions">
      <button type="button" className="btn" onClick={onCancel}>{t('取消')}</button>
      <button type="button" className="btn primary" disabled={!canConfirm} onClick={() => void confirm()}>{confirmLabel}</button>
    </div>
  </ModelPickerLayout>;
}
