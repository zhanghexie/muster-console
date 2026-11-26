import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeConfigIntent, NativeConfigOption, NativeConfigSnapshot, NativeConfigValue } from '../../../shared/nativeSessionConfig';
import { nativeOptionAccepts, sameNativeConfigIdentity } from '../../../shared/nativeSessionConfig';
import { CustomSelect, type SelectOption } from './CustomSelect';
import { usePresence, MOTION } from './motion';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { IconChevronDown, IconRefresh } from './icons';
import { PermissionConfiguration, type PermissionConfigurationControl } from './PermissionConfiguration';
import { showTip } from '../tips';

type CatalogRequest = Parameters<typeof window.api.agentSession.describeNativeConfig>[0];

// Localize familiar field titles only; native IDs, choices and unknown titles stay intact.
const nativeTitleKeys = new Map([
  ['permission mode', '权限模式'], ['permission profile', '权限配置'],
  ['approval mode', '审批模式'], ['approval policy', '审批策略'],
  ['approvals reviewer', '审批者'], ['approval reviewer', '审批者'],
  ['collaboration mode', '协作模式'], ['sandbox', '沙箱'], ['sandbox policy', '沙箱策略'],
  ['multitask', '多任务'], ['workflow mode', '工作流模式'], ['mode', '模式'],
  ['session limits', '会话限制'], ['reviewer authority', '审核权限'],
  ['filesystem', '文件系统'], ['network', '网络']
]);

function encode(value: NativeConfigValue): string {
  return JSON.stringify(value);
}

function NativeConfigRefresh({ loading, disabled, onClick }: { loading: boolean; disabled?: boolean; onClick(): void }) {
  const { t } = useTranslation();
  return <button type="button" className="native-config-refresh" aria-label={t('刷新引擎设置')}
    title={loading ? t('读取中…') : t('刷新引擎设置')} aria-busy={loading} disabled={disabled || loading} onClick={onClick}>
    <IconRefresh size={14} />
  </button>;
}

function NativeConfigField({ option, creation, requireExplicit, selected, disabled, menuEnabled, action, onChange }: {
  option: NativeConfigOption; creation?: boolean; requireExplicit?: boolean; selected?: NativeConfigValue; disabled?: boolean;
  menuEnabled?: boolean;
  action?: React.ReactNode;
  onChange(value: NativeConfigValue | undefined): void;
}) {
  const { t } = useTranslation();
  const titleKey = nativeTitleKeys.get(option.name.trim().toLowerCase());
  const title = titleKey ? t(titleKey) : option.name;
  const choices = useMemo<SelectOption[]>(() => {
    const itemToOption = (item: import('../../../shared/nativeSessionConfig').NativeConfigChoice) => ({
      value: encode(item.value), label: item.name,
      disabled: item.disabled || (item.launchOnly && !creation)
    });
    const native = option.type === 'boolean'
      ? [{ value: 'true', label: t('开启') }, { value: 'false', label: t('关闭') }]
      : (option.choices ?? []).flatMap(choice => 'choices' in choice
        ? choice.choices.map(item => ({ ...itemToOption(item), group: choice.name }))
        : [itemToOption(choice)]);
    return creation && !requireExplicit ? [{ value: '', label: t('跟随引擎默认') }, ...native] : native;
  }, [option, creation, requireExplicit, t]);
  const current = selected !== undefined ? encode(selected) : '';
  const displayOnly = option.changePolicy === 'read-only' || (!creation && option.changePolicy === 'launch-only');
  const status = selected === undefined ? t(requireExplicit ? '选择原生权限' : '等待引擎报告当前值') : String(selected);
  const id = React.useId();
  return <div className="native-config-field">
    <div className="native-config-field-heading"><label htmlFor={id}>{title}</label>{action}</div>
    {displayOnly
      ? <output id={id} title={status}>{status}</output>
      : <CustomSelect id={id} ariaLabel={title} value={current} placeholder={status} menuEnabled={menuEnabled}
        menuClassName="native-config-select-menu task-permission-menu" options={choices} disabled={disabled || choices.length === 0}
        onChange={value => onChange(value === '' ? undefined : JSON.parse(value) as NativeConfigValue)} />}
    {option.changePolicy === 'launch-only' ? <small>{t('仅在启动时生效')}</small> : null}
  </div>;
}

function stateText(snapshot: NativeConfigSnapshot | null, t: (key: string) => string): string {
  if (!snapshot || snapshot.status === 'uninitialized') return t('尚未读取引擎设置');
  if (snapshot.status === 'unsupported') return t('引擎自行管理设置');
  if (snapshot.status === 'error') return snapshot.error || t('读取引擎设置失败');
  return snapshot.options.length ? '' : t('引擎没有公开可调设置');
}

/** Launch discovery uses a registered source and caches the directory independently of any session. */
export function NativeConfigLaunchFields({ target, selection, onChange, disabled, menuEnabled, permissionsOnly = false, allowedValues, onSelectionReady }: {
  target: Omit<CatalogRequest, 'refresh'>; selection?: NativeConfigIntent;
  onChange(value: NativeConfigIntent | undefined): void; disabled?: boolean;
  menuEnabled?: boolean;
  permissionsOnly?: boolean;
  allowedValues?: Readonly<Record<string, readonly string[]>>;
  onSelectionReady?: (ready: boolean) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<NativeConfigSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const key = JSON.stringify(target);
  const load = async (refresh: boolean) => {
    const request = ++generation.current;
    setError('');
    setLoading(true);
    try {
      const result = await window.api.agentSession.describeNativeConfig({ ...target, refresh });
      if (request === generation.current) setSnapshot(result);
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    setSnapshot(null);
    void load(false);
    const off = window.api.on('agentSession:modelCatalogUpdated', event => {
      if (event.error || event.runtimeId !== target.runtimeId || event.agentId !== target.presetId ||
          event.workspaceId !== target.source.workspaceId || event.rootId !== target.source.rootId) return;
      void load(false);
    });
    return () => { generation.current++; off(); };
  }, [key]);
  const matching = snapshot && selection && sameNativeConfigIdentity(snapshot.identity, selection.identity) ? selection : undefined;
  const options = (snapshot?.options ?? []).filter(option =>
    option.changePolicy !== 'read-only' && (!permissionsOnly || option.category === 'permissions')).map(option => {
    const allowed = allowedValues?.[option.id];
    if (!allowed || option.type !== 'select') return option;
    const choices = (option.choices ?? []).flatMap<NonNullable<NativeConfigOption['choices']>[number]>(choice => {
      if (!('choices' in choice)) return allowed.includes(choice.value) ? [choice] : [];
      const choices = choice.choices.filter(item => allowed.includes(item.value));
      return choices.length ? [{ ...choice, choices }] : [];
    });
    return { ...option, choices };
  });
  const selectionReady = !loading && !error && snapshot?.status === 'ready' && !!matching && options.length > 0 &&
    matching.selections.length === options.length && options.every(option =>
      nativeOptionAccepts(option, matching.selections.find(item => item.id === option.id)?.value));
  useEffect(() => {
    onSelectionReady?.(selectionReady);
    return () => { if (selectionReady) onSelectionReady?.(false); };
  }, [onSelectionReady, selectionReady]);
  const missingPermissions = permissionsOnly && snapshot?.status === 'ready' &&
    (!options.length || options.some(option => option.type === 'select' && !option.choices?.length));
  const detail = error || (!loading ? missingPermissions ? t('引擎没有返回所需的可选原生权限') : stateText(snapshot, t) : '');
  const refresh = <NativeConfigRefresh loading={loading} disabled={disabled} onClick={() => void load(true)} />;
  return <section className="native-config-fields" aria-label={t('引擎设置')} aria-busy={loading}>
    {snapshot && options.map((option, index) => <NativeConfigField key={option.id} action={index === 0 ? refresh : undefined}
      option={option} creation requireExplicit={permissionsOnly} disabled={disabled || loading} menuEnabled={menuEnabled} selected={matching?.selections.find(item => item.id === option.id)?.value}
      onChange={value => {
        if (permissionsOnly && value === matching?.selections.find(item => item.id === option.id)?.value) return;
        const selections = matching?.selections.filter(item => item.id !== option.id) ?? [];
        if (value !== undefined) selections.push({ id: option.id, value });
        onChange(selections.length ? { identity: snapshot.identity, selections } : undefined);
      }} />)}
    {selection && snapshot && !matching ? <>
      <small role="alert">{t('引擎或来源已变更，请重新选择设置')}</small>
      {!permissionsOnly ? <button type="button" className="agent-mode-chip" disabled={disabled}
        onClick={() => onChange(undefined)}>{t('跟随引擎默认')}</button> : null}
    </> : null}
    {detail ? <small role={error || snapshot?.status === 'error' ? 'alert' : 'status'}>{detail}</small> : null}
    {!options.length ? refresh : null}
  </section>;
}

type SessionControlProps = { sessionId: string; busy: boolean; disabled?: boolean; configuration?: PermissionConfigurationControl };

export function NativeSessionConfigControl(props: SessionControlProps) {
  return <SessionConfigControl key={props.sessionId} {...props} />;
}

function SessionConfigControl({ sessionId, busy, disabled, configuration }: SessionControlProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<NativeConfigSnapshot | null>(null);
  const [reading, setReading] = useState(false);
  const [writing, setWriting] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const live = useRef(false);
  const writeLock = useRef(false);
  const panelId = React.useId();
  const presence = usePresence(open, MOTION.menuMs);
  const manual = configuration?.enabled !== false;
  const observe = (next: NativeConfigSnapshot | null) => {
    if (!live.current || !next) return;
    setSnapshot(previous => previous && previous.revision > next.revision ? previous : next);
  };
  useEffect(() => {
    live.current = true;
    const off = window.api.on('agentSession:event', event => {
      if (event.sessionId === sessionId && event.kind === 'native-config') observe(event.snapshot);
    });
    return () => { live.current = false; off(); };
  }, [sessionId]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useOverlayDismiss(open, close);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (event.target instanceof Element && !container.current?.contains(event.target) &&
          !event.target.closest('.native-config-select-menu')) setOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [open]);
  const read = async (refresh: boolean) => {
    setReading(true);
    try {
      const next = await (refresh ? window.api.agentSession.refreshNativeConfig(sessionId) : window.api.agentSession.getNativeConfig(sessionId));
      if (!live.current) return;
      if (next?.status === 'error') showTip(stateText(next, t), { tone: 'error' });
      else observe(next);
    } catch (cause) {
      if (live.current) showTip(cause instanceof Error ? cause.message : String(cause), { tone: 'error' });
    } finally { if (live.current) setReading(false); }
  };
  useEffect(() => { if (open && manual) void read(false); }, [open, manual]);
  const change = async (option: NativeConfigOption, value: NativeConfigValue | undefined) => {
    if (!manual || !snapshot || value === undefined || writeLock.current) return;
    writeLock.current = true;
    setWriting(true);
    try {
      const result = await window.api.agentSession.setNativeConfig(sessionId, { identity: snapshot.identity, revision: snapshot.revision, id: option.id, value });
      if (!live.current) return;
      if (!result.ok) showTip(result.error ?? t('引擎拒绝了设置变更'), { tone: 'error' });
      else {
        if (result.snapshot) observe(result.snapshot);
      }
    } catch (cause) {
      if (live.current) showTip(cause instanceof Error ? cause.message : String(cause), { tone: 'error' });
    } finally {
      writeLock.current = false;
      if (live.current) setWriting(false);
    }
  };
  const detail = !reading ? stateText(snapshot, t) : '';
  const refresh = <NativeConfigRefresh loading={reading} disabled={disabled || !manual || configuration?.disabled || writing || busy} onClick={() => void read(true)} />;
  const fields = <>
    {snapshot?.options.map((option, index) => <NativeConfigField key={option.id} option={option} selected={option.currentValue}
      action={index === 0 ? refresh : undefined} menuEnabled={open && manual}
      disabled={disabled || !manual || configuration?.disabled || reading || writing || (busy && option.changePolicy !== 'live')}
      onChange={value => void change(option, value)} />)}
    {snapshot?.requested?.map(request => {
      const option = snapshot.options.find(item => item.id === request.id);
      const choices = option?.choices?.flatMap(item => 'choices' in item ? item.choices : [item]);
      const name = typeof request.value === 'boolean' ? t(request.value ? '开启' : '关闭')
        : choices?.find(item => item.value === request.value)?.name ?? request.value;
      return <small key={request.id} role="status">{t('等待引擎确认设置')} · {option?.name ?? request.id} · {name}</small>;
    })}
    {detail ? <small role="status">{detail}</small> : null}
    {!snapshot?.options.length ? refresh : null}
  </>;
  return <div className="native-config-anchor" ref={container}>
    <button ref={trigger} type="button" className="agent-mode-chip" aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} disabled={disabled}
      onClick={() => setOpen(!open)}>
      {t('引擎设置')} <IconChevronDown size={12} />
    </button>
    {presence.mounted ? <section className="agent-mode-menu native-config-popover mp-pop mp-pop-up" id={panelId} role="dialog" aria-label={t('引擎设置')}
      ref={node => { if (node) node.inert = !open; }} aria-hidden={!open} data-mp-stage={presence.stage}>
      {configuration ? <PermissionConfiguration {...configuration} className="permission-config-menu"
        disabled={disabled || configuration.disabled || writing}>{fields}</PermissionConfiguration> : fields}
    </section> : null}
  </div>;
}
