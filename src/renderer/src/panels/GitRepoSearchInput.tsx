import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchBar } from '../components/SearchBar';

/** 仓库搜索框输入防抖：父级 displayedRepos 重算不随每击键 */
export const SEARCH_QUERY_DEBOUNCE_MS = 150;

/** 仓库搜索框：本地受控 + 150ms 防抖上抛，击键不触发父级树过滤重算 */
export function GitRepoSearchInput({
  inputRef,
  onQueryChange,
  onClose,
  matchCount,
  matchTotal
}: {
  inputRef: { current: HTMLInputElement | null };
  onQueryChange: (q: string) => void;
  onClose: () => void;
  matchCount?: number;
  matchTotal?: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => onQueryChange(value), SEARCH_QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value, onQueryChange]);
  return (
    <SearchBar
      ref={(el) => {
        inputRef.current = el;
      }}
      placeholder={t('搜索仓库…')}
      aria-label={t('搜索仓库…')}
      value={value}
      onChange={setValue}
      matchCount={value.trim() ? matchCount : undefined}
      matchTotal={value.trim() ? matchTotal : undefined}
      onEscape={() => {
        setValue('');
        onQueryChange('');
        onClose();
      }}
      onBlur={() => {
        if (!value.trim()) onClose();
      }}
    />
  );
}
