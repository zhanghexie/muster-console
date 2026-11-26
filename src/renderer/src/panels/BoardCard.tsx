import React from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveStatusKind } from '../../../shared/types';
import type { BoardStatus } from '../../../shared/boardStatus';
import { BOARD_STATUS_PRESENTATION } from './boardPresentation';
import { IconBranch } from '../components/icons';
import { SessionRowContent } from '../components/SessionRowContent';
import { SessionRowTools } from '../components/SessionRowTools';
import { useBoardClock } from './boardClock';
import type { WorkerRouteState } from '../../../shared/workerRouting';
import { BoardWorkerRouting } from './BoardWorkerRouting';

function UpdatedTools({ ts, archived, onArchive, onDelete }: { ts: number; archived?: boolean; onArchive?: () => void; onDelete?: () => void }): React.JSX.Element {
  const now = useBoardClock();
  return <SessionRowTools ts={ts} now={now} archived={archived} onArchive={onArchive} onDelete={onDelete} />;
}

function capsuleClass(kind?: LiveStatusKind): string {
  switch (kind) {
    case 'active':
      return 'session-capsule active';
    case 'waiting':
      return 'session-capsule waiting';
    case 'done':
      return 'session-capsule done';
    case 'error':
      return 'session-capsule error';
    default:
      return 'session-capsule info';
  }
}

/** 卡片入参全部是原始值：broadcast 全量刷会话对象时 memo 才真正挡得住 */
export interface BoardCardProps {
  sessionId: string;
  /** 会话元数据中保存的最近助手正文。 */
  replyPreview?: string;
  name: string;
  runtimeLabel: string;
  harnessId?: string;
  status: BoardStatus;
  liveLabel?: string;
  liveKind?: LiveStatusKind;
  liveSummary?: string;
  branch?: string;
  branchTitle?: string;
  /** 遗留 worktree 徽标（P3.5 归档清理） */
  orphanWorktree?: boolean;
  archived?: boolean;
  onArchive?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  worktreeStatus?: string;
  onWorktree?: (sessionId: string) => void;
  relTimeTs: number;
  isActive: boolean;
  onSelect: (sessionId: string) => void;
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void;
  /**
   * 需要你列的已读态：true=未读（黄描边+未读点+图标呼吸），false=已读（弱化、停呼吸）。
   * 其它列不传。已读只改卡片观感，不改列归属。
   */
  needsUnread?: boolean;
  /** 调度编排会话：状态图标右上角小蓝点 */
  orchestrated?: boolean;
  /** R-14 维度门红灯徽标（如「维度门未过：多语言」）；仅 needs_you 被门挡下时传 */
  gateRedLabel?: string;
  /** 红灯详情多行文本（徽标 title / 无障碍描述） */
  gateRedDetail?: string;
  /** 内联重命名（与左栏同款交互） */
  renaming?: boolean;
  renameValue?: string;
  renameInputRef?: React.RefObject<HTMLInputElement>;
  onRenameChange?: (v: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
  /** 待处理摘要。 */
  reviewSessionId?: string;
  reviewItem?: string;
  reviewSummary?: string;
  reviewRisks?: string;
  reviewDeferred?: boolean;
  reviewable?: boolean;
  workerRouting?: WorkerRouteState;
}

function BoardCardBase(props: BoardCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { replyPreview } = props;
  const {
    sessionId,
    name,
    runtimeLabel,
    harnessId,
    status,
    liveLabel,
    liveKind,
    liveSummary,
    branch,
    branchTitle,
    orphanWorktree,
    archived,
    onArchive,
    relTimeTs,
    isActive,
    onSelect,
    onContextMenu,
    needsUnread,
    orchestrated,
    gateRedLabel,
    gateRedDetail,
    renaming,
    renameValue,
    renameInputRef,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    reviewSessionId,
    reviewItem,
    reviewSummary,
    reviewRisks,
    reviewDeferred,
    reviewable = false
  } = props;
  const visual = BOARD_STATUS_PRESENTATION[status];
  const statusLabel = reviewable ? t('待验收') : visual.label;
  const showStatus = reviewable || (status !== 'idle' && status !== 'done');
  const showLiveLabel = liveLabel && liveLabel !== statusLabel && liveLabel !== t('空闲') && liveLabel !== t('已完成') && !(reviewable && liveLabel === t('等验收'));
  const rowCapsule = showLiveLabel ? liveLabel : showStatus ? statusLabel : '';
  const needsHint = needsUnread === true ? t('未读') : needsUnread === false ? t('已读') : '';
  const tooltipDetail = [showStatus ? statusLabel : '', needsHint, liveSummary].filter(Boolean).join(' · ');
  const needsClass =
    needsUnread === true ? ' is-needs-unread' : needsUnread === false ? ' is-needs-read' : '';
  return (
    <div
      className={`board-card ${visual.toneClass}${isActive ? ' active' : ''}${needsClass}`}
      data-needs={needsUnread === true ? 'unread' : needsUnread === false ? 'read' : undefined}
      onClick={() => onSelect(sessionId)}
      onContextMenu={(e) => onContextMenu(e, sessionId)}
      title={`${name} · ${runtimeLabel}${tooltipDetail ? `\n${tooltipDetail}` : ''}${gateRedLabel ? `\n${gateRedDetail ?? gateRedLabel}` : ''}`}
    >
      <div className="board-card-head">
        <SessionRowContent name={name} status={status} statusLabel={statusLabel} capsule={rowCapsule || ''}
          capsuleClassName={capsuleClass(liveKind)} harness={harnessId ? { id: harnessId, name: runtimeLabel } : undefined}
          dimState={status === 'idle' || status === 'no_signal' || status === 'exited' || status === 'scheduled'}
          grayed={status === 'exited'} editing={renaming}
          stateAdornment={orchestrated ? <span className="board-card-orch-dot" title={t('由调度编排')} aria-label={t('由调度编排')} /> : null}
          trailing={<>
        {props.worktreeStatus && <button type="button" className="session-worktree-status" onClick={event => {
          event.stopPropagation(); props.onWorktree?.(sessionId);
        }}>{props.worktreeStatus}</button>}
        <UpdatedTools ts={relTimeTs} archived={archived} onArchive={onArchive ? () => onArchive(sessionId) : undefined}
          onDelete={props.onDelete ? () => props.onDelete?.(sessionId) : undefined} />
        {needsUnread ? (
          <span className="board-card-unread-pip" aria-label={t('未读')} />
        ) : null}
          </>}>
        {renaming && onRenameChange && onRenameCommit && onRenameCancel ? (
          <input
            ref={renameInputRef}
            className="session-rename-input"
            value={renameValue ?? ''}
            autoFocus
            onChange={(e) => onRenameChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => onRenameCommit()}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                onRenameCommit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onRenameCancel();
              }
            }}
          />
        ) : (
          <span className="session-name"><button type="button" className="board-card-name session-name-text" onClick={(e) => { e.stopPropagation(); onSelect(sessionId); }}>{name}</button>
          {branch ? <span className="session-wt-mark" title={t('worktree 隔离 · {{branch}}', { branch: branchTitle ?? branch })} aria-label={t('worktree 隔离')}><IconBranch size={11} /></span> : null}
          {orphanWorktree ? <span className="board-card-orphan">{t('遗留 worktree')}</span> : null}
</span>
        )}
        </SessionRowContent>
      </div>
      {props.workerRouting ? <BoardWorkerRouting routing={props.workerRouting} /> : null}
      {replyPreview ? <div className="board-card-output" title={replyPreview}>{replyPreview}</div> : null}
      {gateRedLabel ? <div className="board-card-summary board-card-gate-summary">
          <span
            className="session-capsule error board-card-capsule board-card-gate-red"
            title={gateRedDetail ?? gateRedLabel}
            aria-label={gateRedLabel}
          >
            {gateRedLabel}
          </span>
      </div> : null}
      {reviewSessionId ? (
        <div className={`board-card-review${reviewDeferred ? ' is-deferred' : ''}`}>
          {reviewItem && reviewItem !== name ? (
            <div className="board-card-review-row">
              {t('条目')} {reviewItem}
            </div>
          ) : null}
          {reviewSummary && reviewSummary !== liveLabel ? (
            <div className="board-card-review-row" title={reviewSummary}>
              {t('说明')} {reviewSummary}
            </div>
          ) : null}
          {reviewRisks ? (
            <div className="board-card-review-row" title={reviewRisks}>
              {t('风险点')} {reviewRisks}
            </div>
          ) : null}
          {reviewDeferred ? (
            <div className="board-card-review-row">{t('已搁置')}</div>
          ) : null}
        </div>
      ) : null}

    </div>
  );
}


export const BoardCard = React.memo(BoardCardBase);
