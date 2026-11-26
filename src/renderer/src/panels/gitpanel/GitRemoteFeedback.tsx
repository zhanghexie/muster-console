import { ErrorTip } from '../../components/ErrorTip';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitRepoStatus } from '../../../../shared/types';
import { AppConfirmDialog } from '../../components/AppConfirmDialog';
import { BrandLoading } from '../../components/BrandLoader';
import { IconInfo } from '../../components/icons';
import type { GitRemoteApi } from './useGitRemote';
import type { RemoteOperation } from './gitRemoteState';

export function GitRemoteFeedback({ remote, repoPath, status, active }: {
  remote: GitRemoteApi; repoPath: string; status: GitRepoStatus | null; active: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const [details, setDetails] = useState(false);
  const { snapshot } = remote;
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), snapshot.running ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [active, snapshot.running]);
  useEffect(() => setDetails(false), [repoPath]);
  const label = (op: RemoteOperation): string => {
    if (!op.result) return op.kind === 'push' ? t('正在推送') : op.kind === 'pull' ? t('正在拉取') : t('正在检查远端');
    if (!op.result.ok) return op.kind === 'push' ? t('推送失败') : op.kind === 'pull' ? t('拉取失败') : t('远端检查失败');
    return op.kind === 'push' ? op.result.remote?.unchanged ? t('无需推送') : t('推送成功') : op.kind === 'pull' ? t('拉取成功') : t('远端检查完成');
  };
  const check = remote.check;
  const age = check?.checkedAt ? Math.max(0, Math.floor((now - check.checkedAt) / 60_000)) : null;
  const freshness = check?.error ? t('远端检查失败') : age === null ? t('尚未检查远端')
    : age === 0 ? t('刚刚检查') : t('{{n}} 分钟前检查', { n: age });
  const op = snapshot.running ?? snapshot.notice;
  const detail = [repoPath, check?.checkedAt ? t('上次成功检查：{{time}}', { time: new Date(check.checkedAt).toLocaleString() }) : '',
    check?.error ?? '', ...snapshot.history.map(item => [
      `${new Date(item.finishedAt!).toLocaleTimeString()} · ${item.branch} · ${label(item)}`,
      item.result?.remote?.destination ?? '', ...(item.result?.remote?.targets ?? []), item.result?.message ?? ''
    ].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
  return <>
    <div className="git-sync-strip" role="group" aria-label={t('Git 同步状态')}>
      <div className="git-sync-summary">
        <span className="git-sync-counts" title={status?.tracking ?? undefined}>
          {!status ? t('同步状态未知') : !status.tracking ? t('未设置上游') : t('待推 {{ahead}} · 待拉 {{behind}}', { ahead: status.ahead, behind: status.behind })}
        </span>
        <span className={`git-sync-freshness${check?.error ? ' is-warning' : ''}`} title={check?.error ?? (check?.checkedAt ? new Date(check.checkedAt).toLocaleString() : undefined)}>{freshness}</span>
      </div>
      <span className="git-sync-operation" data-empty={!op} role="status" aria-live="polite" title={op ? `${repoPath}\n${op.branch}\n${op.result?.message ?? ''}` : undefined}>
        {snapshot.running ? <BrandLoading size={18}/> : null}
        <span>{op ? `${label(op)} · ${op.branch}${snapshot.running ? ` · ${t('已用时 {{n}} 秒', { n: Math.max(0, Math.floor((now - op.startedAt) / 1_000)) })}` : ` · ${new Date(op.finishedAt!).toLocaleTimeString()}`}` : ''}</span>
      </span>
      <div className="git-sync-actions">
        <button type="button" className="git-btn ghost tiny" onClick={() => setDetails(true)} title={t('查看最近操作与检查详情')}>
          <IconInfo size={13} />{t('详情')}
        </button>
        {snapshot.notice && !snapshot.running ? <button type="button" className="git-btn ghost tiny" aria-label={t('关闭操作回执')} onClick={remote.dismiss}>×</button> : null}
      </div>
    </div>
    <ErrorTip active={active} message={snapshot.notice?.result?.ok === false ? snapshot.notice.result.message ?? label(snapshot.notice) : null} />
    <AppConfirmDialog open={details} title={t('Git 操作详情')} detail={detail} confirmLabel={t('关闭')} onConfirm={() => setDetails(false)} onCancel={() => setDetails(false)}/>
  </>;
}
