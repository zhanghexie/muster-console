import { ErrorTip } from '../ErrorTip';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmModelConfig } from '../../../../shared/types';
import type { PiCatalogModel } from '../../../../shared/piCatalog';
import type { ProviderModelCatalogRequest, ProviderModelCatalogSnapshot } from '../../../../shared/providerModelCatalog';
import { BrandLoading } from '../BrandLoader';
import { usePresence } from '../motion';

export function ProviderModelCatalogPicker({ provider, models, builtin, onAdd }: {
  provider: ProviderModelCatalogRequest;
  models: LlmModelConfig[];
  builtin?: Map<string, PiCatalogModel>;
  onAdd(model: LlmModelConfig): void;
}) {
  const { t, i18n } = useTranslation();
  const identity = JSON.stringify([provider.id, provider.baseUrl, provider.api, provider.apiKey]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const generation = useRef(0);
  const [state, setState] = useState<{ identity: string; snapshot?: ProviderModelCatalogSnapshot | null; loading: boolean; error?: string }>({ identity, loading: true });
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);

  useEffect(() => {
    const request = ++generation.current;
    setState({ identity, loading: true });
    void window.api.config.providerModelCatalog(provider).then(result => {
      if (request !== generation.current || currentIdentity.current !== identity) return;
      setState(result.ok ? { identity, snapshot: result.snapshot, loading: false } : { identity, loading: false, error: result.error });
    }).catch(error => {
      if (request === generation.current && currentIdentity.current === identity) setState({ identity, loading: false, error: String(error instanceof Error ? error.message : error) });
    });
    return () => { generation.current++; };
  }, [identity]);

  const ownState = state.identity === identity ? state : { identity, loading: true };
  const snapshot = ownState.snapshot;
  const builtinCandidates = Array.from(builtin ?? [], ([id, meta]) => ({ id, ...meta }));
  // A failed refresh must never turn the candidate list into an empty state. For an
  // official provider, pi's built-in catalog is the fallback; for a custom endpoint,
  // retain its last complete remote snapshot instead.
  const fallbackCandidates = builtinCandidates.length ? builtinCandidates : (snapshot?.models ?? []);
  const usingFallback = Boolean(ownState.error) && fallbackCandidates.length > 0;
  const candidates = usingFallback
    ? fallbackCandidates
    : snapshot ? snapshot.models.map(model => ({ ...builtin?.get(model.id), ...model }))
      : builtinCandidates;
  const missing = candidates.filter(model => !models.some(added => added.id === model.id));
  const refresh = async () => {
    if (ownState.loading) return;
    const request = ++generation.current;
    setState(previous => ({ ...previous, identity, loading: true, error: undefined }));
    try {
      const result = await window.api.config.providerModelCatalog(provider, true);
      if (request !== generation.current || currentIdentity.current !== identity) return;
      setState(previous => result.ok ? { identity, snapshot: result.snapshot, loading: false }
        : { ...previous, loading: false, error: result.error });
    } catch (error) {
      if (request === generation.current && currentIdentity.current === identity) setState(previous => ({ ...previous, loading: false, error: String(error instanceof Error ? error.message : error) }));
    }
  };

  return <>
    {(builtin || snapshot) && <button type="button" className="btn ghost tiny" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {t('从目录添加（{{n}}）', { n: missing.length })}
    </button>}
    <button type="button" className="btn ghost tiny" disabled={ownState.loading || !provider.baseUrl.trim()}
      title={t('向当前服务商请求最新模型列表，仅更新候选目录。')} onClick={() => void refresh()}>
      {ownState.loading ? <><BrandLoading size={13}/>{t('读取中…')}</> : t('刷新目录')}
    </button>
    {ownState.error ? <>
      <ErrorTip message={ownState.error} />
      {usingFallback ? <p className="llm-catalog-feedback is-fallback" role="status">
        {builtinCandidates.length
          ? t('刷新失败，已回退到内置目录（{{count}} 个模型）。', { count: builtinCandidates.length })
          : t('刷新失败，已保留上次成功目录（{{count}} 个模型）。', { count: fallbackCandidates.length })}
      </p> : null}
    </> : snapshot ? <p className="llm-catalog-feedback" role="status">
      {t('服务商目录：{{count}} 个模型 · {{time}}', { count: snapshot.models.length, time: new Date(snapshot.fetchedAt).toLocaleString(i18n.language) })}
      <span>{t('已添加和默认模型保持不变。')}</span>
    </p> : null}
    {presence.mounted && <div className="llm-catalog-picker mp-panel" {...presence.spread} aria-hidden={!open || undefined}
      ref={node => { if (node) node.inert = !open; }} data-settings-item="agent-catalog-picker">
      {missing.length ? missing.map(model => <button key={model.id} type="button" className="llm-catalog-picker-item" onClick={() => {
        const { id, name, contextWindow, maxTokens } = model;
        onAdd({ id, name: name || id, ...(!builtin?.has(id) ? { ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}) } : {}) });
      }}>
        <span className="llm-model-row-id">{model.id}</span>
        {model.contextWindow ? <span className="llm-model-badge-ctx">{model.contextWindow >= 1048576
          ? `${Math.round(model.contextWindow / 1048576)}M` : `${Math.round(model.contextWindow / 1024)}k`}</span> : null}
        {model.reasoning && <span className="llm-model-meta-tag">{t('思考')}</span>}
        {model.input?.includes('image') && <span className="llm-model-meta-tag">{t('多模态')}</span>}
      </button>) : <p className="settings-hint">{t('目录中没有尚未添加的模型。')}</p>}
    </div>}
  </>;
}
