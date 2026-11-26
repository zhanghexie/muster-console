import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SessionMeta, WorkspaceInfo } from '../../../shared/types';
import { formatRelativeTime } from '../../../shared/relativeTime';
import { sessionDisplayStatus } from '../../../shared/boardStatus';
import { usePresenceValue, MOTION } from './motion';
import { SessionStatusIcon } from './StatusIcon';
import { StatusBadge } from './StatusBadge';
import { IconCopy } from './icons';
import { HarnessIcon } from './HarnessIcon';
import { sessionHarness } from '../sessionHarness';
import { useDismissOnPagePeek } from '../hooks/useDismissOnPagePeek';

export type SessionDetailsTarget = { id: string; anchor: HTMLElement };

export function SessionDetailsCard({ target, session, workspace, runtime, stateLabel, showTime = true, onClose, onSurfaceEnter, onSurfaceLeave }: {
  target: SessionDetailsTarget | null;
  session?: SessionMeta;
  workspace?: WorkspaceInfo;
  runtime: string;
  stateLabel: string;
  showTime?: boolean;
  onClose: () => void;
  onSurfaceEnter?: () => void;
  onSurfaceLeave?: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const details = useMemo(() => target && session ? { target, session, workspace, runtime, stateLabel } : null,
    [target, session, workspace, runtime, stateLabel]);
  const { presence, value } = usePresenceValue(details, MOTION.menuMs);
  const cardRef = useRef<HTMLDivElement>(null);
  // 定位成功前不渲染：悬停捕获的 anchor 若已被 React 重建，回查失败时不能按 (0,0) 兜底闪现
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [copyResult, setCopyResult] = useState<{ sessionId: string; message: string } | null>(null);
  // A row can be rebuilt during the hover delay. Use the same live row for
  // placement and page ownership.
  const targetAnchor = value?.target.anchor;
  const anchor = targetAnchor?.isConnected ? targetAnchor : value
    ? document.querySelector<HTMLElement>(`[data-session-row="${CSS.escape(value.target.id)}"]`)
    : null;
  useDismissOnPagePeek(!!details, anchor, onClose);
  useLayoutEffect(() => {
    if (!value || !cardRef.current) return;
    // presence 阶段进 deps：target 后到时首次跑 cardRef 尚未挂载，卡片真挂载后必须重定位，
    // 否则永远停在定位前状态。
    // 另：悬停捕获的 anchor 可能在 400ms 悬停延迟内被列表重挂重建（detached 节点 rect 全 0，
    // 会把卡片钉到视口左上角）——按会话 id 回查当前行；行已不存在则关闭。
    if (!anchor) { onClose(); return; }
    const rect = anchor.getBoundingClientRect();
    const card = cardRef.current.getBoundingClientRect();
    const right = rect.right + 8;
    const left = right + card.width <= window.innerWidth - 8 ? right : rect.left - card.width - 8;
    setPosition({ left: Math.max(8, Math.min(left, window.innerWidth - card.width - 8)),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - card.height - 8)) });
  }, [value, anchor, copyResult, onClose, presence.mounted, presence.stage]);
  useEffect(() => setCopyResult(null), [target?.id]);
  useEffect(() => {
    if (!target) return;
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    const outside = (event: Event): void => {
      if (!(event.target instanceof Node) || !cardRef.current?.contains(event.target)) onClose();
    };
    // 只有滚动了 anchor 所在容器（会话列表/速览）才关：窗口级 scroll 捕获会收到所有面板的
    // 滚动——会话流式更新时转写自动贴底也触发，不能当成「外部滚动」把卡片刷掉。
    const onScroll = (event: Event): void => {
      if (event.target instanceof Element && !event.target.contains(target.anchor)) return;
      onClose();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    window.addEventListener('mousedown', outside, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('mousedown', outside, true);
    };
  }, [target, onClose]);
  if (!presence.mounted || !value) return null;
  const s = value.session;
  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyResult({ sessionId: s.id, message: t('已复制') });
    } catch {
      setCopyResult({ sessionId: s.id, message: t('复制失败') });
    }
  };
  const time = formatRelativeTime(s.lastUsedAt ?? s.createdAt);
  const harness = sessionHarness(s, value.runtime);
  const fields = [
    { key: 'workspace', label: t('工作区'), text: value.workspace?.name },
    { key: 'runtime', label: t('运行时'), text: harness?.name || value.runtime || s.runtime },
    { key: 'model', label: t('模型'), text: s.modelOverride?.modelId },
    { key: 'branch', label: t('分支'), text: s.worktreeBranch },
    { key: 'directory', label: t('目录'), text: s.worktreePath || value.workspace?.path }
  ].filter(field => !!field.text);
  return createPortal(<div ref={cardRef} id={`session-details-${s.id}`} className="session-details-card mp-pop" role="dialog"
    aria-label={t('会话详情')} aria-modal="false" {...presence.spread}
    aria-hidden={!details || undefined} {...(!details ? { inert: '' } : {})}
    style={position ?? { visibility: 'hidden' }}
    data-session-peek-owner={anchor?.closest('.sessions-float') ? 'true' : undefined}
    onMouseEnter={onSurfaceEnter} onMouseLeave={onSurfaceLeave} onFocus={onSurfaceEnter}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onSurfaceLeave?.(); }}>
    <header className="session-details-header">
      <strong>{s.name}</strong>
      <div className="session-details-state"><SessionStatusIcon status={sessionDisplayStatus(s)} size={14} />
        <StatusBadge label={value.stateLabel}/>{s.pinned && <span className="session-details-tag">{t('已置顶')}</span>}
      </div>
      {showTime && <span className="session-details-time">{time}</span>}
    </header>
    {(s.liveStatus?.label || s.liveStatus?.summary) && <div className="session-details-summary">
      {s.liveStatus.label && <div>{s.liveStatus.label}</div>}
      {s.liveStatus.summary && s.liveStatus.summary !== s.liveStatus.label && <p>{s.liveStatus.summary}</p>}
    </div>}
    <dl className="session-details-fields">{fields.map(field => <React.Fragment key={field.key}>
      <dt>{field.label}</dt><dd className={field.key === 'runtime' && harness ? 'session-details-runtime' : undefined}>
        {field.key === 'runtime' && harness ? <HarnessIcon className="session-details-harness-icon" harnessId={harness.id} size={14} /> : null}
        <span>{field.text}</span>
      </dd>
    </React.Fragment>)}</dl>
    <footer className="session-details-ids"><span>{t('会话标识')}</span>
      <span className="session-details-id-value"><code>{s.id}</code>
        <button type="button" className="session-details-copy" aria-label={t('复制会话标识')} onClick={() => void copy(s.id)}><IconCopy size={13}/></button>
      </span>
      {s.externalSessionId && <><span>{t('运行时会话')}</span>
        <span className="session-details-id-value"><code>{s.externalSessionId}</code>
          <button type="button" className="session-details-copy" aria-label={t('复制运行时会话标识')} onClick={() => void copy(s.externalSessionId!)}><IconCopy size={13}/></button>
        </span></>}
    </footer>
    {copyResult?.sessionId === s.id && <div className="session-details-copy-result" role="status">{copyResult.message}</div>}
  </div>, document.body);
}
