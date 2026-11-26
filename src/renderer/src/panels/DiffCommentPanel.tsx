/**
 * T1.7：diff 行内评论清单 +「发送给 Worker」。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PrReviewComment } from '../../../shared/prReviewBrief';

export function DiffCommentPanel({
  comments,
  workerName,
  sending,
  onChangeBody,
  onRemove,
  onSend
}: {
  comments: PrReviewComment[];
  workerName: string | null;
  sending: boolean;
  onChangeBody: (id: string, body: string) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (comments.length === 0) return null;
  const pending = comments.filter((c) => c.status === 'draft' && c.body.trim());
  const canSend = pending.length > 0 && !!workerName && !sending;
  return (
    <div className="git-diff-comments" data-testid="diff-comment-panel">
      <div className="git-diff-comments-head">
        <span className="git-diff-comments-title">{t('{{n}} 条评论', { n: comments.length })}</span>
        <button
          type="button"
          className="git-btn tiny"
          disabled={!canSend}
          title={
            workerName
              ? undefined
              : t('当前仓库没有对应的 Worker 会话（需隔离 worktree 或 cwd 匹配）')
          }
          onClick={onSend}
        >
          {sending ? t('发送中…') : t('发送给 Worker')}
        </button>
      </div>
      {!workerName ? (
        <div className="git-diff-comments-hint">{t('没有对应 Worker 会话')}</div>
      ) : null}
      <ul className="git-diff-comments-list">
        {comments.map((c) => (
          <li key={c.id} className={`git-diff-comment is-${c.status}`}>
            <div className="git-diff-comment-meta">
              <code>
                {c.file}:{c.line}
              </code>
              {c.status === 'sent' ? (
                <span className="git-diff-comment-status">{t('已发送')}</span>
              ) : c.status === 'injected' ? (
                <span className="git-diff-comment-status">{t('已注入，等 diff 刷新')}</span>
              ) : null}
              <button
                type="button"
                className="git-btn ghost tiny"
                aria-label={t('删除评论')}
                onClick={() => onRemove(c.id)}
              >
                {t('关闭')}
              </button>
            </div>
            {c.original.trim() ? (
              <pre className="git-diff-comment-orig" title={t('原文')}>
                {c.original}
              </pre>
            ) : null}
            <textarea
              className="git-diff-comment-body"
              rows={2}
              placeholder={t('写评论…')}
              value={c.body}
              disabled={c.status !== 'draft'}
              onChange={(e) => onChangeBody(c.id, e.target.value)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
