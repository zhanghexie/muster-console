import { ErrorTip } from '../ErrorTip';
import React, { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { WorkerRoutingScope, WorkerTargetConfig, WorkerTargetReference } from '../../../../shared/workerRouting';
import { workerModelInvocation } from '../../../../shared/workerModelMention';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { AnimatedDetails } from '../AnimatedDetails';
import { HarnessModelPicker, type PickerInitialSelection, type PickerSelection } from '../HarnessModelPicker';
import { usePresenceValue } from '../motion';
import { workerRoutingScopeKey } from './workerRoutingScope';
import './worker-routing.css';

export interface WorkerTargetDialogRequest {
  scope: WorkerRoutingScope;
  initial?: WorkerTargetConfig;
  currentRef?: string;
  currentLabel?: string;
  editing?: boolean;
  restoring?: boolean;
  stale?: boolean;
}

interface Props {
  request: WorkerTargetDialogRequest | null;
  onClose: () => void;
  onSelect: (reference: WorkerTargetReference, label: string) => void;
  mention?: boolean;
}

export function WorkerTargetDialog({ request, onClose, onSelect, mention = false }: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  const { value, presence } = usePresenceValue(request);
  const titleId = useId();
  useOverlayDismiss(!!request && presence.stage !== 'out', onClose);
  if (!value) return null;
  return createPortal(<div className="new-task-overlay mp-scrim" {...presence.spread}
    {...(!request ? { inert: '' } : {})} onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="new-task-dialog worker-target-dialog mp-panel" {...presence.spread} data-overlay-root=""
      role="dialog" aria-modal="true" aria-labelledby={titleId} aria-hidden={!request || undefined}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <div className="new-task-head">
        <h2 id={titleId} className="new-task-title">{mention ? t(value.editing ? '编辑模型引用' : '插入模型引用') : t(value.editing ? '编辑候选配置' : '添加候选配置')}</h2>
        <button type="button" className="modal-close" autoFocus={value.restoring} aria-label={t('关闭')} onClick={onClose}>×</button>
      </div>
      {value.restoring ? <p className="settings-hint" role="status">{t('正在校验模型配置…')}</p> :
        <WorkerTargetForm key={JSON.stringify([workerRoutingScopeKey(value.scope), value.currentRef, value.initial])}
          request={value} active={!!request} onClose={onClose} onSelect={onSelect} mention={mention} />}
    </div>
  </div>, document.body);
}

function WorkerTargetForm({ request, active, onClose, onSelect, mention }: Omit<Props, 'request'> & { request: WorkerTargetDialogRequest; active: boolean }) {
  const { t } = useTranslation();
  const { scope, initial } = request;
  const [surface, setSurface] = useState<WorkerTargetConfig['surface']>(initial?.surface ?? 'gui');
  const original = initial?.surface === surface ? initial : undefined;
  const initialSelection: PickerInitialSelection | undefined = original && {
    harness: { harnessId: original.harnessId, runtimeId: original.runtimeId, surface, acpPresetId: original.acpPresetId },
    model: original.surface === 'gui' ? original.model ?? null : undefined,
    nativeLaunchModel: original.cliLaunchOptions?.model,
    parameters: original.modelParameters ?? (original.cliLaunchOptions?.reasoning ? { reasoning: original.cliLaunchOptions.reasoning } : undefined)
  };
  const binding = React.useRef({ active, surface });
  binding.current = { active, surface };
  React.useEffect(() => () => { binding.current.active = false; }, []);

  const choose = async ({ harness, harnessLabel, model, nativeLaunchModel, parameters, catalog }: PickerSelection) => {
    const runtimeId = harness.runtimeId;
    const config: WorkerTargetConfig = { ...harness };
    if (surface === 'gui') {
      if (model) config.model = { providerId: model.providerId, modelId: model.modelId };
      if (Object.keys(parameters).length) config.modelParameters = parameters;
    } else {
      const { model: _oldModel, reasoning: _oldReasoning, ...previous } = original?.runtimeId === runtimeId ? original.cliLaunchOptions ?? {} : {};
      const launch = { ...previous, ...(nativeLaunchModel ? { model: nativeLaunchModel } : {}),
        ...(parameters.reasoning ? { reasoning: parameters.reasoning } : {}) };
      if (Object.keys(launch).length) config.cliLaunchOptions = launch;
    }
    const reference = await window.api.workerRouting.reference({ scope, config });
    if (binding.current.active && binding.current.surface === surface) {
      const actual = reference.config;
      const concrete = catalog.models.find(row => row.providerId === actual.model?.providerId && row.modelId === actual.model?.modelId ||
        row.nativeLaunchModel !== undefined && row.nativeLaunchModel === actual.cliLaunchOptions?.model);
      const selectedModel = concrete?.label ?? actual.cliLaunchOptions?.model ?? actual.model?.modelId ?? t('跟随引擎默认');
      const reasoning = catalog.parameters?.find(control => control.descriptor.semantic === 'reasoning')?.descriptor;
      const effort = reasoning?.options.find(option => option.value === parameters[reasoning.id])?.label;
      onSelect(reference, [harnessLabel, actual.surface.toUpperCase(), selectedModel, ...(effort ? [effort] : [])].join(' · '));
    }
    return { ok: true };
  };

  return <>
    <div className="new-task-surfaces" role="tablist" aria-label={t('会话类型')} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
      event.preventDefault();
      const next = tabs.find(tab => tab !== event.target);
      next?.focus(); next?.click();
    }}>
      {(['gui', 'cli'] as const).map(kind => <button key={kind} type="button" role="tab" aria-selected={kind === surface}
        onClick={() => setSurface(kind)}>{kind.toUpperCase()}</button>)}
    </div>
    {request.stale ? <ErrorTip message={t('此模型引用已失效，请重新选择。')} /> : null}
    <HarnessModelPicker key={surface} target={{ source: scope, surface }} initial={initialSelection} active={active} exact
      confirmLabel={t(mention && !request.editing ? '插入引用' : '确认配置')} onCancel={onClose} onConfirm={choose} />
    {request.currentRef ? <AnimatedDetails className="worker-target-reference" summary={t('查看调用方法')}>
      {request.currentLabel ? <p>{request.currentLabel}</p> : null}
      <code>{workerModelInvocation(request.currentRef)}</code>
    </AnimatedDetails> : null}
  </>;
}
