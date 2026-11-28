import { ErrorTip } from '../../components/ErrorTip';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitRepoStatus } from '../../../../shared/types';
import { AppConfirmDialog } from '../../components/AppConfirmDialog';
import { BrandLoader } from '../../components/BrandLoader';
import { IconDownload, IconFetch, IconInfo, IconUpload, IconWarn } from '../../components/icons';
import type { GitRemoteApi } from './useGitRemote';
import type { RemoteKind, RemoteOperation } from './gitRemoteState';

export function GitRemoteFeedback({ remote, repoPath, status, active, busy = false }: {
  remote: GitRemoteApi; repoPath: string; status: GitRepoStatus | null; active: boolean; busy?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const details = active && detailKey === remote.key;
  const { snapshot } = remote;
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), details && snapshot.running ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [active, details, snapshot.running]);
  useEffect(() => setDetailKey(null), [active, remote.key]);
  const closeDetails = () => {
    setDetailKey(null);
    if (active) detailsButton.current?.focus({ preventScroll: true });
  };
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
  const operation = op ? `${label(op)} · ${op.branch}` : '';
  const trackedStatus = status?.tracking ? status : null;
  const unavailable = status ? t('未设置上游') : t('同步状态未知');
  const counts = trackedStatus ? t('待推 {{ahead}} · 待拉 {{behind}}', { ahead: trackedStatus.ahead, behind: trackedStatus.behind }) : unavailable;
  const description = [counts, freshness, operation].filter(Boolean).join(' · ');
  const tone = snapshot.notice?.result?.ok === false ? 'danger' : check?.error ? 'warning'
    : snapshot.notice?.result?.ok ? 'success' : undefined;
  const DetailIcon = tone === 'warning' || tone === 'danger' ? IconWarn : IconInfo;
  const buttons: { kind: RemoteKind; name: string; hint: string; description: string; count?: number; Icon: typeof IconFetch }[] = [
    { kind: 'fetch', name: 'Fetch', hint: t('检查远端（Fetch）'), description: freshness, Icon: IconFetch },
    { kind: 'pull', name: 'Pull', hint: t('拉取（Pull）'), description: trackedStatus ? t('待拉 {{n}}', { n: trackedStatus.behind }) : unavailable,
      count: trackedStatus?.behind, Icon: IconDownload },
    { kind: 'push', name: 'Push', hint: t('推送（Push）'), description: trackedStatus ? t('待推 {{n}}', { n: trackedStatus.ahead }) : unavailable,
      count: trackedStatus?.ahead, Icon: IconUpload }
  ];
  const elapsed = snapshot.running ? t('已用时 {{n}} 秒', { n: Math.max(0, Math.floor((now - snapshot.running.startedAt) / 1_000)) }) : '';
  const history = snapshot.notice && !snapshot.history.includes(snapshot.notice) ? [snapshot.notice, ...snapshot.history] : snapshot.history;
  const detail = details ? [repoPath, [status?.tracking, counts, freshness].filter(Boolean).join(' · '),
    check?.checkedAt ? t('上次成功检查：{{time}}', { time: new Date(check.checkedAt).toLocaleString() }) : '',
    check?.error ?? '', elapsed ? `${operation} · ${elapsed}` : '', ...history.map(item => [
      `${new Date(item.finishedAt!).toLocaleTimeString()} · ${item.branch} · ${label(item)}`,
      item.result?.remote?.destination ?? '', ...(item.result?.remote?.targets ?? []), item.result?.message ?? ''
    ].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n') : undefined;
  return <>
    <div className="git-remote-controls" role="group" aria-label={t('Git 同步状态')}>
      {buttons.map(({ kind, name, hint, description, count, Icon }) => {
        const running = snapshot.running?.kind === kind;
        return <button key={kind} type="button" className="right-icon git-remote-button" aria-label={name}
          aria-description={description} title={`${hint}\n${description}`}
          aria-busy={running || undefined} disabled={busy || remote.pending} onClick={() => void remote.run(kind)}>
          {running ? <BrandLoader size={16} /> : <Icon size={14} />}
          {count !== undefined && <span className="git-remote-count" data-zero={count === 0 || undefined} aria-hidden="true">{count}</span>}
        </button>;
      })}
      <button ref={detailsButton} type="button" className="right-icon git-remote-details" data-tone={tone}
        aria-label={t('Git 操作详情')} aria-description={description} aria-haspopup="dialog"
        title={`${t('查看最近操作与检查详情')}\n${description}`} onClick={() => setDetailKey(remote.key)}>
        <DetailIcon size={14} />
      </button>
      <span className="git-remote-announcement" role="status">{active ? operation : ''}</span>
    </div>
    <ErrorTip active={active} message={snapshot.notice?.result?.ok === false ? snapshot.notice.result.message ?? label(snapshot.notice) : null} />
    <AppConfirmDialog key={remote.key} open={details} title={t('Git 操作详情')} detail={detail} confirmLabel={t('关闭')}
      focusCancel alternate={snapshot.notice && !snapshot.running ? { label: t('关闭操作回执'), onClick: () => { remote.dismiss(); closeDetails(); } } : undefined}
      onConfirm={closeDetails} onCancel={closeDetails} />
  </>;
}
