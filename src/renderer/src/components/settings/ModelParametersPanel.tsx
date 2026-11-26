import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentRuntimeEntry, AppConfig } from '../../../../shared/types';
import { runtimeSurface } from '../../../../shared/types';
import type { ModelParameterContext, ModelParameterProfile } from '../../../../shared/modelParameters';
import { modelParameterOptions } from '../../../../shared/modelParameters';
import { AdvancedDetails, FieldRow, SettingRow, SettingsRows, SettingsSection } from './shared';
import { CustomSelect } from '../CustomSelect';
import type { HarnessSettingsModel } from './HarnessModelSelectionPanel';

type Settings = ModelParameterProfile['parameters'];
const scopeKey = (p: { runtimeId: string; providerId?: string; modelId?: string }) => JSON.stringify([p.runtimeId, p.providerId || '', p.modelId || '']);

/** One editor for builtin and trusted registered runtime descriptors.（沉浸式行排版） */
export function ModelParametersPanel({ cfg, set, runtimes, focused }: { cfg: AppConfig; set: (patch: Partial<AppConfig>) => void; runtimes: AgentRuntimeEntry[]; focused?: { runtimeId: string; agentId?: string; models: HarnessSettingsModel[] } }): React.JSX.Element {
  const { t } = useTranslation();
  const available = runtimes.filter(r => runtimeSurface(r) === 'chat');
  const [runtimeId, setRuntimeId] = useState(focused?.runtimeId ?? '');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [context, setContext] = useState<ModelParameterContext | null>(null);
  const [draft, setDraft] = useState<Settings>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const request = useRef(0);
  const presetProvider = focused?.agentId ? `acp:${focused.agentId}` : undefined;
  const target = { runtimeId, ...((presetProvider || providerId.trim()) ? { providerId: presetProvider || providerId.trim() } : {}), ...(modelId.trim() ? { modelId: modelId.trim() } : {}) };
  const scopes = focused ? [
    { value: scopeKey({ runtimeId, providerId: presetProvider }), label: t('此聊天接入的所有模型'), providerId: presetProvider ?? '', modelId: '' },
    ...focused.models.map(model => { const provider = presetProvider || model.providerId || ''; const id = model.modelId ?? model.id;
      return { value: scopeKey({ runtimeId, providerId: provider, modelId: id }),
        label: model.group ? `${model.group.label} · ${model.name}` : model.name, providerId: provider, modelId: id }; })
  ] : [];
  for (const profile of focused ? cfg.modelParameterProfiles ?? [] : []) {
    if (profile.runtimeId !== runtimeId || (presetProvider && profile.providerId !== presetProvider) || scopes.some(scope => scope.value === scopeKey(profile))) continue;
    scopes.push({ value: scopeKey(profile), label: `${profile.providerId ? profile.providerId + ' / ' : ''}${profile.modelId || t('所有模型')} · ${t('已保存范围')}`, providerId: profile.providerId ?? '', modelId: profile.modelId ?? '' });
  }
  useEffect(() => { if (!runtimeId && available.length) setRuntimeId(available[0].id); }, [runtimeId, available]);
  useEffect(() => { ++request.current; setContext(null); setDraft({}); setMessage(''); setBusy(false); }, [runtimeId, providerId, modelId]);
  useEffect(() => () => { ++request.current; }, []);
  const change = (id: string, patch: Settings[string]) => setDraft(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const load = async () => {
    const id = ++request.current; setBusy(true); setMessage('');
    try {
      const next = await window.api.agentSession.describeModelParameters({ ...target, ...(focused?.agentId ? { piModeId: focused.agentId } : {}), refresh: true });
      if (id !== request.current) return;
      setContext(next);
      const settings = structuredClone(cfg.modelParameterProfiles?.find(p => scopeKey(p) === scopeKey(target))?.parameters ?? {});
      const rank = (p: { providerId?: string; modelId?: string }) => Number(!!p.modelId) * 2 + Number(!!p.providerId);
      for (const def of next?.parameters ?? []) {
        const options = settings[def.id]?.options ?? modelParameterOptions(next!, (cfg.modelParameterProfiles ?? []).filter(p => rank(p) <= rank(target)), def.id);
        const defaultValue = settings[def.id]?.defaultValue;
        settings[def.id] = { ...settings[def.id], options,
          ...(defaultValue != null && !options.some(o => o.value === defaultValue) ? { defaultValue: options.find(o => o.mappedValue === defaultValue)?.value ?? null } : {}) };
      }
      setDraft(settings);
      setMessage(next?.warning || (!next?.parameters.length ? t('该运行时或模型未声明可配置参数') : ''));
    } catch (e) { if (id === request.current) setMessage((e as Error).message); }
    finally { if (id === request.current) setBusy(false); }
  };
  const save = async (remove = false) => {
    if (!context) return;
    const id = ++request.current; setBusy(true); setMessage('');
    const profiles = (cfg.modelParameterProfiles ?? []).filter(p => scopeKey(p) !== scopeKey(target));
    if (!remove) profiles.push({ ...target, parameters: draft });
    try {
      const result = await window.api.agentSession.saveParameterProfiles(profiles);
      if (id !== request.current) return;
      if (result.ok) { set({ modelParameterProfiles: result.profiles ?? profiles }); if (remove) setDraft({}); setMessage(t('参数配置已保存；运行中的会话将在下一轮生效')); }
      else setMessage(result.error || t('保存失败'));
    } catch (e) { if (id === request.current) setMessage((e as Error).message); }
    finally { if (id === request.current) setBusy(false); }
  };
  return <SettingsSection
    title={t('模型参数')}
    desc={t(focused ? '设置工作台聊天的默认参数。会话中单独选择的值优先，原生终端不受影响。' : '思考强度等参数由运行时声明。可以配置名称、档位映射和默认值，档位数量不限。')}
  >
    <SettingsRows>
      {focused ? <SettingRow title={t('应用范围')}><CustomSelect ariaLabel={t('参数应用范围')} value={scopeKey(target)} disabled={busy}
        options={scopes} onChange={value => { const scope = scopes.find(item => item.value === value); if (scope) { setProviderId(scope.providerId); setModelId(scope.modelId); } }}/></SettingRow> : <>
      <SettingRow title={t('运行时')}>
        <CustomSelect
          testId="mp-runtime"
          className="s-select"
          ariaLabel={t('运行时')}
          placeholder={t('暂无可用运行时')}
          disabled={busy || !available.length}
          value={runtimeId}
          onChange={v => setRuntimeId(v)}
          options={available.map(r => ({ value: r.id, label: r.label }))}
        />
      </SettingRow>
      <FieldRow label={t('服务商 ID（可选）')} tip={t('留空应用于该运行时')}>
        <input aria-label={t('服务商 ID（可选）')} className="s-input mono" style={{ maxWidth: 280 }} disabled={busy} value={providerId} onChange={e => setProviderId(e.target.value)} />
      </FieldRow>
      <FieldRow label={t('模型 ID（可选）')} tip={t('留空设置运行时默认')}>
        <input aria-label={t('模型 ID（可选）')} className="s-input mono" style={{ maxWidth: 280 }} disabled={busy} value={modelId} onChange={e => setModelId(e.target.value)} />
      </FieldRow>
      </>}
      <SettingRow divided title={<span className="s-muted">{focused ? t(context ? '参数已读取' : '读取当前范围的原生参数') : context ? <>{context.providerId} / {context.modelId || t('引擎默认')}</> : t('读取该范围的参数声明后在此编辑')}</span>}>
        <button type="button" className="btn tiny" disabled={busy || !runtimeId} onClick={() => void load()}>{t('读取可用参数')}</button>
      </SettingRow>
      {context?.parameters.map(def => {
        const setting = draft[def.id] ?? {};
        const options = setting.options ?? def.options.map(o => ({ ...o, mappedValue: o.value }));
        const control = <>
            <CustomSelect
              ariaLabel={`${def.id} ${t('默认值')}`}
              className="s-select"
              disabled={busy}
              value={setting.defaultValue ?? ''}
              onChange={v => change(def.id, { defaultValue: v || null })}
              options={[{ value: '', label: t('跟随默认') }, ...options.map(o => ({ value: o.value, label: o.label }))]}
            />        </>;
        const customization = <>
          <FieldRow label={t('显示名称')}>
            <input aria-label={`${def.id} ${t('显示名称')}`} className="s-input" style={{ maxWidth: 280 }} disabled={busy} value={setting.label ?? def.label} onChange={e => change(def.id, { label: e.target.value })} />
          </FieldRow>

          <p className="s-sec-desc" style={{ margin: 0 }}>{t('选项标识用于保存会话选择；映射目标必须是运行时支持的值。')}</p>
          {options.map((option, index) => <div key={index} className="model-parameter-option">
            <input aria-label={`${def.id} ${index + 1} ${t('选项标识')}`} disabled={busy} value={option.value} onChange={e => change(def.id, { options: options.map((o, i) => i === index ? { ...o, value: e.target.value } : o), ...(setting.defaultValue === option.value ? { defaultValue: e.target.value } : {}) })} />
            <input aria-label={`${def.id} ${index + 1} ${t('显示名称')}`} disabled={busy} value={option.label} onChange={e => change(def.id, { options: options.map((o, i) => i === index ? { ...o, label: e.target.value } : o) })} />
            <CustomSelect
              ariaLabel={`${def.id} ${index + 1} ${t('映射目标')}`}
              className="mp-target-select"
              disabled={busy}
              value={option.mappedValue}
              onChange={v => change(def.id, { options: options.map((o, i) => i === index ? { ...o, mappedValue: v } : o) })}
              options={def.options.map(o => ({ value: o.value, label: o.label }))}
            />
            <button type="button" className="btn" aria-label={`${def.id} ${index + 1} ${t('上移')}`} disabled={busy || index === 0} onClick={() => { const next = [...options]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; change(def.id, { options: next }); }}>↑</button>
            <button type="button" className="btn" aria-label={`${def.id} ${index + 1} ${t('删除')}`} disabled={busy || options.length === 1} onClick={() => change(def.id, { options: options.filter((_, i) => i !== index), ...(setting.defaultValue === option.value ? { defaultValue: null } : {}) })}>×</button>
          </div>)}
          <div className="model-parameter-actions">
            <button type="button" className="btn tiny" disabled={busy} onClick={() => { let value = `option-${options.length + 1}`; while (options.some(o => o.value === value)) value += '-new'; change(def.id, { options: [...options, { value, label: t('新档位'), mappedValue: def.options[0].value }] }); }}>{t('添加档位')}</button>
            <button type="button" className="btn ghost tiny" disabled={busy} onClick={() => change(def.id, { options: def.options.map(o => ({ ...o, mappedValue: o.value })), defaultValue: null, label: def.label })}>{t('恢复原生选项')}</button>
          </div>
        </>;
        return focused ? <div className="worker-parameter-control" key={def.id}>
          <SettingRow title={def.label || def.id} desc={t('默认值；留空跟随引擎')}>{control}</SettingRow>
          <AdvancedDetails summary={t('自定义名称与选项')}>{customization}</AdvancedDetails>
        </div> : <AdvancedDetails key={def.id} summary={def.label || def.id}>
          <SettingRow title={t('默认值')}>{control}</SettingRow>{customization}
        </AdvancedDetails>;
      })}
      {!!context?.parameters.length && <SettingRow divided title={null}>
        <button type="button" className="btn ghost tiny" disabled={busy} onClick={() => void save(true)}>{t('清除该范围配置')}</button>
        <button type="button" className="btn primary tiny" disabled={busy} onClick={() => void save()}>{t('保存参数配置')}</button>
      </SettingRow>}
      {message && <SettingRow divided title={<span role="status" className="s-muted">{message}</span>}>{null}</SettingRow>}
    </SettingsRows>
  </SettingsSection>;
}
