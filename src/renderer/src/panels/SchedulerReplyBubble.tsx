import React, { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../../../shared/types';
import { schedulerReplyPreview, type SchedulerReplyPreview } from '../../../shared/boardReplyPreview';
import { ensureOrchestratorHistory, getOrchestratorSurface } from '../chatSurface/orchestratorSurface';
import { MOTION, usePresence } from '../components/motion';

export interface SchedulerReplySnapshot extends SchedulerReplyPreview {
  busy: boolean;
}

export function schedulerReplyUnreadIds(
  workspaceIds: readonly string[],
  snapshots: Record<string, SchedulerReplySnapshot>,
  isUnread: (workspaceId: string, messageId?: string) => boolean
): string[] {
  return workspaceIds.filter(id => {
    const reply = snapshots[id];
    return !!reply && !reply.busy && isUnread(id, reply.messageId);
  });
}

/** Load the tail of every live scheduler and subscribe once to the shared surface store. */
export function useSchedulerReplySnapshots(workspaceIds: readonly string[]): Record<string, SchedulerReplySnapshot> {
  const idsKey = workspaceIds.join('\u0001');
  const ids = useMemo(() => [...workspaceIds], [idsKey]);
  const surfaces = useMemo(() => ids.map(id => getOrchestratorSurface(id)), [idsKey]);
  const subscribe = useCallback((listener: () => void) => {
    const unsubs = surfaces.map(surface => surface.subscribe(listener));
    return () => unsubs.forEach(unsubscribe => unsubscribe());
  }, [surfaces]);
  const getSnapshot = useCallback(() => surfaces.map((surface, index) => {
    const snap = surface.getSnapshot();
    const preview = schedulerReplyPreview(snap.messages as readonly ChatMessage[]);
    return `${ids[index] ?? ''}:${snap.busy ? '1' : '0'}:${preview?.messageId ?? ''}:${preview?.text ?? ''}`;
  }).join('\u0002'), [ids, surfaces]);
  const revision = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    ids.forEach(id => ensureOrchestratorHistory(id));
  }, [idsKey]);
  return useMemo(() => {
    void revision;
    const out: Record<string, SchedulerReplySnapshot> = {};
    ids.forEach((id, index) => {
      const snap = surfaces[index]?.getSnapshot();
      const preview = snap ? schedulerReplyPreview(snap.messages as readonly ChatMessage[]) : null;
      if (preview) out[id] = { ...preview, busy: !!snap?.busy };
    });
    return out;
  }, [ids, surfaces, revision]);
}

export interface SchedulerReplyPreviewCardProps {
  open: boolean;
  text: string;
  anchor: DOMRect | null;
  onOpen: () => void;
  onKeep: () => void;
  onClose: () => void;
}

/** Hover-only preview. Opening the card is the read action; hovering alone is not. */
export function SchedulerReplyPreviewCard({
  open,
  text,
  anchor,
  onOpen,
  onKeep,
  onClose
}: SchedulerReplyPreviewCardProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(open, MOTION.exitMs);
  const preferredLeft = anchor ? Math.max(8, Math.round(anchor.right + 8)) : 8;
  const preferredBottom = anchor ? Math.max(8, Math.round(anchor.bottom)) : 8;
  const viewportWidth = Math.max(1, Math.min(
    window.innerWidth,
    document.documentElement.clientWidth || window.innerWidth,
    window.visualViewport?.width ?? window.innerWidth
  ));
  const viewportHeight = Math.max(1, Math.min(
    window.innerHeight,
    document.documentElement.clientHeight || window.innerHeight,
    window.visualViewport?.height ?? window.innerHeight
  ));
  const maxWidth = Math.max(180, Math.min(360, Math.floor(viewportWidth - preferredLeft - 16)));
  if (!presence.mounted || !anchor || typeof document === 'undefined') return null;
  const left = Math.max(8, Math.min(preferredLeft, viewportWidth - maxWidth - 8));
  const bottom = Math.max(0, viewportHeight - preferredBottom);
  const maxHeight = Math.max(1, Math.min(viewportHeight - 16, preferredBottom - 8));
  const style = {
    left: `${left}px`,
    bottom: `${bottom}px`,
    maxWidth: `${maxWidth}px`,
    maxHeight: `${maxHeight}px`
  } as React.CSSProperties;
  return createPortal(
    <div
      className="agent-scheduler-reply-preview-card mp-pop"
      {...presence.spread}
      style={style}
      role="dialog"
      aria-label={t('未读调度回复')}
      onMouseEnter={onKeep}
      onMouseLeave={onClose}
      onClick={onOpen}
    >
      <span className="agent-scheduler-reply-preview-text">{text}</span>
    </div>,
    document.body
  );
}
