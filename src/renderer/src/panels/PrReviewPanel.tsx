import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PrDetail, PrInlineDraft, PrRepoScope, PrReviewEvent, PrSummary, PrVersion, SubmitPrReviewInput
} from '../../../shared/githubPr';
import { AppConfirmDialog } from '../components/AppConfirmDialog';
import { ErrorTip } from '../components/ErrorTip';
import { IconBranch, IconCheck, IconChevronLeft, IconClock, IconClose, IconExternalLink, IconInfo, IconRefresh,
  IconSparkle, IconTrash, IconUpload } from '../components/icons';
import { PrChangedFiles } from './PrChangedFiles';

const CHECK_LABELS = {
  pass: 'CI 通过', failure: 'CI 失败', pending: 'CI 运行中', unknown: 'CI 未知'
} as const;
const CHECK_ICONS = { pass: IconCheck, failure: IconClose, pending: IconClock, unknown: IconInfo } as const;
const DECISIONS = { APPROVED: '已批准', CHANGES_REQUESTED: '要求修改', REVIEW_REQUIRED: '等待评审' } as const;
const REVIEW_EVENTS = { COMMENT: '发表评论', APPROVE: '批准', REQUEST_CHANGES: '要求修改' } as const;
const TEXT_REVIEW_EVENTS = ['COMMENT', 'REQUEST_CHANGES'] as const;

export function PrStateBadges({ pr }: { pr: PrSummary }): React.JSX.Element {
  const { t } = useTranslation();
  const CheckIcon = pr.checks === 'none' ? null : CHECK_ICONS[pr.checks];
  const checkLabel = pr.checks === 'none' ? undefined : t(CHECK_LABELS[pr.checks]);
  return <span className="pr-state-badges">
    {CheckIcon && <span className={`pr-checks-badge is-${pr.checks}`} role="img" aria-label={checkLabel} title={checkLabel}>
      <CheckIcon size={14} />
    </span>}
    {pr.reviewDecision && <span>{t(DECISIONS[pr.reviewDecision])}</span>}
  </span>;
}

function link(url: string) { void window.api.shell.openExternal(url); }

function versionFor(pr: PrDetail): PrVersion {
  return { repository: pr.repository, number: pr.number, headSha: pr.headSha, baseSha: pr.baseSha };
}

function inlineKey({ path, line, side }: PrInlineDraft) {
  return JSON.stringify([path, line, side]);
}

export function PrReviewPanel({ scope, repository, number, login, active, markSeen, onClose }: {
  scope: PrRepoScope;
  repository: string;
  number: number;
  login: string;
  active: boolean;
  markSeen: (pr: PrSummary) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<PrDetail>();
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [installUrl, setInstallUrl] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [inline, setInline] = useState<PrInlineDraft[]>([]);
  const [reviewBody, setReviewBody] = useState('');
  const [reviewEvent, setReviewEvent] = useState<(typeof TEXT_REVIEW_EVENTS)[number]>('COMMENT');
  const [confirm, setConfirm] = useState<SubmitPrReviewInput | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [knownVersion, setKnownVersion] = useState('');
  const [refresh, setRefresh] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  const reviewInput = useRef<HTMLTextAreaElement>(null);
  const inlineInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const focusInline = useRef<string>();
  const activeRef = useRef(active);
  activeRef.current = active;
  const detailGeneration = useRef(0);
  const extendedAtRefresh = useRef<number>();

  useLayoutEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    if (focusInline.current) {
      inlineInputs.current.get(focusInline.current)?.focus();
      focusInline.current = undefined;
    }
  }, [inline]);

  useEffect(() => {
    ++detailGeneration.current;
    if (!active) {
      setLoading(false);
      setPageBusy(false);
      setConfirm(null);
      return;
    }
    // Like the PR list, keep an explicitly paginated view until manual refresh.
    if (extendedAtRefresh.current === refresh) return;
    let alive = true;
    setLoading(true);
    setError('');
    setInstallUrl(undefined);
    void (async () => {
      try {
        const result = await window.api.pr.detail(scope, number);
        if (!alive || !activeRef.current) return;
        if (!result.ok) {
          setError(result.message);
          setInstallUrl(result.installUrl);
          setReadFailed(true);
          if (result.kind !== 'network' && result.kind !== 'rateLimit' && result.kind !== 'failed') setDetail(undefined);
          return;
        }
        const snapshot = result.value;
        setReadFailed(false);
        setDetail(snapshot);
        markSeen(snapshot);
      } catch {
        if (alive && activeRef.current) { setError(t('读取 GitHub 失败，请重试')); setReadFailed(true); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [active, scope, number, markSeen, refresh, t]);

  useEffect(() => {
    if (!detail) return;
    const current = `${detail.baseSha}:${detail.headSha}`;
    if (current === knownVersion) return;
    setKnownVersion(current);
    setReviewBody(detail.draft?.body ?? '');
    setSelected([]);
    setInline([]);
    setReviewEvent('COMMENT');
    if (knownVersion) setNotice(t('PR 已更新到新的提交版本'));
  }, [detail, knownVersion, t]);

  const paginate = async (kind: 'files' | 'threads') => {
    if (!activeRef.current || !detail || loading || readFailed || busy || pageBusy) return;
    const version = versionFor(detail);
    const generation = detailGeneration.current;
    const current = () => activeRef.current && generation === detailGeneration.current;
    setPageBusy(true);
    setError('');
    try {
      if (kind === 'files') {
        const result = await window.api.pr.files(scope, version, detail.filesPage + 1);
        if (!current()) return;
        if (!result.ok) setError(result.message);
        else {
          extendedAtRefresh.current = refresh;
          setDetail(pr => pr?.headSha === version.headSha && pr.baseSha === version.baseSha ? {
            ...pr, ...result.value, files: [...new Map([...pr.files, ...result.value.files].map(item => [item.path, item])).values()],
            filesPage: pr.filesPage + 1
          } : pr);
        }
      } else if (detail.threadCursor) {
        const result = await window.api.pr.threads(scope, version, detail.threadCursor);
        if (!current()) return;
        if (!result.ok) setError(result.message);
        else {
          extendedAtRefresh.current = refresh;
          setDetail(pr => pr?.headSha === version.headSha && pr.baseSha === version.baseSha ? { ...pr, ...result.value,
            threads: [...new Map([...pr.threads, ...result.value.threads].map(item => [item.id, item])).values()] } : pr);
        }
      }
    } catch { if (current()) setError(t('读取 GitHub 失败，请重试')); }
    finally { if (current()) setPageBusy(false); }
  };

  const runReviewAction = async (kind: 'draft' | 'forward') => {
    if (!activeRef.current || !detail || busy || loading || readFailed) return;
    const version = versionFor(detail);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (kind === 'draft') {
        const result = await window.api.pr.draft(scope, version);
        if (!result.ok) { setError(result.message); return; }
        setReviewEvent('COMMENT');
        setReviewBody(result.value.body);
        setDetail(pr => pr ? { ...pr, draft: result.value } : pr);
        if (activeRef.current) reviewInput.current?.focus();
        setNotice(t('审查草稿已生成'));
      } else {
        const result = await window.api.pr.forward(scope, version, selected);
        if (!result.ok) { setError(result.message); return; }
        setSelected([]);
        setNotice(t('评论已发给 {{name}}', { name: result.value.workerName }));
      }
    } catch { setError(t('GitHub 操作失败，请重试')); }
    finally { setBusy(false); }
  };

  const pickLine = (line: PrInlineDraft) => {
    const key = inlineKey(line);
    const editor = inlineInputs.current.get(key);
    if (editor) editor.focus();
    else if (inline.length < 20) {
      focusInline.current = key;
      setInline(list => [...list, line]);
    }
  };

  const confirmReview = (pr: PrDetail, event: PrReviewEvent) => {
    setConfirm({
      version: versionFor(pr), event, body: reviewBody.trim(),
      comments: inline.map(item => ({ ...item, body: item.body.trim() }))
    });
  };

  const publish = async () => {
    if (!activeRef.current || !confirm || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setInstallUrl(undefined);
    try {
      const result = await window.api.pr.publish(scope, confirm);
      setConfirm(null);
      if (result.ok) {
        setNotice(t('评审已发布到 GitHub'));
        setReviewBody('');
        setInline([]);
        setReviewEvent('COMMENT');
        setRefresh(value => value + 1);
      } else { setError(result.message); setInstallUrl(result.installUrl); }
    } catch { setConfirm(null); setError(t('GitHub 操作失败，请重试')); }
    finally { setBusy(false); }
  };

  const canComment = detail?.state === 'OPEN' && !busy && !confirm && !readFailed;
  const canReview = canComment && !loading;
  const ownPr = detail?.author?.toLowerCase() === login.toLowerCase();
  const hasEmptyInlineComment = inline.some(item => !item.body.trim());
  const canPublish = canReview && !hasEmptyInlineComment;
  const forwardLabel = detail?.workerName ? `${t('发送给 Worker')} · ${detail.workerName}` : undefined;
  return <section className="pr-review" aria-label={t('PR 详情')}>
    <div className="pr-toolbar">
      <div className="pr-toolbar-location">
        <button ref={back} type="button" className="right-icon" disabled={busy} aria-label={t('返回 PR 列表')}
          title={t('返回 PR 列表')} onClick={onClose}><IconChevronLeft size={16} /></button>
        <strong className="pr-toolbar-title" title={repository}>{repository}</strong>
      </div>
      <div className="pr-toolbar-actions">
        <button type="button" className="right-icon" disabled={busy || loading || pageBusy} aria-label={t('刷新')}
          onClick={() => setRefresh(value => value + 1)}><IconRefresh size={15} /></button>
        {detail && <button type="button" className="right-icon" aria-label={t('在 GitHub 打开')}
          title={t('在 GitHub 打开')} onClick={() => link(detail.url)}><IconExternalLink size={15} /></button>}
      </div>
    </div>
    {error && <ErrorTip active={active} message={error} />}
    {error && installUrl && <button type="button" className="git-btn" onClick={() => link(installUrl)}>{t('在 GitHub 授权仓库')}</button>}
    {notice && <p role="status" className="pr-notice">{notice}</p>}
    {!detail && loading && <p className="empty-hint" role="status">{t('正在读取 PR…')}</p>}
    {detail && <div className="pr-review-scroll">
      <header className="pr-review-intro">
        <h2><span className="pr-number">#{detail.number}</span> {detail.title}</h2>
        <div className="pr-row-meta pr-review-meta">
          <IconBranch size={14} /><span className="pr-branches" title={`${detail.headRefName} → ${detail.baseRefName}`}>
            {detail.headRefName} → {detail.baseRefName}
          </span>
          <code title={detail.headSha}>{detail.headSha.slice(0, 10)}</code><PrStateBadges pr={detail} /></div>
        {detail.body && <p className="pr-review-text">{detail.body}</p>}
      </header>
      <PrChangedFiles files={detail.files} hasMore={detail.filesHaveMore} canComment={canComment} onPickLine={pickLine}
        loadingMore={pageBusy || busy || loading || readFailed} onLoadMore={() => void paginate('files')} />
      {detail.checkEntries.length > 0 && <section className="pr-review-section">
        <h3>{t('CI 检查')}</h3>
        <ul className="pr-detail-list">{detail.checkEntries.map((check, index) => <li key={`${check.name}-${index}`} className="pr-check-line">
          {check.url ? <button type="button" className="git-btn ghost tiny" onClick={() => link(check.url!)}>{check.name}</button> : <span>{check.name}</span>}
          <span className="pr-muted">{check.state}</span>
        </li>)}</ul>
        {detail.checksTruncated && <p className="pr-muted">{t('其余检查可在 GitHub 查看')}</p>}
      </section>}
      <section className="pr-review-section">
        <div className="pr-section-head"><h3>{t('讨论与评审')}</h3>
          {forwardLabel && <button type="button" className="right-icon" aria-label={forwardLabel} title={forwardLabel}
            disabled={!selected.length || !canReview} onClick={() => void runReviewAction('forward')}>
            <IconUpload size={15} />
          </button>}
        </div>
        {detail.discussion.map(item => <div className="pr-discussion-entry" key={item.id}>
          <strong>{item.author ?? t('未知用户')}</strong>
          {item.reviewState && <span className="pr-muted">{t(DECISIONS[item.reviewState as keyof typeof DECISIONS] ?? item.reviewState)}</span>}
          {item.body && <p className="pr-review-text">{item.body}</p>}
        </div>)}
        {detail.threads.map(thread => <article className="pr-discussion-entry" key={thread.id}>
          <label className="pr-thread-label">
            {detail.workerName && <input type="checkbox" checked={selected.includes(thread.id)} disabled={busy ||
              (selected.length >= 20 && !selected.includes(thread.id))}
              onChange={e => setSelected(ids => e.target.checked ? [...ids, thread.id] : ids.filter(id => id !== thread.id))} />}
            <code>{thread.path}{thread.line ? `:${thread.line}` : ''}</code>
            {thread.resolved && <span>{t('已解决')}</span>}
            {thread.outdated && <span>{t('陈旧行')}</span>}
          </label>
          {thread.comments.map(item => <div className="pr-thread-comment" key={item.id}><strong>{item.author ?? t('未知用户')}</strong>
            <p className="pr-review-text">{item.body}</p></div>)}
          {thread.commentsTruncated && <p className="pr-muted">{t('更早的讨论可在 GitHub 查看')}</p>}
        </article>)}
        {detail.threadCursor && <button type="button" className="git-btn ghost" disabled={pageBusy || busy || loading}
          onClick={() => void paginate('threads')}>{t('加载更多讨论')}</button>}
        {!detail.discussion.length && !detail.threads.length && <p className="pr-muted">{t('暂无讨论')}</p>}
      </section>
      {detail.state === 'OPEN' && <section className="pr-review-section pr-review-editor">
        <div className="pr-section-head"><h3>{t('提交评审')}</h3>
          <button type="button" className="right-icon" disabled={!canReview || !!reviewBody.trim()}
            aria-label={t('生成审查草稿')} title={t('生成审查草稿')} onClick={() => void runReviewAction('draft')}>
            <IconSparkle size={15} />
          </button></div>
        {detail.draft?.partial && <p className="pr-muted">{t('审查草稿基于部分 Diff')}</p>}
        <div role="group" aria-label={t('评审结果')} className="pr-toolbar-actions">
          {TEXT_REVIEW_EVENTS.map(event => (
            <button type="button" key={event} className="git-btn ghost" aria-pressed={reviewEvent === event}
              disabled={!canReview || (ownPr && event === 'REQUEST_CHANGES')} onClick={() => setReviewEvent(event)}>{t(REVIEW_EVENTS[event])}</button>
          ))}
        </div>
        <label className="pr-field"><span className="pr-field-label">{t('评审正文')}</span>
          <textarea ref={reviewInput} className="pr-input pr-textarea" rows={4} disabled={!canComment}
            value={reviewBody} maxLength={65_536} onChange={event => setReviewBody(event.target.value)} />
        </label>
        {inline.map((draft, index) => <div className="pr-inline-draft" key={inlineKey(draft)}>
          <label className="pr-field"><span className="pr-field-label">{draft.path}:{draft.line} · {draft.side}</span>
            <textarea className="pr-input pr-textarea" rows={2} maxLength={8192} value={draft.body} disabled={!canComment}
              ref={node => {
                const key = inlineKey(draft);
                if (node) inlineInputs.current.set(key, node);
                else inlineInputs.current.delete(key);
              }}
              onChange={event => setInline(list => list.map((item, i) => i === index ? { ...item, body: event.target.value } : item))} />
          </label>
          <button type="button" className="right-icon" disabled={!canReview} aria-label={t('删除评论')} title={t('删除评论')}
            onClick={() => setInline(list => list.filter((_, i) => i !== index))}><IconTrash size={14} /></button>
        </div>)}
        <div className="pr-toolbar-actions">
          <button type="button" className="git-btn" aria-haspopup="dialog" disabled={!canPublish || !reviewBody.trim()}
            onClick={() => confirmReview(detail, reviewEvent)}>{t('发布评审…')}</button>
          <button type="button" className="git-btn" aria-haspopup="dialog" disabled={!canPublish || ownPr}
            onClick={() => confirmReview(detail, 'APPROVE')}><IconCheck size={14} />{t('批准…')}</button>
        </div>
        {ownPr && <p className="pr-muted">{t('你可以评论自己的 PR。批准和要求修改由其他评审人提交。')}</p>}
        {hasEmptyInlineComment && <p className="pr-muted">{t('请填写或删除空白的行内评论。')}</p>}
      </section>}
    </div>}
    <AppConfirmDialog open={active && !!confirm} busy={busy} focusCancel title={t('发布 GitHub 评审')}
      detail={confirm ? t('以 {{login}} 向 {{repository}}#{{number}} 发布「{{decision}}」评审及 {{count}} 条行内评论。提交 {{sha}}。', {
        login, repository: confirm.version.repository, number: confirm.version.number, decision: t(REVIEW_EVENTS[confirm.event]),
        count: confirm.comments.length, sha: confirm.version.headSha.slice(0, 10)
      }) : ''}
      confirmLabel={t('发布')} onConfirm={() => void publish()} onCancel={() => setConfirm(null)} />
  </section>;
}
