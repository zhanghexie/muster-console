import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** 聊天、文件与网页批注共用的纯色编辑内容；定位和引用来源由宿主负责。 */
export function NoteEditor({ initial, source, placeholder, edit = false, onSave, onCancel, onDelete, onChange, footer }: {
  initial: string;
  source?: React.ReactNode;
  placeholder?: string;
  edit?: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
  onChange?: (text: string) => void;
  footer?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const original = useRef(initial);
  const canSave = !!text.trim() && (!edit || text.trim() !== original.current.trim());
  useEffect(() => {
    inputRef.current?.focus();
    if (edit) inputRef.current?.select();
  }, [edit]);
  const save = (): void => { if (canSave) onSave(text.trim()); };
  return <>
    <div className="msg-note-bubble-head">
      <span>{t('批注')}</span>
      <button type="button" aria-label={t('关闭批注')} onClick={onCancel}>×</button>
    </div>
    {source && <div className="msg-note-bubble-loc">{source}</div>}
    <textarea ref={inputRef} className="msg-note-bubble-input" value={text}
      placeholder={placeholder ?? t('批注内容…')} aria-label={t('批注内容…')}
      onChange={e => { setText(e.target.value); onChange?.(e.target.value); }} onKeyDown={e => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); }
      }}/>
    {footer}
    <div className="msg-note-bubble-actions">
      {onDelete && <button type="button" className="msg-note-bubble-del" onClick={onDelete}>{t('删除批注')}</button>}
      <span className="msg-note-bubble-spacer"/>
      <button type="button" onClick={onCancel}>{t('取消')}</button>
      <button type="button" className={edit ? 'is-ok' : 'msg-note-bubble-ok'} title="Ctrl+Enter"
        disabled={!canSave} onClick={save}>{t('保存')}</button>
    </div>
  </>;
}
