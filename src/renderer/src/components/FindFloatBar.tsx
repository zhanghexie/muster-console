/**
 * 居中查找浮条共用壳：🔍 + 输入 + n/N + ↑↓ + 可选附加钮 + ×。
 * 进出场 usePresence + mp-pop，禁止自造时长/keyframes。
 */
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { SearchBar } from './SearchBar';
import { IconChevronDown, IconChevronUp, IconClose } from './icons';
import { MOTION, usePresence } from './motion';

export function FindFloatBar(props: {
  open: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  placeholder: string;
  ariaLabel: string;
  inputAriaLabel?: string;
  matchIndex: number;
  matchTotal: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  extraTrailing?: React.ReactNode;
  focusEpoch?: number;
  inputRef?: React.Ref<HTMLInputElement>;
  className?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(props.open, MOTION.menuMs);
  const innerRef = useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null): void => {
    innerRef.current = el;
    const r = props.inputRef;
    if (typeof r === 'function') r(el);
    else if (r) (r as React.MutableRefObject<HTMLInputElement | null>).current = el;
  };

  useEffect(() => {
    if (!props.open) return;
    const timer = window.setTimeout(() => {
      innerRef.current?.focus();
      innerRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [props.open, props.focusEpoch]);

  // 入 overlay 栈：Esc 走 overlay.close（捕获阶段）。不入栈时若看板探出条等已占栈，
  // Esc 会被吃掉，输入失焦后更收不到 SearchBar 自己的 keydown。
  useOverlayDismiss(props.open, props.onClose);

  if (!presence.mounted) return null;

  const hasQuery = props.query.trim().length > 0;
  const matchLabel = hasQuery ? (props.matchTotal > 0 ? undefined : t('无结果')) : undefined;
  const matchCount = hasQuery && props.matchTotal > 0 ? props.matchIndex + 1 : undefined;
  const matchTotal = hasQuery && props.matchTotal > 0 ? props.matchTotal : undefined;

  return (
    <div
      className={`find-float-bar chat-find-bar mp-pop${props.className ? ` ${props.className}` : ''}`}
      {...presence.spread}
      role="search"
      aria-label={props.ariaLabel}
    >
      <SearchBar
        ref={setRefs}
        variant="float"
        hideClear
        value={props.query}
        onChange={props.onQueryChange}
        placeholder={props.placeholder}
        aria-label={props.inputAriaLabel ?? props.placeholder}
        matchCount={matchCount}
        matchTotal={matchTotal}
        matchLabel={matchLabel}
        onEscape={props.onClose}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) props.onPrev();
            else props.onNext();
          }
        }}
        trailing={
          <>
            <button
              type="button"
              className="search-bar-btn"
              title={t('上一个 (Shift+Enter)')}
              aria-label={t('上一个')}
              disabled={props.matchTotal === 0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={props.onPrev}
            >
              <IconChevronUp size={12} />
            </button>
            <button
              type="button"
              className="search-bar-btn"
              title={t('下一个 (Enter)')}
              aria-label={t('下一个')}
              disabled={props.matchTotal === 0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={props.onNext}
            >
              <IconChevronDown size={12} />
            </button>
            {props.extraTrailing}
            <button
              type="button"
              className="search-bar-btn"
              title={t('关闭 (Esc)')}
              aria-label={t('关闭查找')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={props.onClose}
            >
              <IconClose size={11} />
            </button>
          </>
        }
      />
    </div>
  );
}
