import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeModelCatalogEndpoint, type PiCatalogView } from '../../../shared/piCatalog';
import type { LlmConfig, LlmModelConfig, LlmProviderConfig } from '../../../shared/types';
import { BrandLoader, BrandLoading } from '../components/BrandLoader';
import { CustomSelect } from '../components/CustomSelect';
import { IconCheck, IconSparkle } from '../components/icons';
import { SetupActions, SetupNext, useSetupAction } from './SetupParts';

const PROTOCOLS = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' }
] as const;
type ProbeProtocol = typeof PROTOCOLS[number]['value'];
type ModelRoute = LlmModelConfig & { baseUrl: string; api: ProbeProtocol };
type ProviderOption = { id: string; name: string; models: ModelRoute[]; defaultModel?: string };

function supportedProtocol(value?: string): value is ProbeProtocol {
  return PROTOCOLS.some(protocol => value === protocol.value);
}

function providerOptions(llm: LlmConfig | undefined, catalog: PiCatalogView | null): ProviderOption[] {
  const options = new Map<string, ProviderOption>();
  for (const provider of catalog?.providers ?? []) {
    if (provider.accountEndpointExample || !provider.authMethods.includes('apiKey')) continue;
    const models = provider.models.flatMap(model => {
      const api = model.api || provider.api;
      const baseUrl = model.baseUrl || provider.baseUrl;
      return supportedProtocol(api) && baseUrl && normalizeModelCatalogEndpoint(baseUrl, api)
        ? [{ id: model.id, name: model.name || model.id, baseUrl, api }] : [];
    });
    if (models.length) options.set(provider.id, { id: provider.id, name: provider.name, models });
  }
  const active = llm?.providers.find(provider => provider.id === llm.activeProviderId);
  const api = active?.api ?? 'openai-completions';
  if (active?.baseUrl && supportedProtocol(api) && active.models.length) {
    const catalogOption = options.get(active.id);
    const registeredIds = new Set(active.models.map(model => model.id));
    const sameEndpoint = (model: ModelRoute): boolean => model.api === api &&
      normalizeModelCatalogEndpoint(model.baseUrl, api) === normalizeModelCatalogEndpoint(active.baseUrl, api);
    options.set(active.id, { id: active.id, name: active.name, defaultModel: llm?.activeModelId, models: [
      ...active.models.map(model => ({ ...model, baseUrl: active.baseUrl, api })),
      ...(catalogOption?.models.filter(model => !registeredIds.has(model.id) && sameEndpoint(model)) ?? [])
    ] });
  }
  return [...options.values()];
}

function configuredModel(llm?: LlmConfig): { name: string; model: string } | undefined {
  const provider = llm?.providers.find(item => item.id === llm.activeProviderId);
  const model = provider?.models.find(item => item.id === llm?.activeModelId);
  if (provider?.apiKey.trim() && provider.baseUrl.trim() && provider.enabled !== false && model) {
    return { name: provider.name, model: model.name || model.id };
  }
}

function withProvider(llm: LlmConfig | undefined, draft: Omit<LlmProviderConfig, 'models'>, model: LlmModelConfig): LlmConfig {
  const providers = llm?.providers ?? [];
  const existing = providers.find(provider => provider.id === draft.id && provider.baseUrl === draft.baseUrl &&
    (provider.api ?? 'openai-completions') === draft.api);
  const ids = new Set(providers.map(provider => provider.id));
  let id = draft.id;
  for (let suffix = 1; !existing && ids.has(id); suffix++) id = `${draft.id}_${suffix}`;
  const models = existing?.models.some(item => item.id === model.id) ? existing.models : [...(existing?.models ?? []), model];
  const next = { ...existing, ...draft, id, models, enabled: true };
  return {
    providers: existing ? providers.map(provider => provider.id === id ? next : provider) : [...providers, next],
    activeProviderId: id,
    activeModelId: model.id
  };
}

const CUSTOM = 'custom-endpoint';

export function ConnectModel({ back, next, onSkip }: { back: () => void; next: () => void; onSkip: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const { busy, error, run, clearError } = useSetupAction();
  const [options, setOptions] = useState<ProviderOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [configured, setConfigured] = useState<ReturnType<typeof configuredModel>>();
  const [providerId, setProviderId] = useState(CUSTOM);
  const [modelId, setModelId] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [protocol, setProtocol] = useState<ProbeProtocol>('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const id = useId();

  useEffect(() => {
    let live = true;
    // Both reads are local. Listing providers never submits a key or sends a model request.
    void Promise.allSettled([window.api.config.get(), window.api.config.piCatalog()]).then(([config, catalog]) => {
      if (!live) return;
      const llm = config.status === 'fulfilled' ? config.value.llm : undefined;
      const list = providerOptions(llm, catalog.status === 'fulfilled' ? catalog.value : null);
      const initial = list.find(option => option.id === llm?.activeProviderId) ?? list[0];
      setOptions(list);
      setProviderId(initial?.id ?? CUSTOM);
      setModelId(initial?.defaultModel ?? initial?.models[0]?.id ?? '');
      setConfigured(configuredModel(llm));
      if (config.status === 'rejected') setLoadError(t('读取模型设置失败，可以稍后在设置中重试。'));
      setLoaded(true);
    });
    return () => { live = false; };
    // This draft is seeded once and retained when navigating back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const custom = providerId === CUSTOM;
  const provider = options.find(option => option.id === providerId);
  const route = provider?.models.find(model => model.id === modelId);
  const baseUrl = custom ? customUrl.trim() : route?.baseUrl ?? '';
  const api = custom ? protocol : route?.api;
  const selectedModelId = route?.id ?? customModel.trim();
  const model: LlmModelConfig = { id: selectedModelId, name: route?.name ?? selectedModelId };

  const skip = (): void => { setApiKey(''); clearError(); onSkip(); };
  const save = (): void => void run(async () => {
    const key = apiKey.trim();
    const url = URL.parse(baseUrl);
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(t('请输入不含账号、查询参数或片段的 HTTP 或 HTTPS 接口地址。'));
    }
    if (!api || !selectedModelId || !key) throw new Error(t('请填写模型和 API Key。'));
    try {
      const checked = await window.api.config.testLlm({ baseUrl, apiKey: key, model: selectedModelId, api });
      if (!checked.ok) throw new Error(checked.error || t('连接失败，请检查接口地址、模型和 API Key。'));
      const latest = await window.api.config.get();
      const draft = { id: provider?.id ?? 'custom', name: provider?.name ?? t('自定义供应商'), baseUrl, apiKey: key, api };
      const updated = await window.api.config.update({ llm: withProvider(latest.llm, draft, model) });
      const saved = configuredModel(updated.llm);
      if (!saved) throw new Error(t('模型设置未保存，请重试。'));
      setConfigured(saved);
      setApiKey('');
      next();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new Error(message.replaceAll(key, '••••'));
    }
  });

  if (configured) return <>
    <div className="setup-card setup-row">
      <IconSparkle size={20} />
      <div className="setup-row-text"><strong>{configured.name}</strong><span>{configured.model}</span></div>
      <span className="setup-badge is-success"><IconCheck />{t('已配置')}</span>
    </div>
    <SetupActions back={back}><SetupNext onClick={next} /></SetupActions>
  </>;

  return <form method="post" onSubmit={event => {
    event.preventDefault();
    if (loaded && !loadError && !busy) save();
  }}>
    {!loaded ? <BrandLoading>{t('正在读取模型供应商…')}</BrandLoading> : loadError ? <p role="alert" className="setup-error">{loadError}</p> : <>
      <div className="setup-fields-grid">
        <div className="setup-field">
          <label htmlFor={`${id}-provider`}>{t('模型供应商')}</label>
          <CustomSelect id={`${id}-provider`} value={providerId} disabled={busy} options={[
            ...options.map(option => ({ value: option.id, label: option.name })), { value: CUSTOM, label: t('自定义供应商') }
          ]} onChange={value => {
            const option = options.find(item => item.id === value);
            setProviderId(value); setModelId(option?.defaultModel ?? option?.models[0]?.id ?? ''); setApiKey(''); clearError();
          }} />
        </div>
        {custom ? <div className="setup-field">
          <label htmlFor={`${id}-protocol`}>{t('API 协议')}</label>
          <CustomSelect id={`${id}-protocol`} value={protocol} disabled={busy} options={[...PROTOCOLS]}
            onChange={value => { if (supportedProtocol(value)) setProtocol(value); clearError(); }} />
        </div> : <div className="setup-field">
          <label htmlFor={`${id}-model`}>{t('模型')}</label>
          <CustomSelect id={`${id}-model`} value={modelId} disabled={busy} options={provider?.models.map(item => ({ value: item.id, label: item.name ?? item.id })) ?? []}
            onChange={value => {
              if (provider?.models.find(item => item.id === value)?.baseUrl !== baseUrl) setApiKey('');
              setModelId(value); clearError();
            }} />
        </div>}
      </div>
      {custom && <div className="setup-field"><label htmlFor={`${id}-url`}>{t('接口地址')}</label>
        <input className="ui-input" id={`${id}-url`} name="endpoint" type="url" value={customUrl} autoComplete="off" disabled={busy} required
          placeholder="https://api.example.com/v1" onChange={event => { setCustomUrl(event.target.value); clearError(); }} />
      </div>}
      {!custom && baseUrl && <p className="setup-endpoint"><code>{baseUrl}</code></p>}
      <div className={`setup-auth-fields${custom ? ' setup-fields-grid' : ''}`}>
        {custom && <div className="setup-field"><label htmlFor={`${id}-model`}>{t('模型 ID')}</label>
          <input className="ui-input" id={`${id}-model`} name="model" value={customModel} autoComplete="off" disabled={busy} required
            onChange={event => { setCustomModel(event.target.value); clearError(); }} />
        </div>}
        <div className="setup-field"><label htmlFor={`${id}-key`}>{t('API Key')}</label>
          <input className="ui-input" id={`${id}-key`} name="api-key" type="password" value={apiKey} autoComplete="off" spellCheck={false} disabled={busy}
            aria-describedby={`${id}-key-help`} required onChange={event => { setApiKey(event.target.value); clearError(); }} />
        </div>
      </div>
      <p className="setup-key-hint" id={`${id}-key-help`}>{t('从供应商控制台获取 Key。测试会发送一条短请求，通过后设为默认模型。')}</p>
    </>}
    {error && <p className="setup-error" role="alert">{error}</p>}
    <SetupActions back={back} busy={busy}>
      <button type="button" className="btn ghost" onClick={skip} disabled={busy}>{t('稍后配置')}</button>
      <button type="submit" className="btn primary" disabled={!loaded || !!loadError || busy}>
        {busy && <BrandLoader size={16} />}{busy ? t('正在测试和保存…') : t('测试并保存')}
      </button>
    </SetupActions>
  </form>;
}
