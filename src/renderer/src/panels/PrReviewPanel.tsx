import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PrDetail, PrFile, PrInlineDraft, PrRepoScope, PrReviewEvent, PrSummary, PrVersion, SubmitPrReviewInput
} from '../../../shared/githubPr';
import { AnimatedDetails } from '../components/AnimatedDetails';
import { AppConfirmDialog } from '../components/AppConfirmDialog';
import { ErrorTip } from '../components/ErrorTip';

const CHECK_LABELS = {
  pass: 'CI 通过', failure: 'CI 失败', pending: 'CI 运行中', unknown: 'CI 未知'
} as const;
const DECISIONS = { APPROVED: '已批准', CHANGES_REQUESTED: '要求修改', REVIEW_REQUIRED: '等待评审' } as const;
const REVIEW_EVENTS = { COMMENT: '发表评论', APPROVE: '批准', REQUEST_CHANGES: '要求修改' } as const;

export function PrStateBadges({ pr }: { pr: PrSummary }): React.JSX.Element {
  const { t } = useTranslation();
  return <span className="pr-state-badges">
    {pr.checks !== 'none' && <span className={`pr-checks-badge is-${pr.checks}`}>
      <span className="pr-checks-dot" aria-hidden="true" /><span className="pr-checks-text">{t(CHECK_LABELS[pr.checks])}</span>
    </span>}
    {pr.reviewDecision && <span>{t(DECISIONS[pr.reviewDecision])}</span>}
  </span>;
}

function link(url: string) { void window.api.shell.openExternal(url); }

function patchRows(patch: string) {
  let left = 0;
  let right = 0;
  return patch.split('\n').map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { left = Number(hunk[1]); right = Number(hunk[2]); return { text, line: 0, side: 'RIGHT' as const }; }
    if (text.startsWith('+')) return { text, line: right++, side: 'RIGHT' as const };
    if (text.startsWith('-')) return { text, line: left++, side: 'LEFT' as const };
    if (text.startsWith(' ')) { left++; return { text, line: right++, side: 'RIGHT' as const }; }
    return { text, line: 0, side: 'RIGHT' as const };
  });
}

function Patch({ file, canComment, onPick }: { file: PrFile; canComment: boolean; onPick: (line: PrInlineDraft) => void }) {
  const { t } = useTranslation();
  if (!file.patch) return <p className="pr-muted">{t('GitHub 未提供此文件的文本补丁')}</p>;
  return <div className="pr-patch" role="region" aria-label={file.path} tabIndex={0}>
    {patchRows(file.patch).map(({ text, side, line }, index, rows) => {
      const selectable = !!line && canComment && !(file.truncated && index === rows.length - 1);
      const kind = text[0] === '+' ? 'add' : text[0] === '-' ? 'remove' : text.startsWith('@@') ? 'hunk' : 'context';
      return <div className={`pr-patch-row is-${kind}`} key={index}>
        {selectable
          ? <button type="button" className="pr-patch-number" aria-label={t('评论第 {{line}} 行', { line })}
              onClick={() => onPick({ path: file.path, line, side, body: '' })}>{line}</button>
          : <span className="pr-patch-number">{line || ''}</span>}
        <code>{text}</code>
      </div>;
    })}
    {file.truncated && <p className="pr-muted">{t('此处仅显示部分补丁，请在 GitHub 查看完整变更')}</p>}
  </div>;
}

function versionFor(pr: PrDetail): PrVersion {
  return { repository: pr.repository, number: pr.number, headSha: pr.headSha, baseSha: pr.baseSha };
}

function inlineKey({ path, line, side }: PrInlineDraft) {
  return JSON.stringify([path, line, side]);
}

export function PrReviewPanel({ scope, number, login, markSeen, onClose }: {
  scope: PrRepoScope;
  number: number;
  login: string;
  markSeen: (pr: PrSummary) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<PrDetail>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [installUrl, setInstallUrl] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [inline, setInline] = useState<PrInlineDraft[]>([]);
  const [reviewBody, setReviewBody] = useState('');
  const [reviewEvent, setReviewEvent] = useState<PrReviewEvent>('COMMENT');
  const [confirm, setConfirm] = useState<SubmitPrReviewInput | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [knownVersion, setKnownVersion] = useState('');
  const [refresh, setRefresh] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  const reviewInput = useRef<HTMLTextAreaElement>(null);
  const inlineInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const focusInline = useRef<string>();

  useLayoutEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    if (focusInline.current) {
      inlineInputs.current.get(focusInline.current)?.focus();
      focusInline.current = undefined;
    }
  }, [inline]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setInstallUrl(undefined);
    void (async () => {
      try {
        const result = await window.api.pr.detail(scope, number);
        if (!alive) return;
        if (!result.ok) { setError(result.message); setInstallUrl(result.installUrl); setDetail(undefined); return; }
        const snapshot = result.value;
        setDetail(snapshot);
        markSeen(snapshot);
      } catch {
        if (alive) { setError(t('读取 GitHub 失败，请重试')); setDetail(undefined); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [scope, number, markSeen, refresh, t]);

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
    if (!detail || loading || busy || pageBusy) return;
    const version = versionFor(detail);
    setPageBusy(true);
    setError('');
    try {
      if (kind === 'files') {
        const result = await window.api.pr.files(scope, version, detail.filesPage + 1);
        if (!result.ok) setError(result.message);
        else setDetail(pr => pr?.headSha === version.headSha && pr.baseSha === version.baseSha ? {
          ...pr, ...result.value, files: [...new Map([...pr.files, ...result.value.files].map(item => [item.path, item])).values()],
          filesPage: pr.filesPage + 1
        } : pr);
      } else if (detail.threadCursor) {
        const result = await window.api.pr.threads(scope, version, detail.threadCursor);
        if (!result.ok) setError(result.message);
        else setDetail(pr => pr?.headSha === version.headSha && pr.baseSha === version.baseSha ? { ...pr, ...result.value,
          threads: [...new Map([...pr.threads, ...result.value.threads].map(item => [item.id, item])).values()] } : pr);
      }
    } catch { setError(t('读取 GitHub 失败，请重试')); }
    finally { setPageBusy(false); }
  };

  const runReviewAction = async (kind: 'draft' | 'forward') => {
    if (!detail || busy || loading) return;
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
        reviewInput.current?.focus();
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

  const publish = async () => {
    if (!confirm || busy) return;
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

  const canReview = detail?.state === 'OPEN' && !loading && !busy && !confirm;
  const ownPr = detail?.author?.toLowerCase() === login.toLowerCase();
  return <section className="pr-review" aria-label={t('PR 详情')}>
    <div className="pr-toolbar pr-review-actions">
      <button ref={back} type="button" className="git-btn ghost" disabled={busy} onClick={onClose}>{t('返回 PR 列表')}</button>
      <div className="pr-toolbar-actions">
        <button type="button" className="git-btn ghost" disabled={busy || loading || pageBusy} onClick={() => setRefresh(value => value + 1)}>{t('刷新')}</button>
        {detail && <button type="button" className="git-btn ghost" onClick={() => link(detail.url)}>{t('在 GitHub 打开')}</button>}
      </div>
    </div>
    {error && <ErrorTip message={error} />}
    {error && installUrl && <button type="button" className="git-btn" onClick={() => link(installUrl)}>{t('在 GitHub 授权仓库')}</button>}
    {notice && <p role="status" className="pr-notice">{notice}</p>}
    {!detail && loading && <p className="empty-hint" role="status">{t('正在读取 PR…')}</p>}
    {detail && <div className="pr-review-scroll">
      <header className="pr-review-intro">
        <h2><span className="pr-number">#{detail.number}</span> {detail.title}</h2>
        <div className="pr-row-meta pr-review-meta"><span className="pr-branches">{detail.headRefName} → {detail.baseRefName}</span>
          <code title={detail.headSha}>{detail.headSha.slice(0, 10)}</code><PrStateBadges pr={detail} /></div>
        {detail.body && <p className="pr-review-text">{detail.body}</p>}
      </header>
      {detail.checkEntries.length > 0 && <section className="pr-review-section">
        <h3>{t('CI 检查')}</h3>
        <ul className="pr-detail-list">{detail.checkEntries.map((check, index) => <li key={`${check.name}-${index}`} className="pr-check-line">
          {check.url ? <button type="button" className="git-btn ghost tiny" onClick={() => link(check.url!)}>{check.name}</button> : <span>{check.name}</span>}
          <span className="pr-muted">{check.state}</span>
        </li>)}</ul>
        {detail.checksTruncated && <p className="pr-muted">{t('其余检查可在 GitHub 查看')}</p>}
      </section>}
      <section className="pr-review-section">
        <h3>{t('变更文件')}</h3>
        {canReview && detail.files.some(file => file.patch) && <p className="pr-muted">{t('选择行号可添加行内评论')}</p>}
        <div className="pr-files">{detail.files.map(file => <AnimatedDetails key={file.path} className="pr-file" summary={
          <span className="pr-file-summary"><span>{file.path}</span><code>+{file.additions} −{file.deletions}</code></span>
        }>
          <Patch file={file} canComment={canReview} onPick={line => {
            const key = inlineKey(line);
            const editor = inlineInputs.current.get(key);
            if (editor) editor.focus();
            else if (inline.length < 20) {
              focusInline.current = key;
              setInline(list => [...list, line]);
            }
          }} />
        </AnimatedDetails>)}</div>
        {detail.filesHaveMore && <button type="button" className="git-btn ghost" disabled={pageBusy || busy || loading}
          onClick={() => void paginate('files')}>{t('加载更多文件')}</button>}
      </section>
      <section className="pr-review-section">
        <div className="pr-section-head"><h3>{t('讨论与评审')}</h3>
          {detail.workerName && <button type="button" className="git-btn ghost"
            disabled={!selected.length || busy || loading || detail.state !== 'OPEN'} onClick={() => void runReviewAction('forward')}>{t('发送给 Worker')} · {detail.workerName}</button>}
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
          <button type="button" className="git-btn ghost" disabled={!canReview || !!reviewBody.trim()}
            onClick={() => void runReviewAction('draft')}>{t('生成审查草稿')}</button></div>
        {detail.draft?.partial && <p className="pr-muted">{t('审查草稿基于部分 Diff')}</p>}
        <div role="group" aria-label={t('评审结果')} className="pr-toolbar-actions">
          {(Object.entries(REVIEW_EVENTS) as [PrReviewEvent, string][]).map(([event, label]) => (
            <button type="button" key={event} className="git-btn ghost" aria-pressed={reviewEvent === event}
              disabled={!canReview || (ownPr && event !== 'COMMENT')} onClick={() => setReviewEvent(event)}>{t(label)}</button>
          ))}
        </div>
        <label className="pr-field"><span className="pr-field-label">{t('评审正文')}</span>
          <textarea ref={reviewInput} className="pr-input pr-textarea" rows={4} disabled={!canReview}
            value={reviewBody} maxLength={65_536} onChange={event => setReviewBody(event.target.value)} />
        </label>
        {inline.map((draft, index) => <div className="pr-inline-draft" key={inlineKey(draft)}>
          <label className="pr-field"><span className="pr-field-label">{draft.path}:{draft.line} · {draft.side}</span>
            <textarea className="pr-input pr-textarea" rows={2} maxLength={8192} value={draft.body} disabled={!canReview}
              ref={node => {
                const key = inlineKey(draft);
                if (node) inlineInputs.current.set(key, node);
                else inlineInputs.current.delete(key);
              }}
              onChange={event => setInline(list => list.map((item, i) => i === index ? { ...item, body: event.target.value } : item))} />
          </label>
          <button type="button" className="git-btn ghost tiny" disabled={!canReview}
            onClick={() => setInline(list => list.filter((_, i) => i !== index))}>{t('删除评论')}</button>
        </div>)}
        <button type="button" className="git-btn" disabled={!canReview || (reviewEvent !== 'APPROVE' && !reviewBody.trim()) ||
          inline.some(item => !item.body.trim())} onClick={() => setConfirm({
          version: versionFor(detail), event: reviewEvent, body: reviewBody.trim(), comments: inline.map(item => ({ ...item, body: item.body.trim() }))
        })}>{t('发布评审…')}</button>
      </section>}
    </div>}
    <AppConfirmDialog open={!!confirm} busy={busy} focusCancel title={t('发布 GitHub 评审')}
      detail={confirm ? t('以 {{login}} 向 {{repository}}#{{number}} 发布「{{decision}}」评审及 {{count}} 条行内评论。提交 {{sha}}。', {
        login, repository: confirm.version.repository, number: confirm.version.number, decision: t(REVIEW_EVENTS[confirm.event]),
        count: confirm.comments.length, sha: confirm.version.headSha.slice(0, 10)
      }) : ''}
      confirmLabel={t('发布')} onConfirm={() => void publish()} onCancel={() => setConfirm(null)} />
  </section>;
}
