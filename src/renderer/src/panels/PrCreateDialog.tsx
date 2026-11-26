import { ErrorTip } from '../components/ErrorTip';
import { useGitWorkspaceScope } from './gitpanel/GitWorkspaceScope';
/**
 * 创建 PR 前显示冻结的推送仓和目标仓。Git 推送及 API 创建由主进程连续验证。
 * 进出场走 usePresence + mp-panel/mp-scrim（动画规约）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresence } from '../components/motion';
import type { PrRef, PrRepository } from '../../../shared/githubPr';

export function PrCreateDialog({
  open,
  repoPath,
  branch,
  repository,
  onCreated,
  onClose
}: {
  open: boolean;
  repoPath: string;
  branch: string;
  repository: PrRepository;
  onCreated: (pr: PrRef) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const workspace = useGitWorkspaceScope();
  const presence = usePresence(open);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string>();
  const prevOpenRef = useRef(false);

  // 每次打开重置草稿（沿用上次输入没有意义：分支可能已换）
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setTitle('');
      setBody('');
      setBase('');
      setDraft(false);
      setError(null);
      setInstallUrl(undefined);
      setBusy(false);
    }
    prevOpenRef.current = open;
  }, [open]);

  useOverlayDismiss(presence.mounted && presence.stage !== 'out' && !busy, onClose);

  const submit = async (): Promise<void> => {
    if (busy) return;
    if (!title.trim()) {
      setError(t('标题不能为空'));
      return;
    }
    setBusy(true);
    setError(null);
    setInstallUrl(undefined);
    try {
      const res = await window.api.pr.create({ ...workspace, repoPath }, {
        branch,
        title: title.trim(),
        body,
        base: base.trim() || undefined,
        draft,
        repository: repository.name,
        pushRepository: repository.pushRepository ?? ''
      });
      if (res.ok) {
        onCreated(res.value);
        return;
      }
      setError(res.message);
      setInstallUrl(res.installUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!presence.mounted) return null;

  return createPortal(
    <div
      className="modal-mask app-confirm-mask mp-scrim"
      data-mp-stage={presence.stage}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal confirm-modal pr-create-modal mp-panel"
        data-mp-stage={presence.stage}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-create-title"
      >
        <div className="modal-head">
          <h3 id="pr-create-title">{t('开 PR')}</h3>
          <button
            type="button"
            className="modal-close"
            aria-label={t('关闭')}
            onClick={() => {
              if (!busy) onClose();
            }}
          >
            ×
          </button>
        </div>
        <div className="pr-create-hint">{t('从 {{head}} 推送分支并向 {{base}} 创建 PR', {
          head: `${repository.pushRepository}:${branch}`, base: `${repository.name}:${base.trim() || repository.defaultBranch}`
        })}</div>
        <div className="pr-create-body">
          <label className="pr-field">
            <span className="pr-field-label">{t('PR 标题')}</span>
            <input
              className="pr-input"
              type="text"
              value={title}
              maxLength={256}
              autoFocus
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
          <label className="pr-field">
            <span className="pr-field-label">{t('描述（可选）')}</span>
            <textarea
              className="pr-input pr-textarea"
              value={body}
              maxLength={65_536}
              rows={5}
              disabled={busy}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <label className="pr-field">
            <span className="pr-field-label">{t('目标分支')}</span>
            <input
              className="pr-input"
              type="text"
              value={base}
              disabled={busy}
              placeholder={repository.defaultBranch}
              onChange={(e) => setBase(e.target.value)}
            />
          </label>
          <label className="pr-field pr-field-inline">
            <input
              type="checkbox"
              checked={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.checked)}
            />
            <span>{t('创建为草稿')}</span>
          </label>
        </div>
        {error ? (
          <ErrorTip message={error} />
        ) : null}
        {installUrl && <button type="button" className="btn" onClick={() => void window.api.shell.openExternal(installUrl)}>{t('在 GitHub 授权仓库')}</button>}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('取消')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? t('创建中…') : t('创建 PR')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
