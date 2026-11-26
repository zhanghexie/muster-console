import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ComposerReplySuggestions as ReplySuggestions } from '../../../../shared/replySuggestions';
import { IconClose } from '../icons';

const MAX_VISIBLE_GRAPHEMES = 10;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function visibleReply(reply: string): string {
  const chars = segmenter ? Array.from(segmenter.segment(reply), part => part.segment) : Array.from(reply);
  return chars.length > MAX_VISIBLE_GRAPHEMES ? `${chars.slice(0, MAX_VISIBLE_GRAPHEMES).join('')}…` : reply;
}

/** The candidate pills and their single, round-scoped clear action are shared by GUI and CLI. */
export function ComposerReplySuggestions({ suggestions, selectedIndex, onSelect, onClear, clearing }: {
  suggestions: ReplySuggestions;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClear?: () => void;
  clearing?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const visibleReplies = React.useMemo(() => suggestions.replies.map(visibleReply), [suggestions.replies]);
  return <div className="suggestion-capsules composer-reply-suggestions" role="group" aria-label={t('建议回复')}>
    {suggestions.replies.map((reply, index) => <button key={reply} type="button"
      className={`suggestion-capsule${index === selectedIndex ? ' is-selected' : ''}`}
      aria-pressed={index === selectedIndex}
      aria-label={reply}
      title={`${reply}\n${suggestions.replies.length > 1 ? t('Shift+Tab 切换建议，Tab 填入') : t('选择建议，按 Tab 填入')}`}
      onClick={() => onSelect(index)}>
      <span className="composer-reply-viewport"><span className="composer-reply-label">{visibleReplies[index]}</span></span>
    </button>)}
    {onClear ? <button type="button" className="composer-replies-clear" disabled={clearing}
      aria-label={t('清除本轮建议')} title={t('清除本轮建议')} onClick={onClear}><IconClose size={12}/></button> : null}
  </div>;
}
