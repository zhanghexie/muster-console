import { ErrorTip } from '../ErrorTip';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmProviderConfig, WorkspaceInfo } from '../../../../shared/types';
import type { WorkerRoutingConfig, WorkerRoutingLayer, WorkerRoutingMember, WorkerRoutingMemberStatus, WorkerRoutingSettings, WorkerRoutingStandardKind, WorkerRoutingTier, WorkerTargetConfig } from '../../../../shared/workerRouting';
import { workerRoutingTierKindRank, WORKER_ROUTING_LIMITS, WORKER_ROUTING_STANDARD_KINDS } from '../../../../shared/workerRouting';
import { randomUuid } from '../../../../shared/randomUuid';
import { sourceRootsFor } from '../../../../shared/workspaceRoots';
import { WorkerTargetDialog, type WorkerTargetDialogRequest } from '../workerRouting/WorkerTargetDialog';
import { workerTargetLabel } from '../workerRouting/workerTargetLabel';
import { workerRoutingScope, workerRoutingScopeKey } from '../workerRouting/workerRoutingScope';
import { Segmented, SettingRow, SettingsRows, SettingsSection, Switch } from './shared';
import { CustomSelect } from '../CustomSelect';
import { AnimatedDetails } from '../AnimatedDetails';
import { HarnessIcon } from '../HarnessIcon';
import { IconChevronDown, IconChevronUp, IconClock, IconLayers, IconPencil, IconPlus, IconRefresh, IconSparkle, IconTrash } from '../icons';
import { usePresence } from '../motion';
import { WorkerRoutingCrossHarness } from './WorkerRoutingCrossHarness';

type PoolTarget = { tierId: string } | { kind: WorkerRoutingStandardKind };
type EditRequest = { target: PoolTarget; memberId?: string; dialog: WorkerTargetDialogRequest };
type LayerDraftController = { save: () => Promise<boolean> };
export interface WorkerRoutingDraftController extends LayerDraftController { count: number }
type LayerProps = {
  workspace?: WorkspaceInfo;
  active: boolean;
  modelProviders?: ReadonlyArray<Pick<LlmProviderConfig, 'id' | 'name' | 'models'>>;
};

function RoutingIconButton({ label, disabled, onClick, children }: {
  label: string; disabled?: boolean; onClick: React.MouseEventHandler<HTMLButtonElement>; children: ReactNode;
}) {
  return <button type="button" className="btn ghost tiny worker-routing-icon-button" aria-label={label} title={label}
    disabled={disabled} onClick={onClick}>{children}</button>;
}

function RoutingDetails({ summary, active, children }: {
  summary: ReactNode; active: boolean; children: (open: boolean) => ReactNode;
}) {
  const [local, setLocal] = useState(false);
  const open = active && local;
  return <AnimatedDetails className="worker-routing-details" summary={summary} open={open} onToggle={setLocal}>
    <div className="worker-routing-details-body" aria-hidden={!open || undefined} ref={node => { if (node) node.inert = !open; }}>
      {active ? children(open) : null}
    </div>
  </AnimatedDetails>;
}

function SpecialPoolFields({ value, onChange }: {
  value: { name: string; description: string }; onChange: (value: { name: string; description: string }) => void;
}) {
  const { t } = useTranslation();
  return <div className="worker-routing-fields">
    <label className="worker-routing-field">{t('功能名称')}<input className="s-input" required maxLength={WORKER_ROUTING_LIMITS.tierName}
      value={value.name} onChange={event => onChange({ ...value, name: event.target.value })} /></label>
    <label className="worker-routing-field">{t('适用说明')}<textarea className="s-input" rows={2} maxLength={WORKER_ROUTING_LIMITS.tierDescription}
      value={value.description} onChange={event => onChange({ ...value, description: event.target.value })} /></label>
  </div>;
}

function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const next = [...items];
  const other = index + direction;
  if (other < 0 || other >= items.length) return items;
  [next[index], next[other]] = [next[other], next[index]];
  return next;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function withAuthorization(member: WorkerRoutingMember, authorization: WorkerRoutingMember['crossHarness']): WorkerRoutingMember {
  const next = { ...member };
  if (authorization) next.crossHarness = authorization;
  else delete next.crossHarness;
  return next;
}

function withoutWorkspaceAuthorizations(config: WorkerRoutingConfig): WorkerRoutingConfig {
  return { ...config, tiers: config.tiers.map(tier => ({ ...tier, members: tier.members.map(member =>
    member.crossHarness ? withAuthorization(member, undefined) : member) })) };
}

export function WorkerRoutingPane({ initialLayer = 'global', onDraftChange, ...props }: LayerProps & {
  initialLayer?: WorkerRoutingLayer;
  onDraftChange?: (draft: WorkerRoutingDraftController | null) => void;
}) {
  const { t } = useTranslation();
  const [layer, setLayer] = useState<WorkerRoutingLayer>(props.workspace ? initialLayer : 'global');
  const [drafts, setDrafts] = useState<Record<WorkerRoutingLayer, LayerDraftController | null>>({ global: null, workspace: null });
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const registerGlobal = useCallback((draft: LayerDraftController | null) => setDrafts(previous => ({ ...previous, global: draft })), []);
  const registerWorkspace = useCallback((draft: LayerDraftController | null) => setDrafts(previous => ({ ...previous, workspace: draft })), []);
  const count = Number(!!drafts.global) + Number(!!drafts.workspace);
  const save = async (): Promise<boolean> => {
    if (!count || writing.current) return false;
    writing.current = true;
    setSaving(true);
    try {
      // A workspace draft may still depend on the saved global baseline.
      for (const target of ['workspace', 'global'] as const) {
        const draft = drafts[target];
        if (draft && !await draft.save()) { setLayer(target); return false; }
      }
      return true;
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useLayoutEffect(() => {
    if (!onDraftChange || !count) return;
    onDraftChange({ count, save: () => saveRef.current() });
    return () => onDraftChange(null);
  }, [onDraftChange, count]);

  return <SettingsSection title={<span data-settings-item="worker-routing">{t('自动派活')}</span>}
    desc={t('按任务复杂度选档，候选按顺序替换。')}>
    <SettingsRows className="worker-routing-scope">
      <SettingRow title={t('应用范围')} desc={layer === 'workspace' && props.workspace ? t('仅影响当前工作区「{{name}}」。', { name: props.workspace.name }) : t('未单独设置的工作区使用全局默认。')}>
        <Segmented<WorkerRoutingLayer> label={t('自动派活应用范围')} value={layer} disabled={saving} onChange={setLayer}
          options={[{ value: 'global', label: t('全局默认') }, ...(props.workspace ? [{ value: 'workspace' as const, label: t('仅当前工作区') }] : [])]} />
      </SettingRow>
    </SettingsRows>
    <WorkerRoutingLayerPane {...props} layer="global" active={props.active && layer === 'global'} saving={saving} onDraftChange={registerGlobal} />
    {props.workspace ? <WorkerRoutingLayerPane {...props} layer="workspace" active={props.active && layer === 'workspace'} saving={saving} onDraftChange={registerWorkspace} /> : null}
    {!onDraftChange ? <div className="worker-routing-buttons worker-routing-footer">
      <button type="button" className="btn primary" disabled={saving || !count} onClick={() => void save()}>{t('保存派活配置')}</button>
    </div> : null}
  </SettingsSection>;
}

/** The layer stays mounted so navigation preserves its revision and draft. */
function WorkerRoutingLayerPane({ workspace, modelProviders, active, layer, saving, onDraftChange }: LayerProps & {
  layer: WorkerRoutingLayer;
  saving: boolean;
  onDraftChange: (draft: LayerDraftController | null) => void;
}) {
  const { t } = useTranslation();
  const [rootId, setRootId] = useState('');
  const [saved, setSaved] = useState<WorkerRoutingSettings | null>(null);
  const [draft, setDraft] = useState<WorkerRoutingConfig | null>(null);
  const [intent, setIntent] = useState<'empty-override' | 'follow' | null>(null);
  const [followPreview, setFollowPreview] = useState<{ config: WorkerRoutingConfig } | { error: string } | null>(null);
  const [statuses, setStatuses] = useState<WorkerRoutingMemberStatus[]>([]);
  const [editor, setEditor] = useState<EditRequest | null>(null);
  const [newSpecialOpen, setNewSpecialOpen] = useState(false);
  const [newSpecial, setNewSpecial] = useState({ name: '', description: '' });
  const specialFormId = useId();
  const specialTrigger = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [reload, setReload] = useState(0);
  const operation = useRef(0);
  const writing = useRef(false);
  const refreshAfterWrite = useRef(false);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const discardDraft = useRef(false);
  const scope = workerRoutingScope(workspace, rootId ? { rootId } : undefined);
  const scopeKey = workerRoutingScopeKey(scope);
  const mounted = useRef(false);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = !!draft && (!!intent || JSON.stringify(draft) !== JSON.stringify(saved?.config));
  const latest = useRef({ saved, dirty, editor });
  latest.current = { saved, dirty, editor };
  const workspaceOverride = layer === 'workspace' && intent !== 'follow' && (saved?.origin === 'workspace' || dirty);
  const pendingAuthorization = draft?.tiers.some(tier => tier.members.some(member => member.crossHarness && !member.crossHarness.binding));

  const install = (result: WorkerRoutingSettings) => {
    const config = result.origin === 'global' ? withoutWorkspaceAuthorizations(result.config) : result.config;
    setSaved({ ...result, config }); setDraft(config); setIntent(null);
    setStatuses(result.members);
  };

  useEffect(() => {
    if (!active || !scope) {
      if (!writing.current) setBusy(false);
      return;
    }
    let live = true;
    const generation = ++operation.current;
    if (!writing.current) {
      setBusy(true); setStatuses([]);
      void Promise.resolve().then(() => window.api.workerRouting.read({ scope, layer })).then(result => {
        if (!live || generation !== operation.current) return;
        const current = latest.current;
        if (discardDraft.current || !current.editor && !current.dirty) { install(result); setError(''); }
        else if (result.version === current.saved?.version) setStatuses(result.members);
        else setError(t('派活配置已在其他位置更新。请重新载入后再保存。'));
      }).catch(cause => { if (live && generation === operation.current) setError(errorMessage(cause)); })
        .finally(() => {
          if (live && generation === operation.current) { setBusy(false); discardDraft.current = false; }
        });
    }
    const refresh = () => {
      if (writing.current) refreshAfterWrite.current = true;
      else setReload(value => value + 1);
    };
    const off = window.api.on('agentSession:modelCatalogUpdated', event => {
      if (event.workspaceId === scope.workspaceId && event.rootId === scope.rootId && !event.error) {
        // Readiness is per-source, even when the saved pool is workspace-wide.
        refresh();
      }
    });
    const offRouting = window.api.on('workerRouting:changed', event => {
      if (event.kind === 'global' && (layer === 'global' || latest.current.saved?.origin !== 'workspace') ||
          event.kind === 'workspace' && layer === 'workspace' && event.workspaceId === scope.workspaceId ||
          event.kind === 'cooldown' && (!event.workspaceId || event.workspaceId === scope.workspaceId)) refresh();
    });
    const offRuntimes = window.api.on('runtimes:availabilityChanged', refresh);
    const offSelections = window.api.on('agentSession:harnessModelSelectionsChanged', refresh);
    return () => { live = false; operation.current++; off(); offRouting(); offRuntimes(); offSelections(); };
  }, [active, layer, scopeKey, reload, t]);

  useEffect(() => {
    if (!active || editor && workerRoutingScopeKey(editor.dialog.scope) !== scopeKey) setEditor(null);
  }, [active, scopeKey, editor]);
  useEffect(() => {
    if (!active || !scope || intent !== 'follow') return;
    let live = true;
    setFollowPreview(null);
    void window.api.workerRouting.read({ scope, layer: 'global' }).then(result => {
      if (live) setFollowPreview({ config: result.config });
    }).catch(cause => { if (live) setFollowPreview({ error: errorMessage(cause) }); });
    const off = window.api.on('workerRouting:changed', event => {
      if (event.kind === 'global') setReload(value => value + 1);
    });
    return () => { live = false; off(); };
  }, [active, scopeKey, intent, reload]);
  useEffect(() => {
    if (!active || busy) return;
    const now = Date.now();
    const next = Math.min(...statuses.flatMap(item => item.state === 'cooldown' && item.retryAt && item.retryAt > now ? [item.retryAt] : []));
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setReload(value => value + 1), next - now + 1);
    return () => window.clearTimeout(timer);
  }, [active, busy, statuses]);

  const mutate = (fn: (tiers: WorkerRoutingTier[]) => WorkerRoutingTier[]) => {
    setFeedback('');
    setDraft(previous => previous ? { ...previous, tiers: fn(previous.tiers) } : previous);
  };
  const editTier = (id: string, fn: (tier: WorkerRoutingTier) => WorkerRoutingTier) =>
    mutate(tiers => tiers.map(tier => tier.id === id ? fn(tier) : tier));
  const closeEditor = () => {
    setEditor(null);
    editorTrigger.current?.focus({ preventScroll: true });
  };
  const openEditor = (trigger: HTMLElement, target: PoolTarget, memberId?: string, initial?: WorkerTargetConfig) => {
    if (!active || busy || saving || !scope) return;
    editorTrigger.current = trigger;
    setEditor({ target, memberId, dialog: { scope, initial, editing: !!memberId } });
  };
  const finishWrite = (stillBound: boolean) => {
    const refresh = refreshAfterWrite.current;
    refreshAfterWrite.current = false;
    writing.current = false;
    if (stillBound) {
      setBusy(false);
      if (refresh) setReload(value => value + 1);
    }
  };
  const save = async (): Promise<boolean> => {
    if (!scope || !draft || !saved || !dirty || writing.current || editor) return false;
    ++operation.current;
    const stillBound = () => mounted.current && currentScope.current === scopeKey;
    writing.current = true;
    setBusy(true); setError(''); setFeedback('');
    try {
      const expectedVersion = saved.version;
      const result = intent === 'follow' ? await window.api.workerRouting.followGlobal({ scope, expectedVersion })
        : await window.api.workerRouting.save({ scope, layer, expectedVersion, config: draft });
      if (!stillBound()) return false;
      install(result); setFeedback(t('派活配置已保存'));
      return true;
    } catch (cause) {
      if (stillBound()) setError(errorMessage(cause));
      return false;
    } finally {
      finishWrite(stillBound());
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useLayoutEffect(() => {
    if (!dirty) return;
    onDraftChange({ save: () => saveRef.current() });
    return () => onDraftChange(null);
  }, [onDraftChange, dirty]);
  const resetCooldown = async (memberId: string) => {
    if (!scope || !saved || busy || saving || writing.current) return;
    ++operation.current;
    const stillBound = () => mounted.current && currentScope.current === scopeKey;
    writing.current = true;
    setBusy(true); setError(''); setFeedback('');
    try {
      const result = await window.api.workerRouting.resetCooldown({ scope, layer, expectedVersion: saved.version, memberId });
      if (!stillBound()) return;
      if (dirty && saved.version !== result.version) setError(t('派活配置已在其他位置更新。请重新载入后再保存。'));
      else if (dirty) setStatuses(result.members);
      else install(result);
    } catch (cause) {
      if (stillBound()) setError(errorMessage(cause));
    } finally {
      finishWrite(stillBound());
    }
  };
  const statusLabel: Record<WorkerRoutingMemberStatus['state'], string> = {
    available: t('可用'), unknown: t('可用性未知'), disabled: t('已停用'), cooldown: t('冷却中'), invalid: t('配置失效')
  };
  let roots: ReturnType<typeof sourceRootsFor> = [];
  if (workspace) {
    try { roots = sourceRootsFor(workspace); } catch { /* scope error shown below */ }
  }
  const tierNames = { low: t('低'), medium: t('中'), high: t('高'), xhigh: t('极高') };
  const tierTitle = (tier: WorkerRoutingTier): string => tier.kind && tier.kind !== 'special' ? tierNames[tier.kind] : tier.name || t('未命名档位');
  const atLimit = (draft?.tiers.length ?? 0) >= WORKER_ROUTING_LIMITS.tiers;
  const specialOpen = active && newSpecialOpen && !atLimit && intent !== 'follow';
  const specialPresence = usePresence(specialOpen);
  const standardSlots = WORKER_ROUTING_STANDARD_KINDS.map(kind => ({ kind, tier: draft?.tiers.find(tier => tier.kind === kind) }));
  const specialPools = draft?.tiers.filter(tier => !tier.kind || tier.kind === 'special') ?? [];
  const ready = active && !!scope && !!draft && !busy && !saving;
  if (!active) return null;

  const updateMember = (tierId: string, memberId: string, update: (member: WorkerRoutingMember) => WorkerRoutingMember) =>
    editTier(tierId, tier => ({ ...tier, members: tier.members.map(member => member.id === memberId ? update(member) : member) }));
  const removePool = (id: string) => mutate(tiers => tiers.filter(tier => tier.id !== id)
    .map(tier => ({ ...tier, fallbackTierIds: tier.fallbackTierIds.filter(fallback => fallback !== id) })));

  const renderMember = (tier: WorkerRoutingTier, savedTier: WorkerRoutingTier | undefined, member: WorkerRoutingMember, index: number) => {
    const baseline = savedTier?.members.find(item => item.id === member.id);
    const status = JSON.stringify(baseline?.config) === JSON.stringify(member.config) && baseline?.enabled === member.enabled
      ? statuses.find(item => item.id === member.id) : undefined;
    const state = member.enabled ? status?.state : 'disabled';
    const stateLabel = state ? statusLabel[state] : t('待保存校验');
    const statusText = [stateLabel, status?.retryAt && new Date(status.retryAt).toLocaleTimeString(), status?.reason].filter(Boolean).join(' · ');
    const target = member.config;
    const defaultModel = t('跟随引擎默认');
    const label = workerTargetLabel(target, defaultModel);
    const provider = target.runtimeId === 'pi' ? modelProviders?.find(provider => provider.id === target.model?.providerId) : undefined;
    const model = provider?.models.find(item => item.id === target.model?.modelId)?.name || target.model?.modelId || target.cliLaunchOptions?.model || defaultModel;
    const shortValue = (value: string) => value === 'low' || value === 'medium' || value === 'high' ? tierNames[value] : value;
    const parameters = Object.entries(target.modelParameters ?? {}).map(([id, value]) => id === 'reasoning' ? shortValue(value) : value);
    if (target.cliLaunchOptions?.reasoning) parameters.push(shortValue(target.cliLaunchOptions.reasoning));
    const detail = [target.surface.toUpperCase(), target.runtimeId === 'pi' ? provider?.name || target.model?.providerId : undefined, ...parameters].filter(Boolean).join(' · ');
    return <li className="worker-routing-item" key={member.id}>
      <button type="button" className="btn ghost worker-routing-edit" aria-label={label} title={`${label} · ${statusText}`}
        onClick={event => openEditor(event.currentTarget, { tierId: tier.id }, member.id, target)}>
        <HarnessIcon harnessId={target.harnessId} size={18} />
        <span className="worker-routing-item-info"><strong>{model}</strong><small>{detail}</small></span>
      </button>
      <div className="worker-routing-item-controls">
        <span className="worker-routing-status" data-status={state} title={statusText}><span aria-hidden="true" />{stateLabel}</span>
        <div className="worker-routing-buttons">
          <Switch checked={member.enabled} label={t('启用 {{name}}', { name: label })} title={t('启用 {{name}}', { name: label })}
            onChange={enabled => updateMember(tier.id, member.id, item => ({ ...item, enabled }))} />
          <RoutingIconButton label={t('上移')} disabled={index === 0}
            onClick={() => editTier(tier.id, previous => ({ ...previous, members: move(previous.members, index, -1) }))}><IconChevronUp size={14} /></RoutingIconButton>
          <RoutingIconButton label={t('下移')} disabled={index === tier.members.length - 1}
            onClick={() => editTier(tier.id, previous => ({ ...previous, members: move(previous.members, index, 1) }))}><IconChevronDown size={14} /></RoutingIconButton>
          {state === 'cooldown' ? <RoutingIconButton label={t('清除冷却')} onClick={() => void resetCooldown(member.id)}><IconClock size={14} /></RoutingIconButton> : null}
          <RoutingIconButton label={t('移除候选')} onClick={event => {
            event.currentTarget.closest('fieldset')?.querySelector<HTMLButtonElement>('.worker-routing-add')?.focus();
            editTier(tier.id, previous => ({ ...previous, members: previous.members.filter(item => item.id !== member.id) }));
          }}><IconTrash size={14} /></RoutingIconButton>
        </div>
      </div>
      {workspaceOverride && scope && target.runtimeId === 'codex-gui' && target.surface === 'gui' ?
        <WorkerRoutingCrossHarness key={JSON.stringify([scopeKey, target])} member={member} scope={scope} active={active} disabled={busy || saving}
          onChange={authorization => updateMember(tier.id, member.id, item => withAuthorization(item, authorization))} /> : null}
    </li>;
  };

  const renderFallback = (tier: WorkerRoutingTier) => {
    const available = draft?.tiers.filter(item => item.id !== tier.id && !tier.fallbackTierIds.includes(item.id)) ?? [];
    const fallbackNames = tier.fallbackTierIds.map(id => {
      const item = draft?.tiers.find(candidate => candidate.id === id);
      return item ? tierTitle(item) : id;
    });
    return <RoutingDetails active={active} summary={<>
      <IconLayers size={14} /><span>{t('故障替换')}</span>
      {fallbackNames.length ? <small title={fallbackNames.join(' → ')}>{fallbackNames.join(' → ')}</small> : null}
    </>}>{open => <>
      {fallbackNames.length ? <ol className="worker-routing-list">{fallbackNames.map((label, index) =>
        <li key={tier.fallbackTierIds[index]} className="worker-routing-fallback-item">
          <span>{label}</span>
          <div className="worker-routing-buttons">
            <RoutingIconButton label={t('上移')} disabled={index === 0}
              onClick={() => editTier(tier.id, previous => ({ ...previous, fallbackTierIds: move(previous.fallbackTierIds, index, -1) }))}><IconChevronUp size={14} /></RoutingIconButton>
            <RoutingIconButton label={t('下移')} disabled={index === fallbackNames.length - 1}
              onClick={() => editTier(tier.id, previous => ({ ...previous, fallbackTierIds: move(previous.fallbackTierIds, index, 1) }))}><IconChevronDown size={14} /></RoutingIconButton>
            <RoutingIconButton label={t('移除后继')} onClick={() => editTier(tier.id, previous => ({
              ...previous, fallbackTierIds: previous.fallbackTierIds.filter(id => id !== tier.fallbackTierIds[index])
            }))}><IconTrash size={14} /></RoutingIconButton>
          </div>
        </li>
      )}</ol> : <p className="settings-hint">{t('此档位用尽后停止派活。')}</p>}
      <CustomSelect className="worker-routing-fallback-select" ariaLabel={t('添加跨档后继')} value="" menuEnabled={open}
        placeholder={t('添加跨档后继')} disabled={!ready || !available.length}
        options={available.map(item => ({ value: item.id, label: tierTitle(item) }))}
        onChange={value => { if (ready) editTier(tier.id, previous => ({ ...previous, fallbackTierIds: [...previous.fallbackTierIds, value] })); }} />
    </>}</RoutingDetails>;
  };

  const renderPool = (target: PoolTarget, tier?: WorkerRoutingTier, kind?: WorkerRoutingStandardKind) => {
    const name = kind ? tierNames[kind] : tier?.name || t('未命名档位');
    const savedTier = saved?.config.tiers.find(item => item.id === tier?.id);
    const addLabel = t('为{{name}}添加候选', { name });
    return <fieldset key={kind ?? tier?.id} className="worker-routing-tier" data-kind={kind ?? 'special'} aria-label={name} disabled={!ready}>
      <div className="worker-routing-tier-head">
        {kind ? <h3><span className="worker-routing-strength" aria-hidden="true">
          {WORKER_ROUTING_STANDARD_KINDS.map((bar, index) => <i key={bar} data-filled={index <= workerRoutingTierKindRank(kind) ? '' : undefined} />)}
        </span>{name}</h3> : <h4>{name}</h4>}
        <button type="button" className="btn ghost tiny worker-routing-icon-button worker-routing-add" aria-label={addLabel} title={addLabel}
          disabled={tier ? tier.members.length >= WORKER_ROUTING_LIMITS.membersPerTier : atLimit}
          onClick={event => openEditor(event.currentTarget, target)}><IconPlus size={16} /></button>
      </div>
      {tier?.members.length ? <ol className="worker-routing-list" aria-label={t('候选顺序')}>
        {tier.members.map((member, index) => renderMember(tier, savedTier, member, index))}
      </ol> : <p className="settings-hint">{t('暂无候选')}</p>}
      {tier ? renderFallback(tier) : null}
      {tier && !kind ? <RoutingDetails active={active} summary={<><IconPencil size={14} /><span>{t('编辑功能')}</span></>}>{open => <>
        <SpecialPoolFields value={{ name: tier.name, description: tier.description }} onChange={value => editTier(tier.id, previous => ({ ...previous, ...value }))} />
        <div className="worker-routing-buttons">
          {standardSlots.some(slot => !slot.tier) ? <CustomSelect className="worker-routing-fallback-select" ariaLabel={t('分配到标准档')} value="" menuEnabled={open}
            placeholder={t('分配到标准档')} disabled={!ready || !tier.name.trim()}
            options={standardSlots.filter(slot => !slot.tier).map(slot => ({ value: slot.kind, label: tierNames[slot.kind] }))}
            onChange={value => {
              const kind = WORKER_ROUTING_STANDARD_KINDS.find(item => item === value);
              if (!ready || !kind || !tier.name.trim()) return;
              mutate(tiers => tiers.some(item => item.kind === kind) ? tiers : tiers.map(item => item.id === tier.id ? { ...item, kind } : item));
            }} /> : null}
          <RoutingIconButton label={t('删除功能')} onClick={() => removePool(tier.id)}><IconTrash size={14} /></RoutingIconButton>
        </div>
      </>}</RoutingDetails> : null}
    </fieldset>;
  };

  return <>
    <div className="worker-routing-pane" data-layer={layer}>
      {layer === 'workspace' && saved && draft ? <div className="worker-routing-layer-status">
        <span role="status">{t(intent === 'follow' ? '保存后恢复跟随全局'
          : saved.origin === 'workspace' ? '当前工作区有独立派活配置'
            : dirty ? '待保存为工作区配置' : '当前工作区跟随全局默认')}</span>
        <div className="worker-routing-buttons">
          {intent === 'follow' ? <button type="button" className="btn ghost tiny" disabled={busy || saving}
            onClick={() => setIntent(null)}>{t('取消恢复')}</button> : <>
            {workspaceOverride ? <button type="button" className="btn ghost tiny" disabled={busy || saving} onClick={() => {
              if (saved.origin === 'workspace') setIntent('follow');
              else { setDraft(saved.config); setIntent(null); }
              setFeedback('');
            }}>{t('恢复跟随全局')}</button> : null}
            {!workspaceOverride || draft.tiers.length > 0 ? <button type="button" className="btn ghost tiny" disabled={busy || saving} onClick={() => {
              setDraft({ ...draft, tiers: [] }); setIntent('empty-override'); setFeedback('');
            }}>{t('仅此工作区留空')}</button> : null}
          </>}
        </div>
      </div> : null}
      {roots.length > 1 && intent !== 'follow' ? <div className="worker-routing-source">
        <span>{t('用于校验的源文件夹')}</span>
        <CustomSelect ariaLabel={t('用于校验的源文件夹')} className="worker-routing-source-select" menuClassName="task-source-menu"
          value={scope?.rootId ?? ''} disabled={busy || saving || !!editor || pendingAuthorization} placeholder={t('请选择源文件夹')}
          options={roots.map(root => ({ value: root.id, label: root.path }))} onChange={value => {
            if (!busy && !saving && !editor && !pendingAuthorization) setRootId(value);
          }} />
        {pendingAuthorization ? <p className="settings-hint">{t('请先保存或撤销跨 Harness 授权，再切换源文件夹。')}</p> : null}
      </div> : null}
      {!scope ? <p role="status" className="settings-hint">{t('请先打开具有有效源文件夹的工作区。')}</p> : null}
      {busy && !draft ? <p role="status" className="settings-hint">{t('正在读取派活配置…')}</p> : null}
      {error ? <ErrorTip message={error} /> : null}
      {feedback ? <p role="status" className="settings-ok">{feedback}</p> : null}
      {intent === 'follow' ? <div className="worker-routing-follow-preview">
        <strong>{t('已保存的全局默认')}</strong>
        {followPreview && 'config' in followPreview ? followPreview.config.tiers.some(tier => tier.members.some(member => member.enabled)) ?
          <ul>{[...followPreview.config.tiers].sort((a, b) => workerRoutingTierKindRank(a.kind ?? 'special') - workerRoutingTierKindRank(b.kind ?? 'special'))
            .filter(tier => tier.members.some(member => member.enabled)).map(tier => <li key={tier.id}>
              <span>{tierTitle(tier)}</span>
              <small>{tier.members.filter(member => member.enabled).map(member => workerTargetLabel(member.config, t('跟随引擎默认'))).join(' / ')}</small>
            </li>)}</ul> : <p className="settings-hint">{t('暂无启用的候选')}</p>
          : <p className="settings-hint" role="status">{followPreview?.error || t('正在读取派活配置…')}</p>}
      </div> : null}
      {intent !== 'follow' ? <><div className="worker-routing-standard">
        {standardSlots.map(({ kind, tier }) => renderPool(tier ? { tierId: tier.id } : { kind }, tier, kind))}
      </div>
      {atLimit && standardSlots.some(slot => !slot.tier) ? <p role="status" className="settings-hint">
        {t('已达候选池上限，可将特殊功能分配到空标准档。')}
      </p> : null}
      <section className="worker-routing-special" aria-label={t('特殊功能')}>
        <div className="worker-routing-tier-head">
          <h3><IconSparkle size={16} />{t('特殊功能')}</h3>
          {draft && !atLimit ? <button ref={specialTrigger} type="button" className="btn ghost tiny worker-routing-icon-button"
            aria-label={t('添加特殊功能')} title={t('添加特殊功能')} aria-expanded={specialOpen}
            aria-controls={specialPresence.mounted ? specialFormId : undefined} onClick={() => setNewSpecialOpen(value => !value)}><IconPlus size={16} /></button> : null}
        </div>
        {specialPresence.mounted ? <div className={`acc${specialOpen && specialPresence.stage === 'in' ? ' is-open' : ''}`} {...specialPresence.spread}>
          <div className="acc-body" id={specialFormId} aria-hidden={!specialOpen || undefined} ref={node => { if (node) node.inert = !specialOpen; }}>
          <form className="worker-routing-special-form" onSubmit={event => {
            event.preventDefault();
            const name = newSpecial.name.trim();
            if (!name || !ready || atLimit) return;
            mutate(tiers => [...tiers, { id: randomUuid(), kind: 'special', name, description: newSpecial.description.trim(), members: [], fallbackTierIds: [] }]);
            setNewSpecial({ name: '', description: '' });
            setNewSpecialOpen(false);
            specialTrigger.current?.focus();
          }}>
            <fieldset disabled={!ready}>
              <SpecialPoolFields value={newSpecial} onChange={setNewSpecial} />
              <button type="submit" className="btn tiny" disabled={!newSpecial.name.trim()}>{t('添加功能')}</button>
            </fieldset>
          </form>
          </div>
        </div> : null}
        {specialPools.length ? <div className="worker-routing-special-pools">
          {specialPools.map(tier => renderPool({ tierId: tier.id }, tier))}
        </div> : <p className="settings-hint">{t('暂无特殊功能')}</p>}
      </section>
      </> : null}
      {scope ? <div className="worker-routing-buttons worker-routing-footer">
        <button type="button" className="btn ghost tiny" disabled={busy || saving} onClick={() => {
          discardDraft.current = true;
          setFeedback('');
          setNewSpecialOpen(false);
          setNewSpecial({ name: '', description: '' });
          setReload(value => value + 1);
        }}><IconRefresh size={14} />{t(dirty ? '放弃更改并重新载入' : '重新载入')}</button>
      </div> : null}
    </div>
    <WorkerTargetDialog request={active && workerRoutingScopeKey(editor?.dialog.scope) === scopeKey ? editor?.dialog ?? null : null} onClose={closeEditor} onSelect={reference => {
      if (!editor || !active || workerRoutingScopeKey(editor.dialog.scope) !== scopeKey) return;
      const { memberId, target } = editor;
      const config = reference.config;
      const createMember = () => ({ id: randomUuid(), enabled: true, config });
      if ('tierId' in target) editTier(target.tierId, tier => ({ ...tier, members: memberId
        ? tier.members.map(member => member.id !== memberId || JSON.stringify(member.config) === JSON.stringify(config) ? member :
          withAuthorization({ ...member, config }, undefined))
        : [...tier.members, createMember()] }));
      else {
        const { kind } = target;
        mutate(tiers => {
          const current = tiers.find(tier => tier.kind === kind);
          if (current) return tiers.map(tier => tier.id === current.id ? { ...tier, members: [...tier.members, createMember()] } : tier);
          if (tiers.length >= WORKER_ROUTING_LIMITS.tiers) return tiers;
          return [...tiers, { id: randomUuid(), kind, name: tierNames[kind], description: '', members: [createMember()], fallbackTierIds: [] }];
        });
      }
      closeEditor();
    }} />
  </>;
}
