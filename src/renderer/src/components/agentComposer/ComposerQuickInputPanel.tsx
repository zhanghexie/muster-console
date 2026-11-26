import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Presence } from '../motion';
import type { QuickPhrase } from '../../../../shared/composerTools';

export interface QipEdit {
  id: string | null;
  key: string;
  value: string;
}

interface Props {
  presence: Presence;
  qipRef: MutableRefObject<HTMLDivElement | null>;
  qipEdit: QipEdit | null;
  setQipEdit: Dispatch<SetStateAction<QipEdit | null>>;
  qipFiltered: QuickPhrase[];
  phrasesCount: number;
  qipActive: number;
  setActive: (idx: number) => void;
  qipKeyRef: MutableRefObject<HTMLInputElement | null>;
  qipValueRef: MutableRefObject<HTMLTextAreaElement | null>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onInsert: (p: QuickPhrase) => void;
  onSave: () => void;
  onDelete: (id: string) => void;
  onClose?: () => void;
}

/** 快捷短语面板（/quickInput 命令态；纯展示）：搜索结果由主输入框全文过滤，
 *  这里只负责列表/编辑表单与增删改入口。 */
export function ComposerQuickInputPanel({
  presence,
  qipRef,
  qipEdit,
  setQipEdit,
  qipFiltered,
  phrasesCount,
  qipActive,
  setActive,
  qipKeyRef,
  qipValueRef,
  onKeyDown,
  onInsert,
  onSave,
  onDelete,
  onClose
}: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!presence.mounted) return null;
  return (
    <div
      className="agent-composer-qip mp-pop"
      data-mp-stage={presence.stage}
      ref={qipRef}
      role="dialog"
      aria-label={t('快捷短语')}
      aria-hidden={presence.stage === 'out'}
      {...(presence.stage === 'out' ? { inert: '' } : {})}
      onKeyDown={onKeyDown}
    >
      {qipEdit ? (
        <div className="agent-composer-qip-form">
          <input
            ref={qipKeyRef}
            className="agent-composer-qip-input"
            placeholder={t('名称（如：地址）')}
            value={qipEdit.key}
            onChange={(e) => setQipEdit({ ...qipEdit, key: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                qipValueRef.current?.focus();
              }
            }}
          />
          <textarea
            ref={qipValueRef}
            className="agent-composer-qip-value"
            placeholder={t('内容（点选该短语时插入输入框的文本）')}
            value={qipEdit.value}
            onChange={(e) => setQipEdit({ ...qipEdit, value: e.target.value })}
          />
          <div className="agent-composer-qip-form-actions">
            <span className="agent-composer-qip-form-hint">{t('Enter 换行 · Ctrl+Enter 保存')}</span>
            <button
              type="button"
              className="agent-composer-qip-save"
              disabled={!qipEdit.key.trim() && !qipEdit.value.trim()}
              onClick={onSave}
            >
              {t('保存')}
            </button>
            <button type="button" onClick={() => setQipEdit(null)}>
              {t('取消')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="agent-composer-qip-head">
            <span className="agent-composer-qip-title">{t('快捷短语')}</span>
            <button
              type="button"
              className="agent-composer-qip-add"
              onClick={() => {
                setQipEdit({ id: null, key: '', value: '' });
                requestAnimationFrame(() => qipKeyRef.current?.focus());
              }}
            >
              {t('新增短语')}
            </button>
            {onClose && <button type="button" className="modal-close" aria-label={t('取消命令')} onClick={onClose}>×</button>}
          </div>
          <div className="agent-composer-qip-list" role="listbox">
            {qipFiltered.length === 0 ? (
              <div className="agent-composer-qip-empty">
                {phrasesCount === 0
                  ? t('暂无快捷短语；点「新增短语」建一条（名称 + 内容）')
                  : t('无匹配短语')}
              </div>
            ) : (
              qipFiltered.map((p, i) => (
                <div
                  key={p.id}
                  className={`agent-composer-qip-item${i === qipActive ? ' is-active' : ''}`}
                  data-active={i === qipActive ? 'true' : undefined}
                  onMouseEnter={() => setActive(i)}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === qipActive}
                    className="agent-composer-qip-item-main"
                    title={p.value || p.key}
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      onInsert(p);
                    }}
                  >
                    {p.key ? <span className="agent-composer-qip-key">{p.key}</span> : null}
                    <span className="agent-composer-qip-val">{p.value || p.key}</span>
                  </button>
                  <span className="agent-composer-qip-item-tools">
                    <button
                      type="button"
                      title={t('编辑短语')}
                      aria-label={t('编辑短语')}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        setQipEdit({ id: p.id, key: p.key, value: p.value });
                        requestAnimationFrame(() => qipKeyRef.current?.focus());
                      }}
                    >
                      {t('编辑')}
                    </button>
                    <button
                      type="button"
                      title={t('删除短语')}
                      aria-label={t('删除短语')}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        onDelete(p.id);
                      }}
                    >
                      {t('删除')}
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
