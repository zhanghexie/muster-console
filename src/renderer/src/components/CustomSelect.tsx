import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconInfo } from './icons';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { useDismissOnPagePeek } from '../hooks/useDismissOnPagePeek';
import { CustomSelectFallback } from './CustomSelectFallback';

export interface SelectOption {
  value: string;
  label: string;
  /** Optional product-facing details; existing simple selectors need not provide them. */
  icon?: React.ReactNode;
  description?: string;
  disabled?: boolean;
  /** 右侧胶囊（如运行方式的 GUI / TUI）。只做视觉标注，不进可访问名，
   *  以免已有 e2e 依赖的选项名发生变化。 */
  badge?: string;
  /** 连续同组项渲染分组标题（如模型供应商） */
  group?: string;
}

export interface CustomSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Allows a caller to load options on demand when the picker opens. */
  onOpen?: () => void;
  options: SelectOption[];
  disabled?: boolean;
  /** Prevent the body portal from outliving a collapsing parent. */
  menuEnabled?: boolean;
  /** Keep toolbar menus above their trigger and scroll within the space available there. */
  placement?: 'above';
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  placeholder?: string;
  /** Keep a fixed visible label on the trigger while the picker shows the selected option. */
  triggerLabel?: string;
  /** 触发器附加类名（对齐既有输入栅格，如 .task-settings-grid 的宽度规则） */
  className?: string;
  /** Optional scope for menus that display paths over multiple lines. */
  menuClassName?: string;
  /** Compact option rows with descriptions available on hover and to assistive technology. */
  detailsAsTooltip?: boolean;
  /** 触发器 data-testid（组件测试定位用；菜单项靠 role=option） */
  testId?: string;
}


/** The desktop Chromium supports customizable selects; older web clients keep the themed fallback. */
export function CustomSelect(props: CustomSelectProps): React.JSX.Element {
  const [nativePicker] = useState(() => typeof CSS !== 'undefined'
    && CSS.supports('appearance', 'base-select') && CSS.supports('selector(::picker(select))'));
  return nativePicker ? <NativeSelect {...props} /> : <CustomSelectFallback {...props} />;
}

/** React 18's nesting validator predates rich options. Own only the native shell;
 * React portals own the content in neutral span/button hosts (no HTML strings).
 * Remove this bridge when the renderer supports customizable-select markup directly. */
function RichOption({ option, descriptionId, compact }: {
  option: SelectOption; descriptionId: string; compact?: boolean;
}): React.JSX.Element {
  const [content] = useState(() => document.createElement('span'));
  const attach = useCallback((element: HTMLOptionElement | null) => {
    if (element) element.append(content);
  }, [content]);
  content.className = 'c-select-option-content';
  return <>
    <option ref={attach} value={option.value} disabled={option.disabled}
      className={`c-select-item${option.disabled ? ' is-disabled' : ''}`}
      aria-describedby={option.description ? descriptionId : undefined}
      title={compact ? option.description : undefined}>
    </option>
    {createPortal(<>
      {option.icon ? <span className="c-select-option-icon" aria-hidden="true">{option.icon}</span> : null}
      <span className="c-select-option-detail">
        <span className="c-select-item-label">{option.label}</span>
        {option.description ? <span id={descriptionId} aria-hidden="true" className={compact ? 'c-select-detail-sr-only' : 'c-select-option-description'}>{option.description}</span> : null}
      </span>
      {compact && option.description ? <span className="c-select-option-info" aria-hidden="true"><IconInfo size={13} /></span> : null}
      {option.badge ? <span className="s-tag c-select-badge" aria-hidden="true">{option.badge}</span> : null}
    </>, content)}
  </>;
}

function NativeSelect({ id, value, onChange, onOpen, options, disabled, menuEnabled = true,
  ariaLabel, ariaInvalid, ariaDescribedBy, placeholder, triggerLabel, className, menuClassName,
  detailsAsTooltip, placement, testId }: CustomSelectProps): React.JSX.Element {
  const { t } = useTranslation();
  const uid = React.useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const [button] = useState(() => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'c-select-button';
    element.tabIndex = -1;
    return element;
  });
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const restoreFocus = useRef(false);
  const changedByPointer = useRef(false);
  const selected = options.find(option => option.value === value);
  const enabled = !disabled && menuEnabled;
  const key = `${enabled}-${generation}`;

  useLayoutEffect(() => {
    const select = selectRef.current!;
    select.prepend(button);
    setOpen(false);
    if (restoreFocus.current && enabled) select.focus({ preventScroll: true });
    restoreFocus.current = false;
    return () => { button.remove(); };
  }, [button, key, enabled]);

  const syncOpen = (): void => setOpen(selectRef.current?.matches(':open') ?? false);
  useEffect(() => { if (open && enabled) onOpen?.(); }, [open, enabled, onOpen]);
  useDismissOnPagePeek(open, selectRef, () => setGeneration(current => current + 1));
  useOverlayDismiss(open, () => {
    // HTMLSelectElement exposes showPicker but no hidePicker. A React-owned
    // replacement closes the UA picker for programmatic dismissal, without moving
    // a React-managed node behind its back. Normal Escape/click/Tab stay native.
    restoreFocus.current = true;
    setGeneration(current => current + 1);
  });

  const groups: Array<{ name?: string; entries: Array<{ option: SelectOption; index: number }> }> = [];
  options.forEach((option, index) => {
    const previous = groups[groups.length - 1];
    if (previous && previous.name === option.group) previous.entries.push({ option, index });
    else groups.push({ name: option.group, entries: [{ option, index }] });
  });
  // A missing value must remain a placeholder; native select otherwise silently
  // chooses the first enabled option. An empty string remains a valid caller value.
  const missingValue = `__muster_missing_${uid}`;
  return <>
    <select key={key} ref={selectRef} id={id} name={id ?? uid}
      value={selected ? value : missingValue}
      disabled={!enabled} data-placement={placement} data-testid={testId} data-overlay-root=""
      className={`c-select-trigger c-select-native${className ? ` ${className}` : ''}${menuClassName ? ` ${menuClassName}` : ''}${detailsAsTooltip ? ' c-select-compact-details' : ''}`}
      aria-label={ariaLabel} aria-invalid={ariaInvalid || undefined} aria-describedby={ariaDescribedBy}
      onFocus={syncOpen} onBlur={event => {
        const destination = event.relatedTarget;
        queueMicrotask(() => {
          const select = selectRef.current;
          // Option-to-option navigation can transiently focus body. Only an
          // explicit external destination signals a host dialog taking focus.
          if (destination instanceof Element && select?.isConnected && select.matches(':open')
            && !select.contains(destination) && !select.contains(document.activeElement)) {
            setGeneration(current => current + 1);
          } else syncOpen();
        });
      }}
      onPointerDown={() => { changedByPointer.current = false; }}
      onClick={event => {
        const option = (event.target as Element).closest('option');
        // Existing callers use explicit reselection to confirm relocated roots.
        // Native change alone omits that same-value activation.
        if (option && !changedByPointer.current && enabled && !option.disabled && options.some(item => item.value === option.value)) onChange(option.value);
        changedByPointer.current = false;
        syncOpen();
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        const option = (event.target as Element).closest('option');
        if ((event.key === 'Enter' || event.key === ' ') && option && enabled && !option.disabled && option.value === value) onChange(value);
        if (event.key === 'Tab' && event.currentTarget.matches(':open')) {
          // Chromium closes its picker and restores the select on Tab. Preserve
          // our form contract: one Tab also advances, after the UA closes it.
          const select = event.currentTarget;
          const reverse = event.shiftKey;
          window.setTimeout(() => {
            if (!select.isConnected) return;
            const fields = [...document.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex],summary,[contenteditable="true"]')]
              .filter(element => element.tabIndex >= 0 && !element.matches(':disabled')
                && !element.closest('[inert]') && element.getClientRects().length > 0
                && getComputedStyle(element).visibility !== 'hidden')
              .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
            const index = fields.indexOf(select);
            if (index >= 0) fields[index + (reverse ? -1 : 1)]?.focus();
            syncOpen();
          }, 0);
        }
        if (enabled && !event.currentTarget.matches(':open') && event.key === 'ArrowDown') {
          event.preventDefault();
          event.currentTarget.showPicker();
          syncOpen();
        }
      }}
      onChange={event => {
        const next = options.find(option => option.value === event.currentTarget.value);
        if (enabled && next && !next.disabled) { changedByPointer.current = true; onChange(next.value); }
        syncOpen();
      }}>
      {!selected ? <option value={missingValue} hidden disabled>{placeholder ?? t('请选择')}</option> : null}
      {groups.map((group, groupIndex) => {
        const children = group.entries.map(({ option, index }) => <RichOption key={option.value} option={option}
          descriptionId={`${uid}-description-${index}`} compact={detailsAsTooltip} />);
        return group.name ? <optgroup key={groupIndex} label={group.name}>{children}</optgroup> : <React.Fragment key={groupIndex}>{children}</React.Fragment>;
      })}
    </select>
    {createPortal(<>
      {selected?.icon ? <span className="c-select-option-icon" aria-hidden="true">{selected.icon}</span> : null}
      <span className={`c-select-value${selected || triggerLabel ? '' : ' is-placeholder'}`}>{triggerLabel ?? selected?.label ?? placeholder ?? t('请选择')}</span>
      {selected?.badge ? <span className="s-tag c-select-badge" aria-hidden="true">{selected.badge}</span> : null}
      <IconChevronDown size={12} className="c-select-caret" />
    </>, button)}
  </>;
}
