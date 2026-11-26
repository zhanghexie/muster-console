import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconInfo } from './icons';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { useDismissOnPagePeek } from '../hooks/useDismissOnPagePeek';
import { usePresence, MOTION } from './motion';

/**
 * 仅供不支持 appearance: base-select 的浏览器使用的主题化回退。
 * 菜单 portal 到 body（fixed 定位），不受滚动容器裁剪。
 */

import type { CustomSelectProps } from './CustomSelect';

export function CustomSelectFallback({
  id,
  value,
  onChange,
  onOpen,
  options,
  disabled,
  menuEnabled = true,
  placement,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  placeholder,
  triggerLabel,
  className,
  menuClassName,
  detailsAsTooltip,
  testId
}: CustomSelectProps): React.JSX.Element {
  const { t } = useTranslation();
  const optionIdPrefix = React.useId();
  const listboxId = `${optionIdPrefix}-listbox`;
  const [menuRequested, setOpen] = useState(false);
  const open = menuEnabled && menuRequested;
  useEffect(() => { if (open && !disabled) onOpen?.(); }, [open, disabled, onOpen]);
  const [activeIdx, setActiveIdx] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight?: number; minWidth: number } | null>(
    null
  );

  const selected = options.find((o) => o.value === value) ?? null;
  const menuPresence = usePresence(open, MOTION.menuMs);
  useLayoutEffect(() => { if (!menuEnabled) setOpen(false); }, [menuEnabled]);

  const place = useCallback((): void => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const estH = Math.min(menuRef.current?.scrollHeight || options.length * (!detailsAsTooltip && options.some(option => option.description) ? 64 : 28) + 8, 260);
    const width = menuRef.current?.offsetWidth || r.width;
    // 下方空间不足时翻到触发器上方
    const flip = r.bottom + estH > window.innerHeight && r.top - estH > 8;
    setMenuPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      minWidth: r.width,
      ...(placement === 'above'
        ? { bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(260, Math.max(0, r.top - 12)) }
        : { top: flip ? r.top - estH : r.bottom + 4 })
    });
  }, [options.length, detailsAsTooltip, placement]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const idx = options.findIndex((o) => o.value === value);
    setActiveIdx(idx >= 0 ? idx : 0);
  }, [open, place, options, value]);
  // Reposition once the real menu exists; path options can wrap over many lines.
  useLayoutEffect(() => {
    if (open && menuPos && menuRef.current) place();
  }, [open, menuPresence.mounted, menuPos?.minWidth, place]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    // Reopening during the exit reuses the same portal node. Remove inert before focusing it.
    menu.inert = !open;
    if (!open) return;
    menu.focus({ preventScroll: true });
    const initialOption = menu.querySelector('[role="option"][aria-selected="true"]') ?? menu.querySelector('[role="option"]');
    initialOption?.scrollIntoView({ block: 'nearest' });
  }, [open, menuPresence.mounted, !!menuPos]);
  useDismissOnPagePeek(open, triggerRef, () => setOpen(false));
  useOverlayDismiss(open, () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      if (target && triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onWinResize = (): void => place();
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      place();
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onWinResize);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onWinResize);
    };
  }, [open, place]);

  const pick = (idx: number): void => {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled || !menuEnabled) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const moveActive = (index: number): void => {
    if (!options[index]) return;
    setActiveIdx(index);
    document.getElementById(`${optionIdPrefix}-option-${index}`)?.scrollIntoView({ block: 'nearest' });
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(Math.min(activeIdx + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(Math.max(activeIdx - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveActive(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(activeIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    } else if (e.key === 'Tab') {
      // Continue the browser's normal Tab order from the trigger, rather than the body portal.
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }
  };

  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`c-select-trigger${className ? ` ${className}` : ''}`}
        disabled={disabled}
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open && menuPresence.mounted && menuPos ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid || undefined}
        aria-describedby={ariaDescribedBy}
        onClick={() => {
          if (!disabled && menuEnabled) setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {selected?.icon ? <span className="c-select-option-icon" aria-hidden="true">{selected.icon}</span> : null}
        <span className={`c-select-value${selected || triggerLabel ? '' : ' is-placeholder'}`}>
          {triggerLabel ?? selected?.label ?? placeholder ?? t('请选择')}
        </span>
        {selected?.badge ? (
          <span className="s-tag c-select-badge" aria-hidden="true">{selected.badge}</span>
        ) : null}
        <IconChevronDown size={12} className={`c-select-caret${open ? ' is-open' : ''}`} />
      </button>
      {menuEnabled && menuPresence.mounted && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              data-overlay-root=""
            className={`c-select-menu mp-pop${menuClassName ? ` ${menuClassName}` : ''}${detailsAsTooltip ? ' c-select-compact-details' : ''}`}
              data-mp-stage={menuPresence.stage}
              role="listbox"
              aria-label={ariaLabel}
              aria-activedescendant={options[activeIdx] ? `${optionIdPrefix}-option-${activeIdx}` : undefined}
              aria-hidden={!open || undefined}
              style={{ ...menuPos,
                '--select-trigger-width': `${menuPos.minWidth}px`, '--select-top': menuPos.top === undefined ? undefined : `${menuPos.top}px`
              } as React.CSSProperties}
              onKeyDown={onMenuKeyDown}
              tabIndex={-1}
            >
              {options.map((o, i) => {
                const showGroup = o.group != null && o.group !== lastGroup;
                lastGroup = o.group;
                return (
                  <React.Fragment key={o.value}>
                    {showGroup ? <div className="c-select-group">{o.group}</div> : null}
                    <div
                      id={`${optionIdPrefix}-option-${i}`}
                      role="option"
                      aria-selected={o.value === value}
                      aria-disabled={o.disabled || undefined}
                      aria-describedby={o.description ? `${optionIdPrefix}-description-${i}` : undefined}
                      /* 胶囊只做视觉；可访问名保持既有语义：chat 仍读作「名称（GUI）」，pty 仍是纯名称 */
                      aria-label={o.badge === 'GUI' ? `${o.label}（GUI）` : o.label}
                      title={detailsAsTooltip ? o.description : undefined}
                      className={`c-select-item${o.description ? ' has-description' : ''}${o.disabled ? ' is-disabled' : ''}${o.value === value ? ' is-selected' : ''}${i === activeIdx ? ' is-active' : ''}`}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => pick(i)}
                    >
                      {o.icon ? <span className="c-select-option-icon" aria-hidden="true">{o.icon}</span> : null}
                      {o.description ? <span className="c-select-option-detail">
                        <span className="c-select-item-label">{o.label}</span>
                        <span id={`${optionIdPrefix}-description-${i}`} className={detailsAsTooltip ? 'c-select-detail-sr-only' : 'c-select-option-description'}>{o.description}</span>
                      </span> : <span className="c-select-item-label">{o.label}</span>}
                      {detailsAsTooltip && o.description ? <span className="c-select-option-info" aria-hidden="true"><IconInfo size={13} /></span> : null}
                      {o.description && o.value === value ? <span className="c-select-option-check" aria-hidden="true">✔</span> : null}
                      {o.badge ? (
                        <span className="s-tag c-select-badge" aria-hidden="true">{o.badge}</span>
                      ) : null}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>,
            triggerRef.current?.closest('[data-select-portal]') ?? document.body
          )
        : null}
    </>
  );
}
