import { ComposerFlyout, type ComposerFlyoutAnchor } from './ComposerFlyout';
import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { GuiWorkerMode } from '../../../../shared/types';
import { isCreativePreset } from './composerHelpers';
import type { Props as AgentComposerProps, ComposerPreset, ComposerPresetItem } from './composerTypes';
import { IconBolt, IconCheck, IconEye, IconInfo, IconPencil, IconPlan, IconPlus, IconShield, IconSliders, IconSparkle, IconUnlock } from '../icons';
import type { Presence } from '../motion';
import { useSystemShortcuts } from './useSystemShortcuts';
import { formatSystemShortcut } from '../../../../shared/systemShortcuts';
import { PermissionConfiguration } from '../PermissionConfiguration';

function portalWhenRequested(node: React.JSX.Element, host?: HTMLElement | null, anchor?: ComposerFlyoutAnchor, popupRef?: React.RefObject<HTMLDivElement>, variant: 'actions' | 'permissions' = 'actions'): React.ReactNode {
  if (anchor) return <ComposerFlyout anchor={anchor} popupRef={popupRef} variant={variant}>{node}</ComposerFlyout>;
  return host ? createPortal(node, host) : node;
}

/** 权限档图标（底部栏常驻；窄屏图标化后它就是档位的唯一视觉载体，配 mode-* 着色） */
function ModeGlyph({ mode, panda = false }: { mode: GuiWorkerMode; panda?: boolean }): React.JSX.Element {
  switch (mode) {
    case 'ask':
      return <IconEye size={12} className="agent-mode-glyph" />;
    case 'plan':
      return <IconPlan size={12} className="agent-mode-glyph" />;
    case 'auto':
      return panda ? <IconUnlock size={12} className="agent-mode-glyph" /> : <IconBolt size={12} className="agent-mode-glyph" />;
    case 'standard':
      return <IconCheck size={12} className="agent-mode-glyph" />;
    case 'auto-review':
      return <IconSparkle size={12} className="agent-mode-glyph" />;
    case 'accept-edits':
      return <IconPencil size={12} className="agent-mode-glyph" />;
    default:
      return <IconShield size={12} className="agent-mode-glyph" />;
  }
}

interface Props {
  plusMenu: boolean;
  allowImages: boolean;
  showPlusMenu: boolean;
  setShowPlusMenu: Dispatch<SetStateAction<boolean>>;
  plusMenuPresence: Presence;
  plusMenuRef: MutableRefObject<HTMLDivElement | null>;
  plusPopupRef?: MutableRefObject<HTMLDivElement | null>;
  plusPopupHost?: HTMLElement | null;
  flyoutAnchor?: ComposerFlyoutAnchor;
  insertTriggerChar: (ch: string) => void;
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  onModeChange?: (mode: GuiWorkerMode) => void;
  permissionConfiguration?: AgentComposerProps['permissionConfiguration'];
  mode: GuiWorkerMode;
  modeLabel: (m: GuiWorkerMode) => string;
  modeOrder?: GuiWorkerMode[];
  modeDescriptions?: Partial<Record<GuiWorkerMode, string>>;
  modeDisabled?: Partial<Record<GuiWorkerMode, boolean>>;
  unavailableReview?: { label: string; description: string };
  modeSwitchLocked?: boolean;
  modeSwitchLockedTitle?: string;
  disabled?: boolean;
  preset?: ComposerPreset;
  separatePreset?: boolean;
  presetRoster: ComposerPresetItem[] | null;
  presetError?: boolean;
  presetName: string;
  showModeMenu: boolean;
  setShowModeMenu: Dispatch<SetStateAction<boolean>>;
  modeMenuPresence: Presence;
  modeMenuRef: MutableRefObject<HTMLDivElement | null>;
  modePopupRef?: MutableRefObject<HTMLDivElement | null>;
  showPresetMenu?: boolean;
  setShowPresetMenu?: Dispatch<SetStateAction<boolean>>;
  presetMenuPresence?: Presence;
  presetMenuRef?: MutableRefObject<HTMLDivElement | null>;
}

function PresetItems({ preset, roster, error, close }: {
  preset: ComposerPreset;
  roster: ComposerPresetItem[] | null;
  error?: boolean;
  close: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <>
    {error ? <div className="agent-preset-locked-note" role="alert">{t('加载模式列表失败，请重新打开菜单重试')}</div> : null}
    {(roster ?? []).map((p) => (
      <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === preset.id}
        className={`agent-preset-item${p.id === preset.id ? ' is-active' : ''}`}
        disabled={!!p.broken || (preset.locked && p.id !== preset.id)}
        title={p.broken ? t('该模式已损坏：{{reason}}', { reason: p.broken }) : p.description}
        onClick={() => { close(); if (p.id !== preset.id && !preset.locked) preset.onChange(p.id); }}>
        <span className="agent-preset-item-main">
          <span className="agent-preset-item-title">{p.name}{p.trust === 'user' ? <span className="agent-preset-item-badge">{t('自建')}</span> : null}</span>
          {p.description ? <span className="agent-preset-item-desc">{p.description}</span> : null}
        </span>
        {p.id === preset.id ? <span className="agent-mode-item-check" aria-hidden>✔</span> : null}
      </button>
    ))}
    {preset.locked && preset.lockedNote ? <div className="agent-preset-locked-note">{preset.lockedNote}</div> : null}
  </>;
}

/** 工具栏左组：GUI Core 的权限和自定义模式分别成菜单，调度面保留原有合并菜单。 */
export function ComposerToolbarLeft({
  plusMenu,
  allowImages,
  showPlusMenu,
  setShowPlusMenu,
  plusMenuPresence,
  plusMenuRef,
  plusPopupRef,
  plusPopupHost, flyoutAnchor,
  insertTriggerChar,
  fileInputRef,
  onModeChange,
  permissionConfiguration,
  mode,
  modeLabel,
  modeOrder,
  modeDescriptions,
  modeDisabled,
  unavailableReview,
  modeSwitchLocked,
  modeSwitchLockedTitle,
  disabled,
  preset,
  separatePreset,
  presetRoster,
  presetError,
  presetName,
  showModeMenu,
  setShowModeMenu,
  modeMenuPresence,
  modeMenuRef,
  modePopupRef,
  showPresetMenu,
  setShowPresetMenu,
  presetMenuPresence,
  presetMenuRef
}: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  // modeOrder 显式为空 = 该会话没有可切换的档位（扩展侧栏固定 standard）：连 chip 一起隐藏，
  // 只留一个空菜单的按钮只会误导点击。
  const hasModeSelector = modeOrder?.length === 0 ? false : (!!permissionConfiguration || (!!onModeChange && (!modeOrder || modeOrder.length > 0)));
  const permissionButton = React.useRef<HTMLButtonElement>(null);
  const permissionAnchor = flyoutAnchor ? { name: flyoutAnchor.name + '-permission', ref: permissionButton } : undefined;
  const systemShortcuts = useSystemShortcuts(showPlusMenu, () => setShowPlusMenu(false));
  const inherited = permissionConfiguration?.inherit;
  const isSelected = (value: GuiWorkerMode) => !inherited?.selected && value === mode;
  const closePermissions = () => { setShowModeMenu(false); modeMenuRef.current?.querySelector('button')?.focus({ preventScroll: true }); };
  const permissionPanel = (content: React.ReactNode) => permissionConfiguration
    ? <PermissionConfiguration {...permissionConfiguration} className="permission-config-menu">
        {permissionConfiguration.fields ?? <div role="menu" aria-label={t('权限模式')}>{content}</div>}
      </PermissionConfiguration> : content;
  if (!plusMenu && !allowImages && !(hasModeSelector || preset)) return null;
  return (
    <>
      {plusMenu ? (
        <div className="composer-plus-wrap" ref={plusMenuRef}>
          <button
            type="button"
            className="composer-icon-btn composer-plus-btn"
            title={
              allowImages
                ? t('添加附件（文件 / 引用文件 / 命令）')
                : t('添加附件（引用文件 / 命令）')
            }
            aria-label={t('添加附件')}
            aria-expanded={showPlusMenu}
            onClick={() => setShowPlusMenu((v) => !v)}
          >
            <IconPlus
              size={13}
              className={showPlusMenu ? 'composer-plus-icon is-open' : 'composer-plus-icon'}
            />
          </button>
          {plusMenuPresence.mounted && portalWhenRequested(
            <div
              className="composer-plus-menu mp-pop mp-pop-up"
              data-mp-stage={plusMenuPresence.stage}
              ref={plusPopupRef}
              role="menu"
              aria-hidden={plusMenuPresence.stage === 'out'}
              {...(plusMenuPresence.stage === 'out' ? { inert: '' } : {})}
            >
              {allowImages ? (
                <button
                  type="button"
                  role="menuitem"
                  className="composer-plus-item"
                  onClick={() => {
                    setShowPlusMenu(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <span className="composer-plus-item-title">{t('添加文件')}</span>
                  <span className="composer-plus-item-desc">{t('粘贴 / 拖入也行')}</span>
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="composer-plus-item"
                onClick={() => insertTriggerChar('@')}
              >
                <span className="composer-plus-item-title">{t('引用文件')}</span>
                <span className="composer-plus-item-desc">{t('@ 工作区文件')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="composer-plus-item"
                onClick={() => insertTriggerChar('/')}
              >
                <span className="composer-plus-item-title">{t('命令 / 技能')}</span>
                <span className="composer-plus-item-desc">{t('/ 斜杠命令面板')}</span>
              </button>
              {systemShortcuts.items.map(item => <button key={item.id} type="button" role="menuitem"
                className="composer-plus-item" disabled={systemShortcuts.busy}
                onClick={() => void systemShortcuts.run(item.id)}>
                <span className="composer-plus-item-title">{item.name}</span>
                <span className="composer-plus-item-desc">{formatSystemShortcut(item.chord, navigator.platform)}</span>
              </button>)}
            </div>, plusPopupHost, flyoutAnchor
          )}
        </div>
      ) : allowImages ? (
        <button
          type="button"
          className="composer-icon-btn"
          title={t('添加文件（支持直接拖拽/粘贴）')}
          aria-label={t('添加文件')}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.6" />
            <circle cx="5.8" cy="5.8" r="1.1" />
            <path d="M13.8 10.4 10.4 7 6.8 10.6 5.2 9 2.4 11.8" />
          </svg>
        </button>
      ) : null}
      {systemShortcuts.busy && <span className="hint-muted" role="status">{t('发送快捷键…')}</span>}
      {systemShortcuts.error && <span className="system-shortcut-error" role="alert">{systemShortcuts.error}</span>}
      {hasModeSelector || (preset && !separatePreset) ? (
        <div className="agent-mode-wrap" ref={modeMenuRef}>
          <button
            type="button"
            ref={permissionButton}
            style={permissionAnchor ? { anchorName: permissionAnchor.name } as React.CSSProperties : undefined}
            className={`agent-mode-chip mode-${mode}${
              preset && !separatePreset && isCreativePreset(preset) ? ' is-creative' : ''
            }`}
            disabled={!!disabled || modeSwitchLocked}
            title={
              modeSwitchLocked
                ? (modeSwitchLockedTitle ??
                  t('当前回合进行中，切档会中断回合；请等回合结束再切'))
                : preset?.locked && !onModeChange
                  ? preset.lockedTitle
                  : undefined
            }
            onClick={() => setShowModeMenu((v) => !v)}
            aria-haspopup={permissionConfiguration ? 'dialog' : 'menu'}
            aria-label={permissionConfiguration ? t('权限模式') : undefined}
            aria-expanded={showModeMenu}
          >
            {hasModeSelector ? <ModeGlyph mode={mode} panda={!!modeDescriptions} /> : null}
            <span className="agent-mode-chip-label">
              {permissionConfiguration?.triggerLabel ?? (hasModeSelector ? modeLabel(mode) : presetName)}
            </span>
            {onModeChange && preset && !separatePreset && preset.id !== '' && presetName ? (
              <span className="agent-mode-chip-suffix">· {presetName}</span>
            ) : null}
            <span className="agent-mode-caret" aria-hidden>
              ▾
            </span>
          </button>
          {modeMenuPresence.mounted && portalWhenRequested(
            <div
              className={`agent-mode-menu${modeDescriptions ? ' agent-mode-menu-with-details' : ''}${
                preset && !separatePreset ? ' agent-preset-menu' : ''
              } mp-pop mp-pop-up`}
              data-mp-stage={modeMenuPresence.stage}
              role={permissionConfiguration ? 'dialog' : 'menu'}
              aria-label={permissionConfiguration ? t('权限模式') : undefined}
              aria-hidden={modeMenuPresence.stage === 'out'}
              {...(modeMenuPresence.stage === 'out' ? { inert: '' } : {})}
            >
              {permissionPanel(<>
              {inherited && <div className="agent-mode-row">
                <button type="button" role="menuitemradio" className="agent-mode-item" disabled={permissionConfiguration?.disabled}
                  aria-checked={inherited.selected} onClick={() => { inherited.reset(); closePermissions(); }}>
                  <IconShield size={12} /><span className="agent-mode-item-main">{t('跟随默认')}</span>
                </button>
                <span className="agent-mode-info" role="img" tabIndex={0} title={t('使用此会话的默认权限设置。')}
                  aria-label={t('使用此会话的默认权限设置。')}><IconInfo size={13} /></span>
                <span className="agent-mode-item-check" aria-hidden>{inherited.selected ? '✔' : ''}</span>
              </div>}
              {onModeChange ? (
                <>
                  {preset && !separatePreset ? (
                    <div className="agent-mode-menu-heading">{t('权限档')}</div>
                  ) : null}
                  {(modeOrder ?? ['default', 'ask', 'plan']).map((m) => modeDescriptions ? (
                    <React.Fragment key={m}>
                    <div className="agent-mode-row">
                      <button type="button" role="menuitemradio" aria-checked={isSelected(m)}
                        className={`agent-mode-item${isSelected(m) ? ' is-active' : ''}`}
                        disabled={!!modeDisabled?.[m] || permissionConfiguration?.disabled}
                        onClick={() => { closePermissions(); if (!isSelected(m)) onModeChange?.(m); }}>
                        {m === 'accept-edits' && modeLabel(m) === t('按需询问')
                          ? <IconSparkle size={12} className="agent-mode-glyph" /> : <ModeGlyph mode={m} panda />}
                        <span className="agent-mode-item-main">{modeLabel(m)}</span>
                      </button>
                      {modeDescriptions[m] ? <span className="agent-mode-info" role="img" tabIndex={0}
                        title={t(modeDescriptions[m]!)} aria-label={t(modeDescriptions[m]!)}><IconInfo size={13} /></span> : null}
                      <span className="agent-mode-item-check" aria-hidden>{isSelected(m) ? '✔' : ''}</span>
                    </div>
                    {m === 'accept-edits' && unavailableReview ? <div className="agent-mode-row">
                      <button type="button" role="menuitem" className="agent-mode-item" disabled>
                        <IconSparkle size={12} className="agent-mode-glyph" />
                        <span className="agent-mode-item-main">{t(unavailableReview.label)}</span>
                      </button>
                      <span className="agent-mode-info" role="img" tabIndex={0} title={t(unavailableReview.description)}
                        aria-label={t(unavailableReview.description)}><IconInfo size={13} /></span>
                      <span className="agent-mode-item-check" aria-hidden />
                    </div> : null}
                    </React.Fragment>
                  ) : (
                    <button
                      key={m}
                      type="button"
                      role="menuitem"
                      className={`agent-mode-item${isSelected(m) ? ' is-active' : ''}`}
                      disabled={!!modeDisabled?.[m] || permissionConfiguration?.disabled}
                      onClick={() => {
                        setShowModeMenu(false);
                        if (m !== mode) onModeChange?.(m);
                      }}
                    >
                      <span>{modeLabel(m)}</span>
                      {isSelected(m) ? (
                        <span className="agent-mode-item-check" aria-hidden>
                          ✔
                        </span>
                      ) : null}
                    </button>
                  ))}
                </>
              ) : null}
              {preset && !separatePreset ? (
                <>
                  {onModeChange ? (
                    <>
                      <div className="agent-mode-menu-divider" role="separator" />
                      <div className="agent-mode-menu-heading">{t('模式')}</div>
                    </>
                  ) : null}
                  <PresetItems preset={preset} roster={presetRoster} error={presetError} close={() => setShowModeMenu(false)} />
                </>
              ) : null}
              </>)}
            </div>, undefined, permissionAnchor, modePopupRef, 'permissions'
          )}
        </div>
      ) : null}
      {preset && separatePreset && setShowPresetMenu && presetMenuPresence && presetMenuRef ? (
        <div className="agent-mode-wrap" ref={presetMenuRef}>
          <button type="button" className={`agent-mode-chip agent-core-preset-chip${isCreativePreset(preset) ? ' is-creative' : ''}`}
            disabled={!!disabled} title={preset.locked ? preset.lockedTitle : preset.title}
            aria-label={`${t('模式')}：${presetName || t('标准')}`} aria-haspopup="menu" aria-expanded={showPresetMenu}
            onClick={() => setShowPresetMenu(v => !v)}>
            <IconSliders size={12} className="agent-mode-glyph" />
            <span className="agent-mode-chip-label">{t('模式')}：{presetName || t('标准')}</span>
            <span className="agent-mode-caret" aria-hidden>▾</span>
          </button>
          {presetMenuPresence.mounted ? <div className="agent-mode-menu agent-preset-menu mp-pop mp-pop-up"
            data-mp-stage={presetMenuPresence.stage} role="menu" aria-label={t('模式')}
            aria-hidden={presetMenuPresence.stage === 'out'} {...(presetMenuPresence.stage === 'out' ? { inert: '' } : {})}>
            <PresetItems preset={preset} roster={presetRoster} error={presetError} close={() => setShowPresetMenu(false)} />
          </div> : null}
        </div>
      ) : null}
    </>
  );
}
