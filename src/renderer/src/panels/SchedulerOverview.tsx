import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { WorkspaceInfo } from '../../../shared/types';
import { getOrchestratorSurface } from '../chatSurface/orchestratorSurface';
import { useSessionNotes, type SessionNotesHost } from '../chatSurface/useSessionNotes';
import { ChatResetDialog, type ChatResetTarget } from '../components/ChatResetDialog';
import { MailEnvelopeViewport } from '../components/MailEnvelopeViewport';
import { IconLayout, IconRefresh, IconShrink } from '../components/icons';
import { prefersReducedMotion, type Presence } from '../components/motion';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { useUiActionsStore } from '../store';
import { SchedulerConversation, SchedulerIdentity, schedulerMessageRole, useSchedulerActionStyle } from './SchedulerConversation';
import { SchedulerOverviewResize, type SchedulerOverviewSize } from './SchedulerOverviewResize';
import { SchedulerOverviewFilter, SchedulerStatusPicker } from './SchedulerOverviewStatus';
import { assignedOverviewStatus, UNMARKED_STATUS, useSchedulerOverviewStatuses, type SchedulerOverviewStatus } from './schedulerOverviewStatuses';
import type { SchedulerReplySnapshot } from './SchedulerReplyBubble';
import { panelOriginY } from './agentFloatGeom';

const MAX_STAGGER_STEPS = 3;
const PANEL_SIZES_KEY = 'muster.schedulerOverviewSizes.v1';

type SlotBounds = { slot: HTMLElement; bounds: DOMRect };

function animateArrangement(track: HTMLElement, before: SlotBounds[]): () => void {
  track.dataset.arranging = 'prepare';
  const scroller = track.parentElement;
  track.toggleAttribute('data-arrange-fits', !!scroller && scroller.scrollWidth <= scroller.clientWidth);
  const moves = before.flatMap(({ slot, bounds }) => {
    if (slot.parentElement !== track) return [];
    const target = slot.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !target.width || !target.height) return [];
    const x = bounds.left - target.left;
    const y = bounds.top - target.top;
    const scaleX = bounds.width / target.width;
    const scaleY = bounds.height / target.height;
    if (x === 0 && y === 0 && scaleX === 1 && scaleY === 1) return [];
    return [{ slot, transform: `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})` }];
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    delete track.dataset.arranging;
    delete track.dataset.arrangeFits;
  };
  if (!moves.length) {
    finish();
    return finish;
  }

  // 布局已经到终态。先将各列绘制回原位置和尺寸，再一次性开始各列的过渡。
  for (const { slot, transform } of moves) slot.style.setProperty('--scheduler-arrange-transform', transform);
  void track.offsetWidth;
  track.dataset.arranging = 'play';
  for (const { slot } of moves) slot.style.removeProperty('--scheduler-arrange-transform');
  const transitions = moves.flatMap(({ slot }) => slot.getAnimations?.() ?? []);
  if (transitions.length) void Promise.allSettled(transitions.map(transition => transition.finished)).then(finish);
  else finish();
  return finish;
}

function storedPanelSizes(): Map<string, SchedulerOverviewSize> {
  const sizes = new Map<string, SchedulerOverviewSize>();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PANEL_SIZES_KEY) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return sizes;
    for (const [id, entry] of Object.entries(stored as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const size: SchedulerOverviewSize = {};
      for (const axis of ['w', 'h'] as const) {
        const value = (entry as Record<string, unknown>)[axis];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) size[axis] = value;
      }
      if (size.w !== undefined || size.h !== undefined) sizes.set(id, size);
    }
  } catch {
    // 缺失或损坏的偏好使用默认尺寸。
  }
  return sizes;
}

type ConversationNotes = {
  workspaceId: string;
  host: SessionNotesHost;
  viewRef: React.RefObject<HTMLDivElement>;
};

const SchedulerOverviewCard = React.memo(function SchedulerOverviewCard({
  workspace, stage, active, visible, sharedNotes, size, status, statusKinds, onChooseStatus, onResize, onReset
}: {
  workspace: WorkspaceInfo;
  stage: Presence['stage'];
  active: boolean;
  visible: boolean;
  sharedNotes?: ConversationNotes;
  size?: SchedulerOverviewSize;
  status: SchedulerOverviewStatus;
  statusKinds: readonly SchedulerOverviewStatus[];
  onChooseStatus: (workspaceId: string, statusId: string) => void;
  onResize: (workspaceId: string, size: SchedulerOverviewSize) => void;
  onReset: (target: ChatResetTarget) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { flashTip, requestOpenWorkspaceFile } = useUiActionsStore();
  const surface = getOrchestratorSurface(workspace.id);
  const busy = useSyncExternalStore(surface.subscribe, () => surface.getSnapshot().busy);
  const actionStyle = useSchedulerActionStyle(workspace.id);
  const viewRef = useRef<HTMLDivElement>(null);
  const getMessageRole = useCallback((messageId: string) => schedulerMessageRole(surface, messageId), [surface]);
  const notesHost = useSessionNotes({
    sessionId: sharedNotes ? '' : workspace.id,
    draftKey: surface.caps.draftKey,
    getMessageRole,
    viewRef,
    flashTip,
    requestOpenWorkspaceFile
  });
  return (
    <section className="agent-float-panel scheduler-overview-card mp-panel" aria-label={workspace.name}
      data-mp-stage={stage} style={actionStyle}>
      <SchedulerOverviewResize workspaceId={workspace.id} name={workspace.name} active={active} size={size} onResize={onResize} />
      <MailEnvelopeViewport mailboxId={`orchestrator:${workspace.id}`} enabled={active && visible} />
      <div className="agent-panel-body">
        <header className="agent-header">
          <SchedulerIdentity workspace={workspace} />
          <div className="scheduler-overview-card-actions">
            <SchedulerStatusPicker active={active} status={status} kinds={statusKinds}
              onChoose={statusId => onChooseStatus(workspace.id, statusId)} />
            <button type="button" className="agent-chat-clear-btn agent-panel-icon-btn" disabled={!active || busy}
              aria-label={t('重置')} title={t('清空聊天并开始新 Pi 会话')}
              onClick={() => onReset({ workspaceId: workspace.id, purpose: 'dispatch', surface })}>
              <IconRefresh size={16} />
            </button>
          </div>
        </header>
        <div className="agent-panel-surfaces">
          <div ref={sharedNotes?.viewRef ?? viewRef} data-agent-purpose="dispatch"
            className="agent-panel-purpose-view agent-panel-dispatch-view">
            <SchedulerConversation surface={surface} workspace={workspace}
              live={active} interactionActive={active} disabled={!active}
              notesHost={sharedNotes?.host ?? notesHost} findEnabled={active} />
          </div>
        </div>
      </div>
    </section>
  );
});

export function SchedulerOverview({
  id, open, presence, workspaces, selectedWorkspaceId, singleNotes, replies, markRead, getWorkspaceAnchor, onClose
}: {
  id: string;
  open: boolean;
  presence: Presence;
  workspaces: readonly WorkspaceInfo[];
  selectedWorkspaceId: string | null;
  singleNotes: ConversationNotes | null;
  replies: Record<string, SchedulerReplySnapshot>;
  markRead: (workspaceId: string, messageId?: string) => void;
  getWorkspaceAnchor: (workspaceId: string) => DOMRect | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { flashTip } = useUiActionsStore();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const arrangeFrom = useRef<SlotBounds[] | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const revealedWorkspaceId = useRef<string | null>(null);
  const pressedBlank = useRef<Element | null>(null);
  const [staggerEntry, setStaggerEntry] = useState(true);
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(() => new Set());
  const [resetTarget, setResetTarget] = useState<ChatResetTarget | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sizes, setSizes] = useState(storedPanelSizes);
  const statuses = useSchedulerOverviewStatuses();
  const { assignments, assign, hidden } = statuses;
  const shownIds = useMemo(() => new Set(workspaces
    .filter(workspace => !hidden.has(assignedOverviewStatus(assignments, workspace.id)))
    .map(workspace => workspace.id)), [assignments, hidden, workspaces]);
  const chooseStatus = useCallback((workspaceId: string, statusId: string) => {
    assign(workspaceId, statusId);
    if (hidden.has(statusId)) filterRef.current?.focus({ preventScroll: true });
  }, [assign, hidden]);
  const lastSavedSizes = useRef(sizes);
  const resizePanel = useCallback((workspaceId: string, size: SchedulerOverviewSize) => {
    setSizes(previous => new Map(previous).set(workspaceId, size));
  }, []);
  const active = open && presence.stage === 'in';
  const canArrange = shownIds.size > 0 && workspaces.some(workspace => sizes.has(workspace.id));
  useOverlayDismiss(open, onClose);

  const arrangePanels = () => {
    const track = trackRef.current;
    if (track && !prefersReducedMotion()) {
      arrangeFrom.current = Array.from(track.querySelectorAll<HTMLElement>(':scope > [data-scheduler-workspace]:not([hidden])'),
        slot => ({ slot, bounds: slot.getBoundingClientRect() }));
    }
    setSizes(new Map());
  };

  useLayoutEffect(() => {
    const track = trackRef.current;
    const before = arrangeFrom.current;
    arrangeFrom.current = null;
    if (track && before) return animateArrangement(track, before);
  }, [shownIds, sizes]);

  useEffect(() => {
    if (lastSavedSizes.current === sizes) return;
    lastSavedSizes.current = sizes;
    try {
      if (sizes.size) localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify(Object.fromEntries(sizes)));
      else localStorage.removeItem(PANEL_SIZES_KEY);
    } catch {
      flashTip(t('面板尺寸保存失败'));
    }
  }, [flashTip, sizes, t]);

  useLayoutEffect(() => {
    if (active) closeRef.current?.focus({ preventScroll: true });
    else {
      pressedBlank.current = null;
      setResetTarget(null);
      setFilterOpen(false);
    }
  }, [active]);

  useLayoutEffect(() => {
    if (!open || !selectedWorkspaceId || !shownIds.has(selectedWorkspaceId)
      || revealedWorkspaceId.current === selectedWorkspaceId) return;
    const column = Array.from(scrollerRef.current?.querySelectorAll<HTMLElement>('[data-scheduler-workspace]') ?? [])
      .find(element => element.dataset.schedulerWorkspace === selectedWorkspaceId);
    if (!column) return;
    revealedWorkspaceId.current = selectedWorkspaceId;
    column.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [open, selectedWorkspaceId, shownIds, workspaces]);

  useLayoutEffect(() => {
    if (presence.stage === 'out') {
      setStaggerEntry(false);
      return;
    }
    if (presence.stage !== 'enter') return;
    const slots = Array.from(scrollerRef.current?.querySelectorAll<HTMLElement>('[data-scheduler-workspace]') ?? []);
    // 槽位提供静止坐标。先取布局，再统一写飞出起点，反向时沿用原值。
    const flights = slots.map(slot => {
      const bounds = slot.getBoundingClientRect();
      const anchor = getWorkspaceAnchor(slot.dataset.schedulerWorkspace!);
      const distance = anchor ? Math.min(148, Math.max(52, (bounds.left - anchor.right) * 0.32)) : 52;
      return { slot, originY: panelOriginY(bounds, anchor), distance };
    });
    for (const { slot, originY, distance } of flights) {
      slot.style.setProperty('--panel-origin-y', originY);
      slot.style.setProperty('--scheduler-flight-x', `${-distance}px`);
    }
  }, [getWorkspaceAnchor, presence.stage]);

  useEffect(() => {
    const root = scrollerRef.current;
    if (!active || !root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      setVisibleIds(previous => {
        const next = new Set(previous);
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.schedulerWorkspace;
          if (id && entry.intersectionRatio >= 0.5) next.add(id);
          else if (id) next.delete(id);
        }
        return next;
      });
    }, { root, threshold: 0.5 });
    root.querySelectorAll('[data-scheduler-workspace]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [active, workspaces]);

  useEffect(() => {
    if (!active) return;
    for (const workspace of workspaces) {
      const reply = replies[workspace.id];
      if (shownIds.has(workspace.id) && visibleIds.has(workspace.id) && reply && !reply.busy) markRead(workspace.id, reply.messageId);
    }
  }, [active, markRead, replies, shownIds, visibleIds, workspaces]);

  return createPortal(
    <div className="scheduler-overview" data-overlay-root="" {...presence.spread}
      aria-hidden={!active || undefined} {...(!active ? { inert: '' } : {})}
      data-stagger-entry={staggerEntry || undefined}
      onPointerDownCapture={event => {
        const target = event.target;
        const primary = active && event.isPrimary !== false && event.button === 0;
        const track = trackRef.current;
        if (primary && track?.dataset.arranging && target instanceof Element && target.closest('.scheduler-overview-resizer')) {
          delete track.dataset.arranging;
        }
        pressedBlank.current = primary && !filterOpen && target instanceof Element
          && target.hasAttribute('data-scheduler-dismiss') ? target : null;
      }}
      onPointerUpCapture={event => {
        if (event.target !== pressedBlank.current) pressedBlank.current = null;
      }}
      onPointerCancelCapture={() => { pressedBlank.current = null; }}
      onClick={event => {
        const start = pressedBlank.current;
        pressedBlank.current = null;
        if (active && start === event.target) onClose();
      }}>
      <div className="scheduler-overview-backdrop backdrop-blur-overlay mp-scrim" {...presence.spread} aria-hidden data-scheduler-dismiss="" />
      <section id={id} className="scheduler-overview-sheet" {...presence.spread}
        role="dialog" aria-labelledby={`${id}-title`} data-scheduler-dismiss="">
        <header className="scheduler-overview-header mp-scrim" {...presence.spread} data-scheduler-dismiss="">
          <h2 id={`${id}-title`}>{t('工作区对话')}</h2>
          <div className="scheduler-overview-header-actions">
            <SchedulerOverviewFilter open={active && filterOpen} onOpenChange={setFilterOpen} triggerRef={filterRef}
              statuses={statuses} />
            <button type="button" className="agent-chat-clear-btn agent-panel-icon-btn" disabled={!canArrange}
              aria-label={t('整理')} title={t('统一面板尺寸')} onClick={arrangePanels}>
              <IconLayout size={16} />
            </button>
            <button ref={closeRef} type="button" className="agent-chat-clear-btn agent-panel-icon-btn"
              aria-label={t('收起并排对话')} title={t('收起并排对话')} onClick={onClose}>
              <IconShrink size={18} />
            </button>
          </div>
        </header>
        <div className="scheduler-overview-scroller" ref={scrollerRef} tabIndex={0}
          role="region" aria-label={t('工作区对话列表')} data-scheduler-dismiss="">
          <div ref={trackRef} className="scheduler-overview-track" data-scheduler-dismiss="">
            {workspaces.map((workspace, index) => {
              const size = sizes.get(workspace.id);
              const shown = shownIds.has(workspace.id);
              const statusId = assignedOverviewStatus(assignments, workspace.id);
              const status = statuses.kinds.find(kind => kind.id === statusId) ?? UNMARKED_STATUS;
              return (
                <div key={workspace.id} className="scheduler-overview-slot" data-scheduler-workspace={workspace.id}
                  hidden={!shown} data-scheduler-dismiss="" style={{
                    '--scheduler-stagger': Math.min(index, MAX_STAGGER_STEPS),
                    '--scheduler-panel-w': size?.w === undefined ? undefined : `${size.w}px`,
                    '--scheduler-panel-h': size?.h === undefined ? undefined : `${size.h}px`
                  } as React.CSSProperties}>
                  <SchedulerOverviewCard workspace={workspace} stage={presence.stage}
                    active={active && shown} visible={visibleIds.has(workspace.id)}
                    sharedNotes={singleNotes?.workspaceId === workspace.id ? singleNotes : undefined}
                    status={status} statusKinds={statuses.kinds} onChooseStatus={chooseStatus}
                    size={size} onResize={resizePanel} onReset={setResetTarget} />
                </div>
              );
            })}
            {shownIds.size === 0 ? (
              <div className="scheduler-overview-empty">
                <p role="status">{t('没有符合筛选条件的面板')}</p>
                <button type="button" className="btn" onClick={() => statuses.showAll(true)}>{t('显示全部状态')}</button>
              </div>
            ) : null}
          </div>
        </div>
      </section>
      <ChatResetDialog target={active && workspaces.some(workspace => workspace.id === resetTarget?.workspaceId) ? resetTarget : null}
        onClose={() => setResetTarget(null)} />
    </div>,
    document.body
  );
}
