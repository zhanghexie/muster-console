import { ErrorTip, ErrorTipDetails } from './ErrorTip';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { FeedbackEntry, FeedbackReview, FeedbackSnapshot, ManualFeedbackInput } from '../../../shared/feedback';
import { feedbackEditableText, feedbackEditorSections, joinFeedbackSections, type FeedbackEditorSection } from '../../../shared/feedbackFormatting';
import { isWebGateway } from '../webGatewayEnvironment';
import { showTip } from '../tips';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { IconClipboard } from './icons';
import { usePresence } from './motion';
import { AppConfirmDialog } from './AppConfirmDialog';
import { CustomSelect } from './CustomSelect';

const STATUS: Record<FeedbackEntry['status'], string> = {
  pending: '待审核', submitting: '正在打开 GitHub', opened: '已打开 GitHub', uncertain: '待核对', submitted: '已提交', duplicate: '已标记重复', rejected: '已拒绝'
};
const needsAttention = (entry: FeedbackEntry): boolean => ['pending', 'opened', 'uncertain'].includes(entry.status);
const EMPTY_MANUAL: ManualFeedbackInput = { kind: 'bug', title: '', area: '', context: '', actual: '', expected: '', steps: '', impact: '', evidence: '', suggestion: '', environment: '' };
const MANUAL_FIELDS: ReadonlyArray<{ key: Exclude<keyof ManualFeedbackInput, 'kind' | 'title'>; label: string }> = [
  { key: 'area', label: '涉及功能' }, { key: 'context', label: '使用场景' }, { key: 'actual', label: '实际情况' },
  { key: 'expected', label: '期望' }, { key: 'steps', label: '复现步骤或触发条件' },
  { key: 'evidence', label: '证据与不确定性' }, { key: 'suggestion', label: '建议' }, { key: 'environment', label: '环境' }
];

function AutoHeightField({ value, ...props }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & { value: string }): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [nativeSizing] = useState(() => typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content'));
  const fit = useCallback(() => {
    const field = ref.current;
    if (!field || !field.clientWidth) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
  }, []);
  useLayoutEffect(() => { if (!nativeSizing) fit(); }, [fit, nativeSizing, value]);
  useLayoutEffect(() => {
    const field = ref.current;
    if (nativeSizing || !field || typeof ResizeObserver === 'undefined') return;
    let width = -1;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined && next !== width) { width = next; fit(); }
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [fit, nativeSizing]);
  return <textarea {...props} ref={ref} rows={1} value={value}/>;
}

export function FeedbackEntryPoint({ variant = 'toolbar' }: { variant?: 'toolbar' | 'settings' }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<FeedbackSnapshot | null>(null);
  const [error, setError] = useState('');
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    if (isWebGateway()) return;
    const request = ++refreshSequence.current;
    try {
      const next = await window.api.feedback.snapshot();
      if (request !== refreshSequence.current) return;
      setSnapshot(next);
      setError('');
    } catch (cause) {
      if (request === refreshSequence.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const unsubscribe = window.api.on('feedback:changed', () => void refresh());
    return () => { ++refreshSequence.current; unsubscribe(); };
  }, [refresh]);
  const count = snapshot?.entries.filter(needsAttention).length ?? 0;
  return <>
    {variant === 'settings' ? <button type="button" className="btn tiny" onClick={() => setOpen(true)}>{t('反馈审核')}</button>
      : count > 0 && <button type="button" className="chrome-menu-btn chrome-icon-btn feedback-entry" onClick={() => setOpen(true)}
        aria-label={t('反馈审核（{{count}} 条待处理）', { count })} title={t('反馈审核')}>
        <IconClipboard size={15}/><span className="feedback-badge" aria-hidden>{count > 99 ? '99+' : count}</span>
      </button>}
    <FeedbackCenter open={open} onClose={() => setOpen(false)} snapshot={snapshot} onSnapshot={setSnapshot} onRefresh={refresh}
      initialError={error}/>
  </>;
}

export function FeedbackCenter({ open, onClose, snapshot, onSnapshot, onRefresh, initialError = '' }: {
  open: boolean; onClose: () => void; snapshot: FeedbackSnapshot | null;
  onSnapshot: (snapshot: FeedbackSnapshot) => void; onRefresh: () => Promise<void>; initialError?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(open);
  useOverlayDismiss(presence.mounted && presence.stage !== 'out', onClose);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<{ title: string; sections: FeedbackEditorSection[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<FeedbackReview | null>(null);
  const [adding, setAdding] = useState(false);
  const [manual, setManual] = useState<ManualFeedbackInput>(EMPTY_MANUAL);
  const [deleteTarget, setDeleteTarget] = useState<FeedbackEntry | null>(null);
  const deleting = useRef(false);
  const editorRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const entries = snapshot?.entries ?? [];
  const entry = entries.find(e => e.id === selected) ?? null;
  useEffect(() => {
    if (!entries.some(item => item.id === selected)) {
      setSelected((entries.find(needsAttention) ?? entries[0])?.id ?? '');
    }
  }, [entries, selected]);
  useEffect(() => { setDraft(entry ? { title: entry.title, sections: feedbackEditorSections(entry) } : null); setReview(null); }, [entry?.id, entry?.revision]);
  useEffect(() => { if (editorRef.current) editorRef.current.scrollTop = 0; }, [entry?.id, entry?.revision, review?.reviewId]);
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !active || getComputedStyle(list).display !== 'flex') return;
    const bounds = list.getBoundingClientRect(), row = active.getBoundingClientRect();
    if (row.left < bounds.left) list.scrollLeft += row.left - bounds.left;
    else if (row.right > bounds.right) list.scrollLeft += row.right - bounds.right;
  }, [selected, adding, entries.length, presence.mounted]);
  useEffect(() => { if (open) void onRefresh(); }, [open, onRefresh]);
  useEffect(() => { if (!open) setDeleteTarget(null); }, [open]);
  const text = draft ? `${draft.title}\n\n${joinFeedbackSections(draft.sections)}` : '';
  const dirty = !!entry && !!draft && text !== feedbackEditableText(entry);
  const sectionRequired = (section: FeedbackEditorSection): boolean => section.label === '类型' ||
    (section.label === '反馈正文' && draft?.sections.length === 1 && !section.prefix);
  const missingRequiredSection = !!draft?.sections.some(section => sectionRequired(section) && !section.value.trim());
  const fieldCaption = (label: string, required: boolean): React.JSX.Element => <span className="feedback-field-caption">{t(label)}
    <span className="feedback-field-requirement" aria-hidden="true">{t(required ? '必填' : '选填')}</span></span>;
  const reportError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
  };
  const run = async (operation: () => Promise<FeedbackSnapshot>): Promise<void> => {
    setBusy(true); setError('');
    try { onSnapshot(await operation()); setReview(null); }
    catch (err) { reportError(err); await onRefresh(); }
    finally { setBusy(false); }
  };
  const prepare = async (): Promise<void> => {
    if (!entry) return;
    setBusy(true); setError(''); setReview(null);
    try { setReview(await window.api.feedback.prepare(entry.id, entry.revision)); }
    catch (err) { reportError(err); await onRefresh(); }
    finally { setBusy(false); }
  };
  const copyIssueBody = async (item: FeedbackEntry): Promise<void> => {
    try {
      await window.api.feedback.copyIssueBody(item.id, item.revision);
      showTip(t('Issue 正文已复制。请在 GitHub 的 Write 页签粘贴。'));
    } catch (err) {
      showTip(err instanceof Error ? err.message : String(err), { tone: 'error' });
    }
  };
  const remove = async (): Promise<void> => {
    const target = deleteTarget;
    if (!target || deleting.current) return;
    deleting.current = true;
    setDeleteTarget(null);
    try { await run(() => window.api.feedback.delete(target.id, target.revision)); }
    finally { deleting.current = false; }
  };
  const createManual = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await window.api.feedback.createManual(manual);
      onSnapshot(result.snapshot); setSelected(result.id); setAdding(false); setManual(EMPTY_MANUAL); setReview(null);
    } catch (err) { reportError(err); }
    finally { setBusy(false); }
  };
  const deleteDetail = deleteTarget?.status === 'uncertain' || deleteTarget?.status === 'opened'
    ? t('发送结果尚未确认，删除后将无法核对；仓库中的 Issue 不受影响。')
    : deleteTarget?.issueUrl || deleteTarget?.status === 'submitted'
      ? t('只删除本机记录，不会删除仓库中的 Issue。')
      : t('删除后无法恢复。');
  if (!presence.mounted) return null;
  return <>{createPortal(
    <div className="modal-mask feedback-overlay mp-fly-overlay" data-overlay-root {...presence.spread}
      {...(!open ? { inert: '' } : {})}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mp-scrim-layer backdrop-blur-overlay mp-scrim" {...presence.spread} aria-hidden />
      <section className="modal feedback-modal mp-panel mp-panel-fly" data-mp-stage={presence.stage} role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <div className="modal-head"><h3 id="feedback-title">{t('反馈审核')}</h3><button type="button" className="modal-close" aria-label={t('关闭')} onClick={onClose}>×</button></div>
        {isWebGateway() ? <p role="alert">{t('反馈审核只支持本机工作台窗口')}</p> : <>
          <ErrorTip message={open ? error || initialError : null} />
          <div className="feedback-layout">
            <div className="feedback-sidebar">
              <nav ref={listRef} className="feedback-list" aria-label={t('反馈列表')}>
                {entries.slice().reverse().map(item => <button key={item.id} type="button" className={`feedback-row${!adding && selected === item.id ? ' is-selected' : ''}`}
                  aria-current={!adding && selected === item.id ? 'true' : undefined} title={item.title} onClick={() => { setSelected(item.id); setAdding(false); setError(''); }}>
                  <strong>{item.title}</strong><span>{t(STATUS[item.status])}{item.area ? ` · ${item.area}` : ''}</span>
                </button>)}
              </nav>
              <button type="button" className="btn feedback-add" disabled={busy} onClick={() => { setAdding(true); setReview(null); setError(''); }}>{t('手动添加反馈')}</button>
            </div>
            <div className="feedback-detail">
              {adding ? <>
                <div className="feedback-detail-heading"><strong>{t('手动添加反馈')}</strong></div>
                <section ref={editorRef} className="feedback-editor" aria-label={t('新建反馈')}>
                  <label>{fieldCaption('标题', true)}<AutoHeightField value={manual.title} required maxLength={180} disabled={busy}
                    onChange={event => setManual({ ...manual, title: event.target.value.replace(/[\r\n]+/g, ' ') })}/></label>
                  <label>{fieldCaption('类型', true)}<CustomSelect ariaLabel={t('类型')} className="feedback-type-select" value={manual.kind} disabled={busy}
                    onChange={value => setManual({ ...manual, kind: value as ManualFeedbackInput['kind'] })}
                    options={[{ value: 'bug', label: t('问题') }, { value: 'improvement', label: t('改进建议') }]}/></label>
                  {MANUAL_FIELDS.map(field => <label key={field.key}>{fieldCaption(field.label, false)}<AutoHeightField data-feedback-field={field.key} value={manual[field.key]} disabled={busy}
                    onChange={event => setManual({ ...manual, [field.key]: event.target.value })}/></label>)}
                </section>
                <div className="feedback-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => { setAdding(false); setManual(EMPTY_MANUAL); setError(''); }}>{t('取消')}</button>
                  <button type="button" className="btn primary" disabled={busy || !manual.title.trim()} onClick={() => void createManual()}>{t('保存草稿')}</button>
                </div>
              </> : entry && draft ? <>
                <div className="feedback-detail-heading"><strong>{draft.title || entry.title}</strong><span className="feedback-status">{t(STATUS[entry.status])}</span></div>
                {entry.error && <ErrorTipDetails message={t(entry.error)} />}
                {entry.status === 'pending' && entry.aiChecked !== true && <p role="status" className="feedback-source">{t('等待 AI 查重')}</p>}
                {entry.status === 'opened' && <p role="status" className="feedback-source">{t('如果 GitHub 正文为空，请复制 Issue 正文并在 Write 页签粘贴。提交后回来核对。')}</p>}
                <section ref={editorRef} className="feedback-editor" aria-label={review ? t('提交前核对') : t('反馈编辑')}>
                  {review && <p className="feedback-source">{t('提交后，标题和正文将在 GitHub 上公开。')}
                    {review.copyBody && <> {t('正文较长，GitHub 只会预填标题。完整正文会复制到剪贴板，请在网页的 Write 页签粘贴后提交。')}</>}
                  </p>}
                  {review?.matches.some(m => m.exact) && <p role="alert">{t('发现相同反馈，已停止提交')}</p>}
                  {entry.status === 'pending' && !review && <label>{fieldCaption('标题', true)}
                    <AutoHeightField value={draft.title} required maxLength={180} disabled={busy} onChange={event => setDraft({ ...draft, title: event.target.value.replace(/[\r\n]+/g, ' ') })}/>
                  </label>}
                  {draft.sections.map((section, index) => section.optional && !section.value.trim() && (entry.status !== 'pending' || !!review) ? null : <label key={`${index}:${section.label}`}>
                    {entry.status === 'pending' && !review ? fieldCaption(section.label, sectionRequired(section)) : t(section.label)}
                    <AutoHeightField value={section.value} readOnly={entry.status !== 'pending' || !!review} required={entry.status === 'pending' && !review && sectionRequired(section)} disabled={busy}
                      onChange={event => setDraft({ ...draft, sections: draft.sections.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })}/>
                  </label>)}
                </section>
                <div className="feedback-actions">
                  <button type="button" className="btn feedback-delete" aria-label={t('删除反馈')} disabled={busy || entry.status === 'submitting'} onClick={() => setDeleteTarget(entry)}>{t('删除')}</button>
                  {entry.issueUrl && <button type="button" className="btn" onClick={() => void window.api.shell.openExternal(entry.issueUrl!)}>{t('查看已发送反馈')}</button>}
                  {entry.status === 'pending' && !review && <>
                    <button type="button" className="btn" disabled={busy || !dirty || !draft.title.trim() || missingRequiredSection} onClick={() => void run(() => window.api.feedback.updateText(entry.id, entry.revision, text))}>{t('保存草稿')}</button>
                    <button type="button" className="btn" disabled={busy} onClick={() => void run(() => window.api.feedback.reject(entry.id, entry.revision))}>{t('拒绝反馈')}</button>
                    <button type="button" className="btn primary" disabled={busy || dirty} onClick={() => void prepare()}>{t('审核反馈')}</button>
                  </>}
                  {entry.status === 'pending' && review && <>
                    <button type="button" className="btn" disabled={busy} onClick={() => setReview(null)}>{t('返回修改')}</button>
                    <button type="button" className="btn primary" disabled={busy || review.matches.some(m => m.exact)}
                      onClick={() => void run(() => window.api.feedback.submit(entry.id, entry.revision, review.reviewId, false))}>
                      {review.copyBody ? t('复制正文并打开 GitHub') : t('在 GitHub 提交')}</button>
                  </>}
                  {(entry.status === 'rejected' || entry.status === 'duplicate') && <button type="button" className="btn" disabled={busy} onClick={() => void run(() => window.api.feedback.restore(entry.id, entry.revision))}>{t('恢复待审核')}</button>}
                  {entry.status === 'opened' && <>
                    <button type="button" className="btn" disabled={busy} onClick={() => void copyIssueBody(entry)}>{t('复制 Issue 正文')}</button>
                    <button type="button" className="btn" disabled={busy} onClick={() => void run(() => window.api.feedback.reconcile(entry.id, entry.revision, true))}>{t('已关闭网页，恢复草稿')}</button>
                  </>}
                  {(entry.status === 'opened' || entry.status === 'uncertain') && <button type="button" className="btn" disabled={busy} onClick={() => void run(() => window.api.feedback.reconcile(entry.id, entry.revision))}>{t('核对是否已提交')}</button>}
                </div>
              </> : <p>{t(entries.length ? '选择一条反馈进行审核' : '暂无反馈')}</p>}
            </div>
          </div>
        </>}
      </section>
    </div>, document.body
  )}<AppConfirmDialog open={!!deleteTarget && open} className="feedback-delete-confirm" title={t('删除反馈？')}
    detail={deleteTarget ? `${deleteTarget.title}\n\n${deleteDetail}` : deleteDetail} confirmLabel={t('删除')} danger
    onCancel={() => setDeleteTarget(null)} onConfirm={() => void remove()}/></>;
}
