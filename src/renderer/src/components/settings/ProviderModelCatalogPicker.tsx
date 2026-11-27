import { ErrorTip } from '../ErrorTip';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { LlmModelConfig } from '../../../../shared/types';
import type { PiCatalogModel } from '../../../../shared/piCatalog';
import type { ProviderModelCatalogRequest, ProviderModelCatalogSnapshot } from '../../../../shared/providerModelCatalog';
import { BrandLoading } from '../BrandLoader';
import { SearchBar } from '../SearchBar';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { MOTION, usePresence } from '../motion';

const POPUP_MARGIN = 8;
const POPUP_GAP = 6;
const POPUP_MAX_HEIGHT = 420;

export function ProviderModelCatalogPicker({ provider, models, builtin, onAdd, onAddManually, onOpenChange, active = true }: {
  provider: ProviderModelCatalogRequest;
  models: LlmModelConfig[];
  builtin?: Map<string, PiCatalogModel>;
  onAdd(model: LlmModelConfig): void;
  onAddManually?(): void;
  onOpenChange?(open: boolean): void;
  active?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const identity = JSON.stringify([provider.id, provider.baseUrl, provider.api, provider.apiKey]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const generation = useRef(0);
  const [state, setState] = useState<{ identity: string; snapshot?: ProviderModelCatalogSnapshot | null; loading: boolean; error?: string }>({ identity, loading: true });
  const [requestedOpen, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popupId = useId();
  const open = active && requestedOpen;
  const presence = usePresence(open, MOTION.microMs);

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  useOverlayDismiss(open, close);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  useEffect(() => { if (!active) setOpen(false); }, [active]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    return () => document.removeEventListener('pointerdown', dismissOutside, true);
  }, [open]);

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
  const search = query.trim().toLowerCase();
  const shown = search ? missing.filter(model => model.id.toLowerCase().includes(search) || model.name?.toLowerCase().includes(search)) : missing;

  useLayoutEffect(() => {
    const popup = popupRef.current;
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (!presence.mounted || !popup || !trigger || !list) return;
    if (typeof popup.showPopover === 'function' && !popup.hasAttribute('popover')) {
      popup.setAttribute('popover', 'manual');
      popup.showPopover();
    }

    const position = (): void => {
      const anchor = trigger.getBoundingClientRect();
      const desiredHeight = Math.min(POPUP_MAX_HEIGHT, popup.offsetHeight - list.clientHeight + list.scrollHeight);
      const rightLimit = window.innerWidth - popup.offsetWidth - POPUP_MARGIN;
      const below = window.innerHeight - anchor.bottom - POPUP_GAP - POPUP_MARGIN;
      const above = anchor.top - POPUP_GAP - POPUP_MARGIN;
      const flipped = desiredHeight > below && above > below;
      Object.assign(popup.style, {
        left: `${Math.max(POPUP_MARGIN, Math.min(anchor.left, rightLimit))}px`,
        top: flipped ? 'auto' : `${anchor.bottom + POPUP_GAP}px`,
        bottom: flipped ? `${window.innerHeight - anchor.top + POPUP_GAP}px` : 'auto',
        maxHeight: `${Math.max(0, Math.min(POPUP_MAX_HEIGHT, flipped ? above : below))}px`
      });
      popup.classList.toggle('mp-pop-up', flipped);
    };
    position();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position);
    observer?.observe(trigger);
    const onScroll = (event: Event): void => {
      if (!popup.contains(event.target as Node)) position();
    };
    window.addEventListener('resize', position);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [presence.mounted, shown.length]);

  useLayoutEffect(() => {
    if (open && presence.stage === 'in') searchRef.current?.focus({ preventScroll: true });
  }, [open, presence.stage]);

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
    {(builtin || snapshot) && <button ref={triggerRef} type="button" className="btn tiny" data-setup-target={missing.length ? 'catalog-add' : undefined}
      aria-expanded={open} aria-controls={presence.mounted ? popupId : undefined} onClick={() => { if (!open) setQuery(''); setOpen(!open); }}>
      {t('从目录添加（{{n}}）', { n: missing.length })}
    </button>}
    {onAddManually && <button type="button" className="btn ghost tiny" data-setup-target="manual-add" onClick={onAddManually}>
      {t('＋ 添加模型')}
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
    {presence.mounted && createPortal(<div className="llm-add-menu-panel llm-catalog-popup mp-pop" {...presence.spread}
      id={popupId} role="dialog" aria-label={t('从目录添加')} aria-hidden={!open || undefined} data-overlay-root=""
      ref={node => { popupRef.current = node; if (node) node.inert = !open; }}
      onKeyDown={event => {
        if (event.defaultPrevented || event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}>
      <SearchBar ref={searchRef} className="llm-catalog-search" aria-label={t('搜索模型')} placeholder={t('搜索模型…')}
        value={query} onEscape={close} onChange={value => {
          setQuery(value);
          if (listRef.current) listRef.current.scrollTop = 0;
        }} />
      <div ref={listRef} className="llm-catalog-picker">
      {shown.length ? shown.map(model => <button key={model.id} type="button" className="llm-catalog-picker-item" onClick={() => {
        const { id, name, contextWindow, maxTokens } = model;
        close();
        onAdd({ id, name: name || id, ...(!builtin?.has(id) ? { ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}) } : {}) });
      }}>
        <span className="llm-model-row-id">{model.id}</span>
        {model.contextWindow ? <span className="llm-model-badge-ctx">{model.contextWindow >= 1048576
          ? `${Math.round(model.contextWindow / 1048576)}M` : `${Math.round(model.contextWindow / 1024)}k`}</span> : null}
        {model.reasoning && <span className="llm-model-meta-tag">{t('思考')}</span>}
        {model.input?.includes('image') && <span className="llm-model-meta-tag">{t('多模态')}</span>}
      </button>) : <p className="settings-hint">{missing.length ? t('没有匹配的模型') : t('目录中没有尚未添加的模型。')}</p>}
      </div>
    </div>, triggerRef.current?.closest('.settings-page') ?? document.body)}
  </>;
}
