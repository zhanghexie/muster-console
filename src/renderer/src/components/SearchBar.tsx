import React, { forwardRef, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconClose, IconSearch } from './icons';

export type SearchBarProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 当前命中数；无查询时不渲染计数 */
  matchCount?: number;
  /** 总数；有则渲染 n/total，否则只渲染 n */
  matchTotal?: number;
  /** 覆盖计数文案（如「无结果」） */
  matchLabel?: string;
  /** Esc 在清空并失焦之后的收尾（关搜索态等） */
  onEscape?: () => void;
  /** 右侧附加操作（查找上/下一个、范围、关闭）；画在清空按钮之后 */
  trailing?: React.ReactNode;
  /** 隐藏清空 ×（浮条用关闭按钮代替） */
  hideClear?: boolean;
  /** float = 悬浮条视觉（阴影/最小宽度）；inline = 嵌入父级（左栏/Git） */
  variant?: 'inline' | 'float';
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  autoFocus?: boolean;
  disabled?: boolean;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  | 'value'
  | 'onChange'
  | 'onKeyDown'
  | 'onBlur'
  | 'onFocus'
  | 'placeholder'
  | 'className'
  | 'autoFocus'
  | 'disabled'
  | 'type'
>;

export function formatSearchMatchLabel(
  count?: number,
  total?: number,
  label?: string
): string {
  if (label) return label;
  if (count == null) return '';
  if (total != null) return `${count}/${total}`;
  return String(count);
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(function SearchBar(
  {
    value,
    onChange,
    placeholder,
    className,
    matchCount,
    matchTotal,
    matchLabel,
    onEscape,
    trailing,
    hideClear,
    variant = 'inline',
    onKeyDown,
    onBlur,
    onFocus,
    autoFocus,
    disabled,
    ...rest
  },
  ref
) {
  const { t } = useTranslation();
  const innerRef = useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null): void => {
    innerRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  const clear = useCallback(() => {
    onChange('');
    innerRef.current?.focus();
  }, [onChange]);

  const hasQuery = value.length > 0;
  const countText = hasQuery ? formatSearchMatchLabel(matchCount, matchTotal, matchLabel) : '';

  return (
    <div
      className={`search-bar${variant === 'float' ? ' is-float' : ''}${className ? ` ${className}` : ''}${disabled ? ' is-disabled' : ''}`}
    >
      <span className="search-bar-icon" aria-hidden>
        <IconSearch />
      </span>
      <input
        {...rest}
        ref={setRefs}
        className="search-bar-input"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={rest['aria-label'] ?? placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onFocus={onFocus}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // isComposing：IME 合成期的 Esc 是「取消候选」，不能当清空并关闭（中文输入主场景）
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (value) onChange('');
            innerRef.current?.blur();
            onEscape?.();
            return;
          }
          onKeyDown?.(e);
        }}
      />
      {countText ? (
        <span className="search-bar-count" aria-live="polite">
          {countText}
        </span>
      ) : null}
      {hasQuery && !hideClear ? (
        <button
          type="button"
          className="search-bar-clear"
          aria-label={t('清空搜索')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
        >
          <IconClose size={11} />
        </button>
      ) : null}
      {trailing}
    </div>
  );
});
