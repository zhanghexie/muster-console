import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { MutableRefObject } from 'react';
import { HARNESS_CATALOG } from '../../../../shared/harnessCatalog';
import { HarnessIcon } from '../HarnessIcon';
import { IconCube } from '../icons';
import type { Presence } from '../motion';
import { HarnessModelPicker } from '../HarnessModelPicker';
import { pageForOverlay, useDismissOnPagePeek } from '../../hooks/useDismissOnPagePeek';
import type { Props as ComposerProps } from './composerTypes';

interface Props {
  interactionActive: boolean;
  statusModel: string;
  harnessId?: string;
  statusTitle?: string;
  chatStatus: ComposerProps['chatStatus'];
  showModelMenu: boolean;
  setShowModelMenu: (v: boolean) => void;
  toggleModelMenu: () => void;
  modelMenuPresence: Presence;
  modelMenuRef: MutableRefObject<HTMLDivElement | null>;
  modelPopupRef: MutableRefObject<HTMLDivElement | null>;
}

export function ComposerModelCluster({ interactionActive, statusModel, harnessId, statusTitle, chatStatus,
  showModelMenu, setShowModelMenu, toggleModelMenu, modelMenuPresence, modelMenuRef, modelPopupRef }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const target = chatStatus?.modelPickerTarget;
  const commit = chatStatus?.onModelConfiguration;
  const supported = !!target && !!commit;
  const [placement, setPlacement] = React.useState<{
    host: HTMLElement;
    style: React.CSSProperties & { maxHeight: number };
  }>();
  const opening = React.useRef({ open: false, generation: 0 });
  const livePicker = React.useRef('');
  if (opening.current.open !== showModelMenu) {
    opening.current.open = showModelMenu;
    if (showModelMenu) opening.current.generation++;
  }
  useDismissOnPagePeek(showModelMenu, modelMenuRef, () => setShowModelMenu(false));
  React.useLayoutEffect(() => {
    if (!showModelMenu || !supported) return;
    const place = (): void => {
      const trigger = modelMenuRef.current;
      if (!trigger) return;
      const page = pageForOverlay(trigger);
      if (page?.hasAttribute('data-h-peek')) return;
      const strip = page?.closest<HTMLElement>('.h-strip');
      const bounds = strip?.getBoundingClientRect();
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(520, Math.max(0, window.innerWidth - 24));
      const top = Math.max(0, bounds?.top ?? 0);
      const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight);
      const above = Math.max(0, rect.top - top - 16);
      const below = Math.max(0, bottom - rect.bottom - 16);
      const upward = above >= 390 || above >= below;
      const maxHeight = Math.min(440, upward ? above : below);
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      // Fit in viewport coordinates, then attach to the moving strip for exit.
      const anchor = upward
        ? { bottom: (bounds?.bottom ?? window.innerHeight) - rect.top + 4 }
        : { top: rect.bottom - (bounds?.top ?? 0) + 4 };
      setPlacement({ host: strip ?? document.body, style: {
        left: left - (bounds?.left ?? 0), width, maxHeight, ...anchor
      } });
    };
    place();
    const observer = new ResizeObserver(place);
    if (modelMenuRef.current) observer.observe(modelMenuRef.current);
    const surface = modelMenuRef.current?.closest('.chat-surface-view');
    if (surface) observer.observe(surface);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [showModelMenu, supported, modelMenuRef]);
  React.useLayoutEffect(() => {
    if (showModelMenu && !supported) setShowModelMenu(false);
    if (modelPopupRef.current) modelPopupRef.current.inert = !showModelMenu || !interactionActive;
  }, [showModelMenu, supported, interactionActive, modelMenuPresence.mounted, setShowModelMenu, modelPopupRef]);

  const harnessName = harnessId && (HARNESS_CATALOG.find(entry =>
    entry.id === harnessId || entry.acpPresetId === harnessId || entry.runtimeId === harnessId)?.name ?? harnessId);
  const glyph = harnessId ? <span role="img" aria-label={harnessName || harnessId} title={harnessName || harnessId}>
    <HarnessIcon harnessId={harnessId} size={14} className="agent-harness-glyph" />
  </span> : <IconCube size={12} className="agent-model-glyph" />;
  if (!target || !commit) return <span className="agent-composer-model-trigger is-static" title={statusTitle}>
    {glyph}<span className="agent-model-text">{statusModel}</span>
  </span>;

  const close = (): void => {
    setShowModelMenu(false);
    modelMenuRef.current?.querySelector<HTMLButtonElement>('.agent-composer-model-trigger')?.focus({ preventScroll: true });
  };
  const active = showModelMenu && interactionActive;
  const key = `${JSON.stringify(target)}\0${opening.current.generation}`;
  livePicker.current = active ? key : '';
  const parameterSummary = chatStatus?.modelParameters?.map(control => {
    const label = control.descriptor.options.find(option => option.value === control.effectiveValue)?.label;
    return `${control.descriptor.label}: ${control.override === null ? t('默认') + (label ? ` · ${label}` : '') : label ?? control.override}`;
  }).join(' / ');
  return <div className="agent-model-cluster">
    <div className="agent-model-wrap" ref={modelMenuRef}>
      <button type="button" className="agent-composer-model-trigger" disabled={!interactionActive} aria-expanded={showModelMenu}
        aria-haspopup="dialog" aria-label={t('模型与参数')} title={parameterSummary ? `${statusModel} · ${parameterSummary}` : statusTitle || t('点击切换大模型（只影响本会话；运行中则下回合生效）')}
        onClick={toggleModelMenu}>
        {glyph}<span className="agent-model-text">{statusModel}</span><span className="agent-composer-model-caret" aria-hidden>▾</span>
      </button>
      {modelMenuPresence.mounted && placement && placement.style.maxHeight > 0 ? createPortal(
        <div ref={modelPopupRef} className="agent-composer-model-menu model-picker-popup mp-pop mp-pop-up"
          data-mp-stage={modelMenuPresence.stage} data-overlay-root="" data-h-strip-overlay="" role="dialog" aria-label={t('模型与参数')} aria-hidden={!active || undefined}
          style={{ ...placement.style, ...(interactionActive ? {} : { visibility: 'hidden' }) }}
          onKeyDown={event => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault(); event.stopPropagation(); close();
          }}>
          <HarnessModelPicker key={key} target={target} active={active} confirmLabel={t('确认配置')} onCancel={close}
            defaultLabel={harnessId === 'codex' ? t('跟随 Codex 配置') : 'dispatch' in target ? t('跟随全局') : undefined}
            onConfirm={async ({ catalog, model, parameters }) => {
              const expected = catalog.commitStamp ?? catalog.sessionStamp;
              if (!expected) return { ok: false, error: t('会话配置已变化，请重新读取') };
              const result = await commit({ expected, model: model && { providerId: model.providerId, modelId: model.modelId }, parameters });
              if (result.ok && livePicker.current === key) close();
              return result;
            }} />
        </div>, placement.host) : null}
    </div>
  </div>;
}
