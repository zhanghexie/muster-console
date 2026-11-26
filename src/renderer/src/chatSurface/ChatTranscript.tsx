/**
 * 统一聊天转写视图（调度 Agent 面板 / GUI Worker 会话 / 后台任务子代理面板共用）：
 * GuiChatMessage→ChatMessage 映射经 toDisplay 注入（带缓存让 ChatMessageView memo 生效）、
 * 时间分隔、审批/提问卡插槽、流式贴底、历史轮折叠、会话历史面板（右键用户消息气泡
 * 弹出，悬浮只出内容预览气泡不跳转，点击跳轮且面板不自动关闭）。
 * 对消息模型泛型：宿主经 toDisplay/messagesEqual/waitStateOf/getInlineCards 注入模型语义
 * （GUI 见 guiMessageView.tsx；调度用 dispatchTranscriptBinding：透传 + askQuestion 卡）。
 * 路径链接化由渲染层 ChatMarkdownBody 做（先原文渲染、批量 stat 后只链存在的路径）。
 * 宿主省略交互回调即得「只读聊天视图」（无输入条）。className 落在外壳层（.chat-list-shell），
 * 滚动容器是内层 .chat-list。
 */
import { NoteEditor } from '../components/NoteEditor';
import { createPortal } from 'react-dom';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { overlayViewportOrigin, pageForOverlay, stripOverlayHost, usePagePeek } from '../hooks/useDismissOnPagePeek';
import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../../../shared/types';
import type { GuiHarnessSummary } from '../../../shared/guiWorker';
import { shouldShowTimeSeparator, formatChatTimeLabel } from '../../../shared/chatTime';
import { buildTurnRailStops, getTurnRailPrompt, isUserTurnMessage, locateAbortedTurn } from '../../../shared/chatTurnRail';
import { nextNoteSeq } from '../../../shared/noteAnnotations';
import {
  EMPTY_COMPACTION_MARKERS,
  type ChatCompactionMarker
} from '../../../shared/chatCompaction';
import { locateStreamingAssistantIndex, type ChatSurfacePageWindow, type ChatSurfacePageState } from '../../../shared/chatSurface';
import { isStaleTurn } from '../../../shared/chatStaleTurn';
import { shouldOmitRepeatedAvatar, type ChatAvatarContext } from '../../../shared/userAvatar';
import { ChatMessageView } from '../components/ChatMessageView';
import { CompactDivider } from '../components/CompactDivider';
import {
  HarnessCompactDivider,
  HarnessDrawer,
  HarnessInjectCard,
  HarnessSteerLine,
  resolveInjectionCards
} from './harnessAnnotations';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { useHistoryFavorites } from './useHistoryFavorites';
import { PENDING_NOTE_ID } from '../agentChat/noteAnchors';
import { isSessionNoteEntryTarget, isSessionNotePendingTarget } from './noteEntries';
import { MOTION, usePresence } from '../components/motion';
import { IconChevronDown } from '../components/icons';
import { showTip } from '../tips';
import { applyChatFindMarks, clearChatFindMarks } from './chatFindHighlight';
import { useTranscriptScrollController, wheelReachesTranscript } from './transcriptScrollController';
import { transcriptAnchorTop, visibleTranscriptAnchor, type VisibleTranscriptAnchor } from './transcriptScrollAnchor';
import { prepareTranscriptBottom } from './transcriptInitialLayout';
import { syncChatSurfaceLayout } from './chatSurfaceLayout';
import { TurnSnapshotVisibility } from './TurnSnapshotVisibility';
import {
  computeAnchorCompensation,
  computeVirtualWindow,
  type MeasuredVirtualizerResult
} from './measuredVirtualizer';

import { transcriptRows } from './sparseTranscript';
import { mapTranscriptMessages, type TranscriptDisplayCache } from './transcriptDisplay';
import { resolveProgressiveRange, resolveTranscriptClipRange } from './transcriptRangeController';
import {
  rememberTranscriptScroll,
  resetOneTranscriptScroll,
  takeTranscriptScroll,
  type TranscriptScrollMemory
} from './transcriptScrollMemory';

export {
  rememberTranscriptScroll,
  resetOneTranscriptScroll,
  resetTranscriptScrollMemoryForTest,
  takeTranscriptScroll
} from './transcriptScrollMemory';
export type { TranscriptScrollMemory } from './transcriptScrollMemory';

type NotePos = { top: number; right: number; wrapW: number; wrapH: number };

function notePosEqual(a: Record<string, NotePos>, b: Record<string, NotePos>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (!y || x.top !== y.top || x.right !== y.right || x.wrapW !== y.wrapW || x.wrapH !== y.wrapH) {
      return false;
    }
  }
  return true;
}

/** 角标重测量静默窗（ms）：RO 动画期逐帧触发的去抖窗，非动画时长（与 MOTION 无关） */
const RO_SETTLE_MS = 120;
/** 查找 mark 重刷防抖：连续命中变更合一次重刷 */
const FIND_MARK_DEBOUNCE_MS = 160;
/** 同一查询的重刷最长等待：流式 delta 密集时防抖被持续重排，超过该间隔强制重刷 */
const FIND_MARK_MAX_WAIT_MS = 500;

/** 距底小于此值视为 atBottom；自动贴底后的 1–2px 回弹仍落在带内 */
export const TRANSCRIPT_BOTTOM_PX = 60;

/** ── 长转录窗口裁剪（R-23 一期，导出供 spec 引用）──
 *  消息总数超过阈值才启用尾部窗口（含分割线条目），其余渲染「加载更早」按钮回填；
 *  小会话零行为差异（无按钮、无裁剪）。完整双向虚拟化（spacer 估算行高/双向挂载）
 *  与贴底、跳转、批注三处硬约束的平衡留给二期（见 docs/features/chat-transcript.md）。 */
export const TRANSCRIPT_CLIP_THRESHOLD = 500;
/** 初始窗口的 stream 条目数（消息 + 压缩分割线） */
export const TRANSCRIPT_CLIP_WINDOW = 120;
/** 每次点「加载更早」回填的条目数 */
export const TRANSCRIPT_CLIP_CHUNK = 240;
/** Measured virtualization starts after the legacy clip window has enough rows
 * to justify spacers and bidirectional range movement. */
export const MEASURED_VIRTUALIZER_THRESHOLD = TRANSCRIPT_CLIP_THRESHOLD * 2;
export const MEASURED_VIRTUALIZER_OVERSCAN = 24;
/** `.agent-chat-col`'s fixed row gap, included in virtual content coordinates. */
export const MEASURED_VIRTUALIZER_ROW_GAP = 20;
/** ── 首开渐进挂载（2026-10-14 性能专项）──
 *  按 part 量计的重会话（几十条消息撑上千工具卡）首开一次性挂全部行，会把
 *  style/layout/paint 压成单帧 100ms+ 长任务。转写贴底——尾部即视口，首批
 *  只放行尾部若干 part 预算，旧行每帧一批自尾部向上补齐（观感=旧内容自顶缘
 *  渐次浮现，无跳变）。仅首开生效（预算走满后恒挂满）；reveal/查找命中与
 *  历史面板跳转按需立即放行目标行；parts 总量不超阈值的会话零行为差异。 */
/** parts 总量阈值：超过才渐进。须高于 CLIP_THRESHOLD×单 part 正文会话的典型
 *  parts 量（500 条纯文本会话 = 500 parts），保住「短会话零行为差异」契约；
 *  实测重会话（几十条消息 + 上千工具卡）在 1000+ parts 档 */
export const PROGRESSIVE_PARTS_THRESHOLD = 600;
/** 首批放行的 part 预算（约一屏工具卡量级） */
export const PROGRESSIVE_FIRST_PARTS = 64;
/** 每帧补齐的 part 预算 */
export const PROGRESSIVE_STEP_PARTS = 140;
/** 流式行 display 重映射最小间隔（B1-7）：micromark 解析从每批（≤50ms 合批节奏）
 *  降档到 ≤10 次/秒；节流窗内的批次复用旧映射，流式翻转 false 时强制终渲落地尾值。
 *  回滚=去掉 displayMessages 循环里的节流分支。 */
export const STREAM_REMAP_THROTTLE_MS = 100;
/** 停靠点跳转 reveal 事件（ChatHistoryPanel 在目标锚点不在 DOM 时派发到滚动容器上） */
const CLIP_REVEAL_EVENT = 'chat-clip:reveal';

export function isTranscriptAtBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < TRANSCRIPT_BOTTOM_PX;
}

/** 批注卡片（会话批注；由宿主下发，转写层贴着批注文字渲染） */
export interface TranscriptNote {
  id: string;
  seq: number;
  quote: string;
  note: string;
  messageId: string;
}

/** 审批/提问卡插槽内容（模型语义由宿主的 getInlineCards 提供） */
export interface TranscriptInlineCards {
  changes?: React.ReactNode;
  approval?: React.ReactNode;
  approvalAnchor?: number;
  question?: React.ReactNode;
  questionAnchor?: number;
}

/** harness 回合计量（与 ChatMessageView 的 harnessMetrics prop 同形） */
interface HarnessTurnMetrics {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  durationMs?: number;
}

/** 消息模型绑定：转写对具体消息模型无感知，宿主注入映射/等价/等待态/插槽语义 */
export interface TranscriptModelBinding<T> {
  /** 原生消息 → 渲染消息（结构适配；路径链接化在渲染层 ChatMarkdownBody） */
  toDisplay: (m: T, streaming: boolean) => ChatMessage;
  /** 渲染等价判断（映射缓存复用的依据；缺省引用相等） */
  messagesEqual?: (a: T, b: T) => boolean;
  /** 末条 assistant 的人机等待态（审批/提问 pending）——解除时重新贴底 */
  waitStateOf?: (m: T | null | undefined) => 'approval' | 'question' | null;
  /** 审批/提问卡插槽（按 anchorPartIndex 插进 parts 流） */
  getInlineCards?: (m: T) => TranscriptInlineCards;
  /** Harness 透明·插话标记（'send'=用户插话 / 'host'=宿主静默插话）；缺省无插话语义 */
  steeringOf?: (m: T) => 'send' | 'host' | undefined;
  /** Harness 透明·回合计量（turn-complete summary 盖章；详情抽屉与 chips 数据源） */
  harnessOf?: (m: T) => GuiHarnessSummary | undefined;
  engineInputRefOf?: (m: T) => string | undefined;
}

/** Harness 透明标注数据（GUI 会话由壳注入；缺省不渲染任何标注——现状零变化） */
export interface TranscriptHarness {
  on: boolean;
  /** 注入快照信封（代际首次生效/变化的回合出卡；无则不画卡） */
  injections?: readonly import('../../../shared/guiHistoryMetadata').GuiInjectionView[];
  injectionDetails?: import('../../../shared/chatSurface').HarnessViewState['injectionDetails'];
  engineInput?: import('../../../shared/chatSurface').HarnessViewState['engineInput'];
}

/** B1-6：行 deps 浅比较（逐槽 Object.is；槽位只放原始值或稳定引用） */
function rowDepsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

function ChatTranscriptInner<
  T extends {
    id: string;
    role: 'user' | 'assistant';
    queued?: boolean;
    host?: boolean;
    source?: string;
  }
>(props: {
  messages: readonly T[];
  page?: ChatSurfacePageState;
  busy: boolean;
  /** Server-side history cursor has older messages available. */
  hasEarlier?: boolean;
  /** Fetch the next older range before applying the local clip window. */
  onLoadEarlier?: () => void | Promise<void>;
  /** Fetch the bounded range containing an explicitly navigated message. */
  onEnsureMessageLoaded?: (messageId: string) => Promise<boolean>;
  /** Retain payloads and fetch missing absolute ranges around the viewport. */
  onVirtualWindow?: (window: ChatSurfacePageWindow) => void;
  /** Page-map absolute index used for target navigation when available. */
  messageIndex?: (messageId: string) => number | undefined;
  sessionId: string;
  /** A nested transcript can share its parent's session ID without sharing its favorites. */
  historyId?: string;
  cwd?: string;
  workspaceId?: string;
  /** Kept-alive hidden transcripts never retain input listeners or animation work. */
  interactionActive?: boolean;
  /** Recorded frames already have a playback clock; old turns remain available for filming. */
  replaying?: boolean;
  /** 消息模型绑定（映射/等价/等待态/审批提问卡插槽） */
  model: TranscriptModelBinding<T>;
  /** 消息列表上方常驻内容（空态欢迎语等） */
  header?: React.ReactNode;
  className?: string;
  /** 划词区标识（gui-chat=带批注动作；agent-chat=通用内容菜单） */
  selArea?: string;
  /** 会话批注：角标贴着批注文字渲染（内容坐标系，随滚动/回流移动） */
  notes?: TranscriptNote[];
  /** 录入中的批注（待定锚点已包裹，角标旁开录入气泡；确认后角标留下） */
  pendingNote?: { quote: string; messageId: string; span: HTMLElement } | null;
  /** 受控：与输入框药丸共用同一打开态。不传则转写层自持（单测/无宿主） */
  openNoteId?: string | null;
  onOpenNote?: (id: string | null) => void;
  onNoteUpdate?: (id: string, note: string) => void;
  onNoteDelete?: (id: string) => void;
  onPendingConfirm?: (note: string) => void;
  onPendingCancel?: () => void;
  onFork?: (messageId: string) => void;
  onEditAborted?: (messageId: string) => void;
  onRetry?: () => void;
  onCancelQueued?: (messageId: string) => void;
  onPlanAction?: (action: 'execute' | 'abandon' | 'revise', feedback?: string) => void;
  planActionDisabled?: boolean;
  /** 会话当前模式：非 plan 档计划卡转只读 */
  mode?: string | null;
  onFileLink?: (href: string) => void;
  /** 消息流压缩分割线（按 createdAt 插在对应位置；缺省不画） */
  compactions?: readonly ChatCompactionMarker[];
  /** Harness 透明标注（GUI 会话；缺省不渲染任何标注——开关关闭时与现状完全一致） */
  harness?: TranscriptHarness;
  /** 调度/Worker 头像上下文（用户头像走模块态，不经此 prop） */
  avatarContext?: ChatAvatarContext;
  /** 会话查找：查询串（空=不高亮）；由 ChatSurfaceView 注入 */
  findQuery?: string;
  /** 当前活动命中（滚到该消息并标 active mark） */
  findActive?: { messageId: string; indexInMessage: number } | null;
}): React.JSX.Element {
  const { messages, busy, sessionId, cwd } = props;
  const { t } = useTranslation();
  const {
    onFork,
    onEditAborted,
    onRetry,
    onCancelQueued,
    onPlanAction,
    planActionDisabled,
    mode,
    onFileLink,
    onNoteUpdate,
    onNoteDelete,
    onPendingConfirm,
    onPendingCancel,
    onOpenNote
  } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const snapshotPending = useContext(TurnSnapshotVisibility)?.pendingInitial ?? false;
  const wasSnapshotPending = useRef(snapshotPending);
  const stickBottomRef = useRef(true);
  /** 上一次 scrollTop：判定滚动方向用——「向上滚」是明确的翻看意图，
   *  只看距底 <60px 会被流式贴底回写抵消（小步滚动永远出不了容差带）。
   *  初值 -1 = 尚无基线：首个 scroll 事件只记录、不判方向 */
  const lastScrollTopRef = useRef(-1);
  const pendingWheelWriteRef = useRef<{ top: number; direction: number } | null>(null);
  /** 上一次见过的最后一条 user 消息 id：出现新 user 消息即重新贴底（跟随回复）。
   *  只作「新回合到了」的门闩，从不把视口滚到该条用户消息——重开/切会话一律贴底 */
  const lastUserIdRef = useRef<string | null>(null);
  const lastSessionIdRef = useRef(sessionId);
  const interactionActiveRef = useRef(props.interactionActive !== false);
  interactionActiveRef.current = props.interactionActive !== false;
  const lastInteractionActiveRef = useRef(props.interactionActive !== false);
  /** 末条 assistant 的人机等待态（审批/提问 pending）：作答/解除时重新贴底——
   *  回合在原地继续流内容，不重新挂跟随用户会以为「卡住直到回合结束」 */
  const lastWaitRef = useRef<'approval' | 'question' | null>(null);
  const [showJump, setShowJump] = useState(false);
  const jumpPresence = usePresence(showJump, MOTION.menuMs);
  /** 窗口裁剪回填量（clipStart = stream.length - WINDOW - clipExtra）；切会话重置 */
  const [clipExtra, setClipExtra] = useState(0);
  const clipStartRef = useRef(0);
  /** Freeze the front edge while the reader is away from the tail. */
  const frozenClipStartRef = useRef<number | null>(null);
  /** Absolute row measurements used by the measured bidirectional window. */
  const virtualMeasuredHeightsRef = useRef<Record<string, number>>({});
  const virtualMeasuredMarginsRef = useRef<Record<string, number>>({});
  const virtualViewportRef = useRef<{ offset?: number; height: number }>({ height: 0 });
  const virtualBaseOffsetRef = useRef(0);
  const virtualizerActiveRef = useRef(false);
  const virtualResultRef = useRef<MeasuredVirtualizerResult | null>(null);
  const virtualAnchorRef = useRef<{ key: string; offset: number } | null>(null);
  const pageGenerationRef = useRef(props.page?.generation);
  const restoreRequestRef = useRef<string | null>(null);
  const virtualProjectionRef = useRef<{
    head: string | null;
    middle: string | null;
    tail: string | null;
    length: number;
    markers: string;
  } | null>(null);
  const [virtualTick, setVirtualTick] = useState(0);
  const detachFromBottom = useCallback(() => {
    frozenClipStartRef.current ??= clipStartRef.current;
    stickBottomRef.current = false;
  }, []);
  /** 「加载更早」锚定还原：点击时记 scrollHeight/scrollTop，渲染提交后按增量挪回 */
  const clipAnchorRef = useRef<{
    height: number;
    top: number;
    visible: VisibleTranscriptAnchor | null;
    id: string | null;
  } | null>(null);
  /** 阅读位置记忆（LRU 逐出重挂恢复用）：sid 变化时从记忆取，渐进挂载走完后消费 */
  const pendingRestoreRef = useRef<TranscriptScrollMemory | null>(null);
  /** onScroll/unmount 记忆写入需要当前值（onScroll 是零依赖回调，经 ref 读） */
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const clipExtraRef = useRef(clipExtra);
  clipExtraRef.current = clipExtra;
  const readingCorrectionRef = useRef<number | null>(null);
  const readingEpochRef = useRef(0);
  const initialLayoutCleanupRef = useRef<(() => void) | null>(null);
  const initialViewportPendingRef = useRef(false);
  const positionedContentSessionRef = useRef<string | null>(null);
  const cancelReadingWork = useCallback(() => {
    initialViewportPendingRef.current = false;
    initialLayoutCleanupRef.current?.();
    initialLayoutCleanupRef.current = null;
    readingEpochRef.current++;
    if (readingCorrectionRef.current != null) cancelAnimationFrame(readingCorrectionRef.current);
    readingCorrectionRef.current = null;
  }, []);
  const scrollController = useTranscriptScrollController(scrollRef, props.interactionActive !== false, {
    onWrite: (top, wheelDirection = 0) => {
      lastScrollTopRef.current = top;
      pendingWheelWriteRef.current = wheelDirection ? { top, direction: wheelDirection } : null;
    },
    onUserScroll: delta => { if (delta < 0) detachFromBottom(); },
    onUserInput: () => {
      cancelReadingWork();
      pendingRestoreRef.current = null;
      clipAnchorRef.current = null;
    }
  });
  useLayoutEffect(() => () => { cancelReadingWork(); scrollController.cancel(); }, [sessionId, props.interactionActive, cancelReadingWork, scrollController]);
  const capturePrepend = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      const visible = visibleTranscriptAnchor(el);
      clipAnchorRef.current = {
        height: el.scrollHeight,
        top: el.scrollTop,
        visible,
        id: visible?.node.dataset.mid ?? null
      };
    }
  }, []);
  const correctReadingAnchor = useCallback((anchor: VisibleTranscriptAnchor) => {
    cancelReadingWork();
    if (props.interactionActive === false || document.hidden) return;
    const epoch = readingEpochRef.current;
    let frames = 0;
    const correct = (): void => {
      readingCorrectionRef.current = null;
      const el = scrollRef.current;
      if (!el || epoch !== readingEpochRef.current || props.interactionActive === false || document.hidden ||
        stickBottomRef.current || scrollController.isAnimating() || !anchor.node.isConnected || !el.contains(anchor.node)) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.max(0, Math.min(max, transcriptAnchorTop(el, anchor)));
      lastScrollTopRef.current = el.scrollTop;
      if (++frames < 2) readingCorrectionRef.current = requestAnimationFrame(correct);
    };
    readingCorrectionRef.current = requestAnimationFrame(correct);
  }, [cancelReadingWork, props.interactionActive, scrollController]);
  const navigateToElement = useCallback((target: HTMLElement | (() => HTMLElement | null), center = false) => {
    const el = scrollRef.current;
    if (!el || !interactionActiveRef.current) return;
    cancelReadingWork();
    pendingRestoreRef.current = null;
    clipAnchorRef.current = null;
    detachFromBottom();
    // Only this target is measured while navigating. Its skipped content can
    // become real on entry, so a fixed estimate would finish at the wrong place.
    let lastTop = el.scrollTop;
    const top = (): number => {
      const node = typeof target === 'function' ? target() : target;
      if (!node?.isConnected || !el.contains(node)) return lastTop;
      const rect = node.getBoundingClientRect();
      lastTop = el.scrollTop + rect.top - el.getBoundingClientRect().top - (center ? (el.clientHeight - rect.height) / 2 : 8);
      return lastTop;
    };
    scrollController.jumpTo(top);
    setShowJump(!isTranscriptAtBottom(el));
  }, [cancelReadingWork, detachFromBottom, scrollController]);
  /** 锚定消息节流测量（滚动停 150ms 后量视口顶行）。不能只在卸载时量——
   *  LRU 逐出前视图已 display:none，几何全 0 量不出；滚动停后即时补记。 */
  const anchorTimerRef = useRef<number | null>(null);
  const measureAnchor = useCallback(() => {
    anchorTimerRef.current = null;
    const el = scrollRef.current;
    const sid = sessionIdRef.current;
    if (!el || !interactionActiveRef.current || el.clientHeight <= 0) return;
    if (isTranscriptAtBottom(el)) return;
    const mem = takeTranscriptScroll(sid);
    if (!mem) return;
    const anchor = visibleTranscriptAnchor(el);
    rememberTranscriptScroll(sid, { ...mem, anchorMid: anchor?.node.dataset.mid ?? null, anchorOffset: anchor?.offset ?? 0 });
  }, []);
  useEffect(() => () => {
    if (anchorTimerRef.current != null) {
      window.clearTimeout(anchorTimerRef.current);
      anchorTimerRef.current = null;
    }
  }, [measureAnchor]);
  /** 首开渐进预算（parts 计；Infinity=未启用或已挂满）。会话首渲染在
   *  renderedWindow 内按 parts 总量惰性初始化（重挂首拍转录常未到——
   *  displayMessages 为空，须等首个非空拍再定预算，否则渐进失效）；
   *  扩批改预算后靠 tick 强制重算（renderedWindow/查找重刷 effect 的 deps
   *  都含 tick）。 */
  const progressiveRef = useRef<{ sid: string; budget: number; decided: boolean }>({ sid: '', budget: Infinity, decided: false });
  const [progressTick, setProgressTick] = useState(0);
  /** 停靠点跳转 reveal 的目标消息 id：扩窗渲染提交后滚到其锚点 */
  const revealTargetRef = useRef<string | null>(null);
  const revealLoadRef = useRef<{ id: string; sessionId: string; ready: boolean } | null>(null);
  const [revealLoadTick, setRevealLoadTick] = useState(0);
  useEffect(() => () => { revealLoadRef.current = null; }, [sessionId]);
  /** delta 高频路径的映射缓存：内容没变就复用旧映射，让 ChatMessageView 的 memo 生效 */
  const displayCacheRef = useRef<TranscriptDisplayCache<T>>(new Map());
  /** 审批/提问卡缓存（同 displayCache 口径）：getInlineCards 每次产出新 JSX 元素，
   *  直接传会让带卡的行在每次 messages 引用变化时击穿 ChatMessageView 的 memo
   *  （2026-09-14 性能专项）。消息等价时复用旧元素；无卡的行恒为 null 天然稳定 */
  const cardsCacheRef = useRef(
    new Map<string, { src: T; out: TranscriptInlineCards | null }>()
  );
  /** harness 回合计量缓存（同 cardsCache 口径，B1-5）：hMetrics 字面量每次渲染
   *  新建，直接传会让带 usage 的 harness 行在每次流式 delta（messages 换引用）
   *  时击穿 ChatMessageView 的 memo。src 等价（引用或 messagesEqual——
   *  guiChatMessageEqual 含 harness 摘要比对，计量盖章必失配）即复用旧对象，
   *  真变行才换新。 */
  const hMetricsCacheRef = useRef(
    new Map<string, { src: T; out: HarnessTurnMetrics | undefined; sum: GuiHarnessSummary | undefined }>()
  );
  /** 行级元素缓存（B1-6）：行渲染消费的全部自由变量逐槽快照进 deps，全等即复用
   *  旧 element——React 对同引用元素跳过整棵子树调和，openBubbleId/findActive/
   *  notePos 等变化只失效受影响行，未变行连元素构建都归零。回滚=退回单 useMemo 整窗。 */
  const rowCacheRef = useRef(new Map<string, { deps: unknown[]; el: React.ReactNode }>());
  /** 批注按消息缓存（同 cardsCache 口径）：filter 每次产出新数组，直接传会让
   *  带批注的行在每次流式 delta 时击穿 ChatMessageView 的 memo；notes 引用不变
   *  则整代复用，notes 变化即整代作废 */
  const msgNotesCacheRef = useRef<{
    src: readonly TranscriptNote[] | undefined;
    byMsg: Map<string, TranscriptNote[]>;
  }>({ src: undefined, byMsg: new Map() });

  /** 存在进行中的压缩分割线（贴底 effect 的额外触发时机，见下方注释）：
   *  手动 /compact 期间 messages/busy 均不变，仅凭二者无法感知 running 线出现 */
  const hasRunningCompaction = (props.compactions ?? EMPTY_COMPACTION_MARKERS).some(
    (m) => m.status === 'running'
  );

  // 流式自动贴底（用户上翻则不贴）；新用户消息到达时重新贴底。
  // 不能只看「末条是否 user」：宿主侧用户消息与 assistant 占位常被
  // React 合批成一次渲染，末条恒为 assistant，判定永不命中——用户上翻过一次后
  // 整个回合就不再跟随（发的新内容堆在视口外，需手动滚动才显示）。
  // 手动 /compact 的 running 压缩分割线出现/消失也要重跑本判定：主进程压缩期间
  // 不改 messages 也不推 busy，缺这个触发时机 running 线会停在 composer 覆盖区，
  // 用户得不到「正在压缩」反馈。贴底仍受 stickBottomRef 门控——只是补触发时机，
  // 用户上翻阅读时不会因 marker 变化被强行拉底。
  // sessionId 变（调度面板关开重挂 / 切工作区 / 中栏切回新实例）必须重置门闩并贴底：
  // 不得把视口停在「最后一条用户消息」——那是当前回合起点，不是最新回复。
  useLayoutEffect(() => {
    if (pageGenerationRef.current !== props.page?.generation) {
      pageGenerationRef.current = props.page?.generation;
      virtualMeasuredHeightsRef.current = {};
      virtualMeasuredMarginsRef.current = {};
      virtualViewportRef.current = { height: 0 };
      virtualAnchorRef.current = null;
      virtualBaseOffsetRef.current = 0;
      pendingRestoreRef.current = null;
      restoreRequestRef.current = null;
      revealTargetRef.current = null;
      resetOneTranscriptScroll(sessionId);
    }
    const firstPosition = lastScrollTopRef.current < 0 || lastSessionIdRef.current !== sessionId ||
      (!lastInteractionActiveRef.current && interactionActiveRef.current);
    lastInteractionActiveRef.current = interactionActiveRef.current;
    let newTurn = false;
    if (lastSessionIdRef.current !== sessionId) {
      cancelReadingWork();
      scrollController.cancel();
      lastSessionIdRef.current = sessionId;
      lastUserIdRef.current = null;
      lastWaitRef.current = null;
      lastScrollTopRef.current = -1;
      virtualViewportRef.current = { height: 0 };
      virtualBaseOffsetRef.current = 0;
      virtualMeasuredHeightsRef.current = {};
      virtualMeasuredMarginsRef.current = {};
      virtualProjectionRef.current = null;
      virtualAnchorRef.current = null;
      setVirtualTick((tick) => tick + 1);
      setShowJump(false);
      clipAnchorRef.current = null;
      frozenClipStartRef.current = null;
      revealTargetRef.current = null;
      // 阅读位置记忆：切走时不在底部的，恢复 scrollTop 与「加载更早」窗口；
      // 在底部的走默认贴底。渐进挂载下先按贴底渲染（尾部即视口），挂满后
      // 由恢复 effect 一次跳回记忆位置。
      const mem = takeTranscriptScroll(sessionId);
      if (mem) {
        pendingRestoreRef.current = mem;
        stickBottomRef.current = false;
        setClipExtra(mem.clipExtra);
      } else {
        pendingRestoreRef.current = null;
        stickBottomRef.current = true;
        setClipExtra(0);
      }
    }
    let lastUser: T | null = null;
    let lastMsg: T | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!lastMsg) lastMsg = messages[i]!;
      if (isUserTurnMessage(messages[i]!)) {
        lastUser = messages[i]!;
        break;
      }
    }
    if (lastUser && lastUser.id !== lastUserIdRef.current) {
      newTurn = lastUserIdRef.current != null;
      lastUserIdRef.current = lastUser.id;
      stickBottomRef.current = true;
      setShowJump(false);
    }
    // 审批/提问刚被作答（等待态消失而回合还在跑）：跟随重新挂上，
    // 后续流式内容立刻进入视口
    const waitNow = props.model.waitStateOf ? props.model.waitStateOf(lastMsg) : null;
    if (lastWaitRef.current && !waitNow && busy) {
      stickBottomRef.current = true;
      setShowJump(false);
    }
    lastWaitRef.current = waitNow;
    const el = scrollRef.current;
    if (!el || !stickBottomRef.current || !interactionActiveRef.current) return;
    frozenClipStartRef.current = null;
    // Resolve the initial viewport before pinning: content-visibility estimates
    // otherwise settle over several painted frames and move the visible reply.
    const firstContent = messages.length > 0 && positionedContentSessionRef.current !== sessionId;
    if (messages.length && (firstPosition || firstContent)) {
      initialViewportPendingRef.current = true;
      // A child layout effect runs before the surface's composer observer.
      // Measure its real height before pinning, not the 120px CSS fallback.
      syncChatSurfaceLayout(el.closest<HTMLElement>('.chat-surface-view'));
      initialLayoutCleanupRef.current?.();
      initialLayoutCleanupRef.current = prepareTranscriptBottom(el);
      positionedContentSessionRef.current = sessionId;
    }
    // 写入后立刻同步基线并收起浮钮：程序化 scrollTop 会同步触发 scroll，
    // 1–2px 回弹若仍按「上翻」处理会把刚关掉的浮钮再打开。
    scrollController.followBottom(firstPosition || firstContent || newTurn);
    setShowJump(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- waitStateOf 由宿主保证引用稳定
  }, [messages, busy, hasRunningCompaction, sessionId, props.interactionActive, props.page?.generation]);

  // 卸载时保存阅读位置（LRU 逐出/父层关开重挂）：在底部则清记忆（重挂默认
  // 贴底）。锚已在滚动停止时由 measureAnchor 记好（逐出前视图已 display:none，
  // 此处几何不可靠，不量）；滚动后 150ms 内被逐出的极端情况退绝对值恢复。
  useEffect(() => () => {
    const el = scrollRef.current;
    const sid = sessionIdRef.current;
    if (anchorTimerRef.current != null) {
      window.clearTimeout(anchorTimerRef.current);
      anchorTimerRef.current = null;
    }
    if (!el) return;
    if (isTranscriptAtBottom(el)) resetOneTranscriptScroll(sid);
    else {
      const mem = takeTranscriptScroll(sid);
      if (!mem) {
        rememberTranscriptScroll(sid, { top: el.scrollTop, clipExtra: clipExtraRef.current, anchorMid: null, anchorOffset: 0 });
      }
      // 已有记忆（滚动期写入 + 节流锚）不覆盖——其 anchor 更准
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 卸载时经 ref 读终值
  }, []);

  // 挂载期读取阅读位置记忆（LRU 逐出后的重挂是全新实例，不走上方 sid-change
  // 重置块——那只在原地换会话时触发）。有记忆：恢复回填窗口 + 待渐进挂满后
  // 跳回阅读位置；无记忆：默认贴底。
  useEffect(() => {
    const mem = takeTranscriptScroll(sessionId);
    if (mem) {
      pendingRestoreRef.current = mem;
      stickBottomRef.current = false;
      setClipExtra(mem.clipExtra);
    }
    // 仅挂载一次；deps 故意只认 sessionId（in-place 换会话由重置块负责）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !interactionActiveRef.current) return;
    const last = lastScrollTopRef.current;
    const top = el.scrollTop;
    const normalizedTop = Math.max(0, top - virtualBaseOffsetRef.current);
    if (virtualizerActiveRef.current &&
      (virtualViewportRef.current.offset !== normalizedTop || virtualViewportRef.current.height !== el.clientHeight)) {
      virtualViewportRef.current = { offset: normalizedTop, height: el.clientHeight };
      setVirtualTick((tick) => tick + 1);
    }
    const pendingWheel = pendingWheelWriteRef.current;
    const wheelDirection = pendingWheel && Math.abs(top - pendingWheel.top) <= 1 ? pendingWheel.direction : 0;
    pendingWheelWriteRef.current = null;
    lastScrollTopRef.current = top;
    const atBottom = isTranscriptAtBottom(el);
    // 阅读位置记忆：滚动中持续刷新绝对值（Map.set 微秒级）；在底部时清记忆
    //（贴底是重挂默认）。锚定消息在滚动停止后节流补记（measureAnchor）。
    if (atBottom) resetOneTranscriptScroll(sessionIdRef.current);
    else {
      rememberTranscriptScroll(sessionIdRef.current, { top, clipExtra: clipExtraRef.current, anchorMid: null, anchorOffset: 0 });
      if (anchorTimerRef.current != null) window.clearTimeout(anchorTimerRef.current);
      anchorTimerRef.current = window.setTimeout(measureAnchor, 150);
    }
    if (scrollController.isAnimating()) {
      setShowJump(!atBottom && !stickBottomRef.current);
      return;
    }
    // 已在底部容差带：浮钮必须关。带内微抖（自动贴底回弹）不当作用户上翻。
    // 真上翻逃出 60px 后才出钮；带内摘跟随仍靠 onWheel（流式贴底否则掐死上翻）。
    if (atBottom) {
      setShowJump(false);
      // The programmatic final wheel write also updates the baseline. Its async
      // scroll event must retain an explicit up-wheel even inside the 60px band.
      if (wheelDirection >= 0 && (last < 0 || top >= last - 1)) stickBottomRef.current = true;
      return;
    }
    if (last < 0) return;
    if (top < last - 1) {
      detachFromBottom();
      setShowJump(true);
      return;
    }
    // 跟随态下内容/输入条让位把距底撑开：钉回底部，不要当成「用户离底」摘跟随。
    // 调度面板关开会重挂转写，composer overlay 写入晚于首帧贴底——旧逻辑在这里
    // 把 stickBottom 摘掉，视口停在最后一条用户消息，最新回复得手动滚。
    if (stickBottomRef.current) {
      scrollController.followBottom();
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [detachFromBottom]);

  useEffect(() => {
    if (messages.length !== 0) return;
    if (Object.keys(virtualMeasuredHeightsRef.current).length === 0 &&
      Object.keys(virtualMeasuredMarginsRef.current).length === 0 &&
      virtualViewportRef.current.offset === undefined && virtualViewportRef.current.height === 0) return;
    virtualMeasuredHeightsRef.current = {};
    virtualMeasuredMarginsRef.current = {};
    virtualViewportRef.current = { height: 0 };
    virtualBaseOffsetRef.current = 0;
    setVirtualTick((tick) => tick + 1);
  }, [messages.length, sessionId]);

  // 只对传给外层的上翻摘跟随：思考/代码等内部滚动区消费的 wheel 也会冒泡。
  // 内部到顶后允许滚动链时继续检查祖先，不能一律 stopPropagation 掐断外层滚动。
  const onWheel = useCallback((e: React.WheelEvent) => {
    // 已解除跟随时没有待修改的状态；连续上翻不再逐事件量祖先样式/滚动几何。
    // 回底会重新挂跟随，届时仍按内部滚动区与滚动链规则判定。
    if (!stickBottomRef.current || e.deltaY >= 0 || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const root = scrollRef.current;
    if (!root || !wheelReachesTranscript(root, e.target, e.deltaY)) return;
    detachFromBottom();
  }, [detachFromBottom]);

  // Sandboxed content transfers wheel/collapse intent through its owning scroll container.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onInteraction = (): void => { detachFromBottom(); scrollController.cancel(); cancelReadingWork(); };
    el.addEventListener('chat-scroll:user-interaction', onInteraction);
    return () => el.removeEventListener('chat-scroll:user-interaction', onInteraction);
  }, [cancelReadingWork, detachFromBottom, scrollController]);

  const jumpBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottomRef.current = true;
    cancelReadingWork();
    pendingRestoreRef.current = null;
    scrollController.jumpTo(() => scrollRef.current?.scrollHeight ?? 0);
    setShowJump(false);
  }, [cancelReadingWork, scrollController]);
  const navigateToMessage = useCallback((id: string) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
    if (target) navigateToElement(target);
    else el.dispatchEvent(new CustomEvent(CLIP_REVEAL_EVENT, { detail: { historyMessageId: id } }));
  }, [navigateToElement]);

  // ── 窗口裁剪：回填入口（reveal 监听与视口补偿 effect 在 renderedWindow 之后声明）──
  /** 「加载更早」：扩窗 + 记锚定几何。prepend 会让视口内容整体下移，
   *  渲染提交后的补偿 effect 按高度增量把 scrollTop 挪回去（不跳阅读位置） */
  const loadEarlier = useCallback(() => {
    if (virtualizerActiveRef.current) {
      if (!props.page?.slots && props.hasEarlier && props.onLoadEarlier) {
        capturePrepend();
        void props.onLoadEarlier();
        return;
      }
      const el = scrollRef.current;
      if (el) {
        detachFromBottom();
        scrollController.jumpTo(() => Math.max(0, el.scrollTop - Math.max(el.clientHeight, 240)));
      }
      return;
    }
    capturePrepend();
    if (clipStartRef.current > 0 || !props.hasEarlier) {
      setClipExtra((cur) => cur + TRANSCRIPT_CLIP_CHUNK);
      return;
    }
    void props.onLoadEarlier?.();
  }, [capturePrepend, detachFromBottom, props.hasEarlier, props.onLoadEarlier, props.page?.slots, scrollController]);
  // ── 会话批注：角标+气泡（内容坐标系）——量锚点 span 相对消息包装层的偏移；
  // 窗口/列宽变化经 ResizeObserver+resize 重测；角标是 16px 数字圆点，几乎不占地 ──
  const notes = props.notes;
  const pendingNote = props.pendingNote;
  const [notePos, setNotePos] = useState<Record<string, NotePos>>({});
  const [layoutTick, setLayoutTick] = useState(0);
  /** 打开了查看/编辑气泡的批注 id（待定批注的录入气泡常开）。宿主传入则受控。 */
  const [internalOpenId, setInternalOpenId] = useState<string | null>(null);
  const openControlled = onOpenNote != null;
  const openBubbleId = openControlled ? (props.openNoteId ?? null) : internalOpenId;
  const openBubbleIdRef = useRef(openBubbleId);
  openBubbleIdRef.current = openBubbleId;
  const setOpenBubbleId = useCallback(
    (id: string | null | ((cur: string | null) => string | null)) => {
      const cur = openBubbleIdRef.current;
      const next = typeof id === 'function' ? id(cur) : id;
      if (next === cur) return;
      if (onOpenNote) onOpenNote(next);
      else setInternalOpenId(next);
    },
    [onOpenNote]
  );
  /** 会话历史面板开合（点用户消息气泡弹出；进出场 presence 延迟卸载） */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOrigin, setHistoryOrigin] = useState<{ id: string; sequence: number } | null>(null);
  const historyPresence = usePresence(historyOpen, MOTION.exitMs);
  const historyId = props.historyId ?? sessionId;
  const { favoriteIds, setFavorite } = useHistoryFavorites(historyId);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 角标重测量须等尺寸静默：RO 在面板开/合动画期间逐帧触发，跟随触发会让整个
    // 转录每帧重渲（含 notePos 依赖的行重建）；角标是 16px 圆点，动画期错位 ≤静默窗可接受
    let settle = 0;
    const measure = (): void => setLayoutTick((t) => t + 1);
    const bump = (): void => {
      clearTimeout(settle);
      settle = window.setTimeout(measure, RO_SETTLE_MS);
    };
    // 跟随许可与实际离底是两件事：不跟随时保持阅读位，几何变化仍更新回底入口。
    const syncBottom = (): void => {
      if (!interactionActiveRef.current) return;
      if (virtualizerActiveRef.current &&
        (virtualViewportRef.current.height !== el.clientHeight || virtualViewportRef.current.offset === undefined)) {
        virtualViewportRef.current = {
          offset: Math.max(0, el.scrollTop - virtualBaseOffsetRef.current),
          height: el.clientHeight
        };
        setVirtualTick((tick) => tick + 1);
      }
      if (stickBottomRef.current) {
        scrollController.followBottom();
      }
      setShowJump(!isTranscriptAtBottom(el));
    };
    const ro = new ResizeObserver(() => {
      bump();
      syncBottom();
    });
    ro.observe(el);
    // 内容高度观察（.agent-chat-col）：流式节流落地、折叠思考块展开/收起、异步内容
    // （图片/mermaid/高亮）加载完成、content-visibility 估算结算——这些都只长内容：
    // 不改容器盒（容器 RO 不触发）、scrollTop 不动（无 scroll 事件，onScroll 补钉
    // 不触发）、messages/busy 不变（贴底 effect 不重跑），三个贴底触发器全部漏掉，
    // 视口停在旧底。内容 RO 补上这一路：跟随时补钉，不跟随时同步回底按钮；
    // 相同按钮状态由 React 跳过更新，不 bump 角标重测量，避免流式期逐批补测。
    const content = el.querySelector<HTMLElement>('.agent-chat-col');
    let roContent: ResizeObserver | null = null;
    if (content) {
      roContent = new ResizeObserver(syncBottom);
      roContent.observe(content);
    }
    window.addEventListener('resize', bump);
    return () => {
      clearTimeout(settle);
      ro.disconnect();
      roContent?.disconnect();
      window.removeEventListener('resize', bump);
    };
  }, []);

  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const noteList = notes ?? [];
    if (!noteList.length && !pendingNote) {
      setNotePos((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    const liveIds = new Set(noteList.map((n) => n.id));
    if (pendingNote) liveIds.add(PENDING_NOTE_ID);
    const found = new Set<string>();
    const measured: Record<string, NotePos> = {};
    root.querySelectorAll<HTMLElement>('.msg-note-anchor').forEach((el) => {
      const id = el.getAttribute('data-note-id');
      if (!id || !liveIds.has(id)) return;
      found.add(id);
      const wrap = el.closest<HTMLElement>('[data-mid]');
      if (!wrap) return;
      const r = el.getBoundingClientRect();
      // 会话隐藏 / content-visibility 跳过时矩形为 0：保留上次量位，别写成 0,0
      if (r.width === 0 && r.height === 0) return;
      const w = wrap.getBoundingClientRect();
      measured[id] = { top: r.top - w.top, right: r.right - w.left, wrapW: w.width, wrapH: w.height };
    });
    setNotePos((prev) => {
      const next: Record<string, NotePos> = {};
      for (const id of liveIds) {
        if (id in measured) next[id] = measured[id]!;
        else if (found.has(id) && prev[id]) next[id] = prev[id]!;
      }
      return notePosEqual(prev, next) ? prev : next;
    });
    // clipExtra：窗口回填后新挂载的锚点 span 需要重测量（RO/resize 不覆盖此变化）。
    // P1-1：deps 不含 messages——流式期正文逐批增长不再每批强制量位（新锚点只随
    // notes 下发 / clipExtra 回填出现，两者已在依赖面；终帧校正见 busy 翻转补量）。
  }, [notes, pendingNote, layoutTick, clipExtra]);

  // P1-1 终帧校正：流式期量位被节流后，回合结束（busy 翻 false）补量一次，
  // 让角标落在最终正文位置
  const busyPrevRef = useRef(busy);
  useLayoutEffect(() => {
    if (busyPrevRef.current && !busy) setLayoutTick((t) => t + 1);
    busyPrevRef.current = busy;
  }, [busy]);

  // 点三入口/气泡以外：收起查看气泡；录入气泡直接取消该批注
  useEffect(() => {
    if (!openBubbleId && !pendingNote) return;
    const onDocMousedown = (e: MouseEvent): void => {
      const source = pageForOverlay(scrollRef.current);
      const target = e.target instanceof Element ? pageForOverlay(e.target) : null;
      if (source?.hasAttribute('data-h-peek') || (source && source !== target && target?.hasAttribute('data-h-peek'))) return;
      // 录入中气泡本身（输入框聚焦 / ✓ 保存）：最先豁免，绝不能当成入口或点外
      if (isSessionNotePendingTarget(e.target)) return;
      if (isSessionNoteEntryTarget(e.target)) {
        if (pendingNote) onPendingCancel?.();
        return;
      }
      setOpenBubbleId(null);
      if (pendingNote) onPendingCancel?.();
    };
    document.addEventListener('mousedown', onDocMousedown);
    return () => document.removeEventListener('mousedown', onDocMousedown);
  }, [openBubbleId, pendingNote, onPendingCancel, setOpenBubbleId]);

  // 已保存批注被删（含输入框 token 对账路径）时，收起它的气泡
  useEffect(() => {
    if (openBubbleId && notes && !notes.some((n) => n.id === openBubbleId)) {
      setOpenBubbleId(null);
    }
  }, [notes, openBubbleId, setOpenBubbleId]);

  const displayMessages = useMemo(() => {
    return mapTranscriptMessages({
      messages,
      busy,
      cache: displayCacheRef.current,
      toDisplay: props.model.toDisplay,
      messagesEqual: props.model.messagesEqual,
      // A short recorded burst can be followed by seconds of silence with no trailing render.
      throttleMs: props.replaying ? 0 : STREAM_REMAP_THROTTLE_MS
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toDisplay/messagesEqual 由宿主保证引用稳定
  }, [messages, busy, props.replaying]);

  const turnStops = useMemo(
    () => historyPresence.mounted ? buildTurnRailStops(displayMessages) : [],
    [displayMessages, historyPresence.mounted]
  );
  /** 正在流式的 assistant 下标：busy 时取「最后一条非 queued user 之后」的
   *  最后一条 assistant。插话把 user 垫在旧回复后面时，旧 assistant 折成历史
   *  回合；当前回合 = 插话 + 其后回复。排队消息不算边界。 */
  const activeStreamIdx = useMemo(
    () => locateStreamingAssistantIndex(displayMessages, busy),
    [busy, displayMessages]
  );
  // 当前轮次持续到下一条实际发送的用户消息；排队消息和宿主静默插话不划界。
  // 无用户消息的旧记录无法还原轮次，保守地只将最后一条 assistant 视为当前轮。
  const currentTurnStart = useMemo(() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const m = displayMessages[i]!;
      if (m.role === 'user' && !m.queued && m.steering !== 'host') return i + 1;
    }
    const lastAssistant = locateStreamingAssistantIndex(displayMessages, true);
    return lastAssistant < 0 ? displayMessages.length : lastAssistant;
  }, [displayMessages]);

  // fork 回调保持引用稳定（ChatMessageView 的 memo 对函数身份敏感；
  // 每条消息各建闭包会让空闲期每次 sync 全列表重渲）。queued 的门控在 Hoverbar 内做。
  const forkHandler = onFork && !busy ? onFork : undefined;
  const onNoteClick = useCallback((id: string) => {
    setOpenBubbleId((cur) => (cur === id ? null : id));
  }, []);
  // 失败重试位置：末尾往前找第一条带 error 的 assistant，途中先遇到 user
  //（失败后已有新输入）则不显示——不再要求「恰好是最后一条消息」
  const retryIdx = useMemo(() => {
    if (!onRetry || busy) return -1;
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (isUserTurnMessage(displayMessages[i]!)) return -1;
      if (displayMessages[i]!.role === 'assistant' && displayMessages[i]!.error) return i;
    }
    return -1;
  }, [displayMessages, busy, onRetry]);
  // 终止消息重新编辑位置：末轮为 aborted assistant 时，定位对应的用户消息下标
  const editAbortedIdx = useMemo(() => {
    if (!onEditAborted || busy) return -1;
    const loc = locateAbortedTurn(displayMessages);
    return loc ? loc.userIdx : -1;
  }, [displayMessages, busy, onEditAborted]);

  const findQuery = props.findQuery ?? '';
  const findActive = props.findActive ?? null;
  const findApplyTimerRef = useRef<number | null>(null);
  const findRevealTimerRef = useRef<number | null>(null);
  const findScheduledAtRef = useRef(0);
  const findScheduledQueryRef = useRef('');

  const paintFindMarks = useCallback(
    (scroll: boolean): void => {
      const root = scrollRef.current;
      if (!root) return;
      if (!findQuery.trim()) {
        clearChatFindMarks(root);
        return;
      }
      const activeEl = applyChatFindMarks(root, findQuery, findActive);
      if (!scroll) return;
      const target =
        activeEl ??
        (findActive
          ? root.querySelector<HTMLElement>(`[data-mid="${findActive.messageId}"]`)
          : null);
      if (target) {
        if (activeEl && findActive) {
          const messageId = findActive.messageId;
          let liveTarget: HTMLElement | null = activeEl;
          // Streaming refresh replaces mark DOM without changing the active hit.
          // Re-resolve its stable identity instead of ending at a detached mark.
          navigateToElement(() => {
            if (liveTarget?.isConnected && root.contains(liveTarget)) return liveTarget;
            liveTarget = root.querySelector<HTMLElement>(`[data-mid="${CSS.escape(messageId)}"] mark.chat-find-hit.is-active`);
            return liveTarget;
          }, true);
        } else navigateToElement(target, true);
      }
    },
    [findQuery, findActive, navigateToElement]
  );

  useLayoutEffect(() => {
    paintFindMarks(true);
    // progressTick：渐进扩批放行的新行也要重刷 mark（含滚动到命中）
  }, [paintFindMarks, clipExtra, progressTick, sessionId, virtualTick]);

  // 定时器闭包经 ref 间接调用最新 painter：在途定时器若捕获调度那一刻的
  // paintFindMarks（依赖 findQuery/findActive），触发时会把 is-active 弹回旧命中、
  // 或在查询已清空后把 mark「复活」——防抖窗口内的导航/清空都必须用最新值。
  const paintFindMarksRef = useRef(paintFindMarks);
  paintFindMarksRef.current = paintFindMarks;

  useLayoutEffect(() => {
    // 清空查询/失主（跨会话跳转让渡）：撤掉在途重刷。mark 的同步清除由上面的
    // 即时 effect（paintFindMarks(true) 对空查询走 clearChatFindMarks）负责。
    if (!findQuery.trim()) {
      if (findApplyTimerRef.current != null) {
        window.clearTimeout(findApplyTimerRef.current);
        findApplyTimerRef.current = null;
      }
      return;
    }
    // 防抖 160ms 之外加最长等待：流式期间 delta 间隔小于防抖窗会不断重排定时器，
    // mark 一直不重建（而 markdown 重渲还会把手插的 mark 抹掉）。同查询在途且未饿
    // 死就不重排；查询变化（打字）或等待超时才重排，保证流式期间也能周期性重刷。
    const pending = findApplyTimerRef.current != null;
    const freshPending =
      pending &&
      findScheduledQueryRef.current === findQuery &&
      Date.now() - findScheduledAtRef.current < FIND_MARK_MAX_WAIT_MS;
    if (freshPending) return;
    if (findApplyTimerRef.current != null) window.clearTimeout(findApplyTimerRef.current);
    findScheduledAtRef.current = Date.now();
    findScheduledQueryRef.current = findQuery;
    findApplyTimerRef.current = window.setTimeout(() => {
      findApplyTimerRef.current = null;
      paintFindMarksRef.current(false);
    }, FIND_MARK_DEBOUNCE_MS);
  }, [displayMessages, findQuery]);

  useEffect(
    () => () => {
      if (findApplyTimerRef.current != null) window.clearTimeout(findApplyTimerRef.current);
      if (findRevealTimerRef.current != null) window.clearTimeout(findRevealTimerRef.current);
    },
    []
  );

  // 查找命中落在裁剪窗外时扩窗（与历史面板 clip-reveal 同口径）
  useEffect(() => {
    const id = findActive?.messageId;
    if (!id) return;
    let idx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.id === id) {
        idx = i;
        break;
      }
    }
    const streamLen =
      displayMessages.length + (props.compactions ?? EMPTY_COMPACTION_MARKERS).length;
    const need = Math.max(0, streamLen - idx + 8 - TRANSCRIPT_CLIP_WINDOW);
    // 渐进期未挂满时命中旧行：预算放行到挂满再扩窗（mark/滚动落在新挂行上）；
    // 显式查找优先于阅读位置恢复
    // Search can return a message whose body has been evicted. Use the same
    // range-loading reveal path as explicit history navigation before looking
    // for its row; requiring an existing row would silently strand that hit.
    if (idx < 0 || virtualizerActiveRef.current) {
      pendingRestoreRef.current = null;
      if (findRevealTimerRef.current != null) window.clearTimeout(findRevealTimerRef.current);
      findRevealTimerRef.current = window.setTimeout(() => {
        findRevealTimerRef.current = null;
        scrollRef.current?.dispatchEvent(new CustomEvent(CLIP_REVEAL_EVENT, { detail: id }));
      }, 0);
      return () => {
        if (findRevealTimerRef.current != null) {
          window.clearTimeout(findRevealTimerRef.current);
          findRevealTimerRef.current = null;
        }
      };
    }
    if (progressiveRef.current.budget !== Infinity) {
      progressiveRef.current.budget = Infinity;
      setProgressTick((n) => n + 1);
    }
    pendingRestoreRef.current = null;
    setClipExtra((cur) => (cur >= need ? cur : need));
  }, [findActive?.messageId, messages, displayMessages.length, props.compactions]);

  // P2-1③：interleave 提独立 memo——renderedWindow 其它依赖（layoutTick/notePos/
  // openBubbleId 等）变化不再重跑消息×分割线交错；markers 为空且引用未变时直接复用
  const stream = useMemo(
    () =>
      transcriptRows(displayMessages, props.compactions ?? EMPTY_COMPACTION_MARKERS, props.page),
    [displayMessages, props.compactions, props.page]
  );

  const measuredVirtualizerActive = stream.length > MEASURED_VIRTUALIZER_THRESHOLD || (stream.sparse && stream.length > displayMessages.length);
  useLayoutEffect(() => {
    if (!measuredVirtualizerActive) {
      virtualAnchorRef.current = null;
      return;
    }
    if (props.interactionActive === false || stickBottomRef.current || virtualViewportRef.current.height > 0) return;
    const el = scrollRef.current;
    if (!el) return;
    virtualViewportRef.current = {
      offset: Math.max(0, el.scrollTop - virtualBaseOffsetRef.current),
      height: el.clientHeight || 600
    };
    setVirtualTick((tick) => tick + 1);
  }, [measuredVirtualizerActive, sessionId, props.interactionActive]);

  const renderedWindow = useMemo(
    () => {
      // 窗口裁剪：超长会话只渲染尾部窗口（消息 + 分割线一起按 stream 位置裁，
      // 分割线随所在区段挂载/卸载）；clipStart>0 时顶部出「加载更早」回填入口。
      // 小会话（<= 阈值）clipStart 恒 0，零行为差异
      virtualizerActiveRef.current = measuredVirtualizerActive;
      const clipRange = resolveTranscriptClipRange({
        streamLength: stream.length,
        messageCount: displayMessages.length,
        clipExtra,
        clipThreshold: TRANSCRIPT_CLIP_THRESHOLD,
        clipWindow: TRANSCRIPT_CLIP_WINDOW,
        measuredVirtualizerActive,
        stickBottom: stickBottomRef.current,
        frozenClipStart: frozenClipStartRef.current
      });
      let clipStart = clipRange.clipStart;
      frozenClipStartRef.current = clipRange.frozenClipStart;
      // 首开渐进预算：换会话先重置占位；首个非空拍（重挂时 attach 的历史
      // 到达）按 parts 总量决定是否启用。reveal/查找/历史跳转会把预算直接
      // 放行到挂满。
      if (progressiveRef.current.sid !== sessionId) {
        progressiveRef.current = { sid: sessionId, budget: Infinity, decided: false };
      }
      if (displayMessages.length > 0 && !progressiveRef.current.decided) {
        let partsTotal = 0;
        for (let i = 0; i < displayMessages.length; i++) {
          partsTotal += displayMessages[i]!.parts?.length ?? 1;
        }
        progressiveRef.current = {
          sid: sessionId,
          decided: true,
          budget:
            partsTotal > PROGRESSIVE_PARTS_THRESHOLD ? PROGRESSIVE_FIRST_PARTS : Infinity
        };
      }
      let renderFrom = clipStart;
      let renderTo = stream.length;
      let virtual: MeasuredVirtualizerResult | null = null;
      let nextProgressBudget = 0;
      if (measuredVirtualizerActive) {
        virtual = computeVirtualWindow({
          total: stream.length,
          viewport: {
            offset: virtualViewportRef.current.height > 0 ? virtualViewportRef.current.offset : undefined,
            height: virtualViewportRef.current.height > 0 ? virtualViewportRef.current.height : 600
          },
          estimatedRowHeight: 96,
          rowGap: MEASURED_VIRTUALIZER_ROW_GAP,
          measuredHeights: virtualMeasuredHeightsRef.current,
          measuredMargins: virtualMeasuredMarginsRef.current,
          overscan: MEASURED_VIRTUALIZER_OVERSCAN,
          maxWindow: TRANSCRIPT_CLIP_WINDOW,
          direction: stickBottomRef.current ? 'tail' : 'forward'
        });
        renderFrom = virtual.window.start;
        renderTo = virtual.window.end;
        clipStart = renderFrom;
      } else if (progressiveRef.current.budget !== Infinity) {
        const progressive = resolveProgressiveRange({
          items: {
            length: stream.length,
            get: index => {
              const item = stream.get(index);
              if (!item) return undefined;
              return item.kind === 'message'
                ? { kind: 'message', partCount: item.message.parts?.length ?? 1 }
                : { kind: item.kind };
            }
          },
          clipStart,
          budget: progressiveRef.current.budget
        });
        renderFrom = progressive.renderFrom;
        nextProgressBudget = progressive.nextProgressBudget;
      }
      // 时间衰减基准：本轮 memo 求值取一次 now（无独立计时器，见 shared/chatStaleTurn.ts）
      const now = Date.now();
      const surfaceKind = props.avatarContext?.surfaceKind ?? 'gui-session';
      const harness = props.harness;
      // 注入卡（§6.1）：只在代际首次生效/变化的用户回合出卡（每轮重复显示已废弃）。
      // 解析按原始消息（ts/steering 在视图映射后丢失，createdAt/气泡形态都不是原始语义）
      const injCards =
        harness?.on && harness.injections?.length
          ? resolveInjectionCards(
              messages as ReadonlyArray<{ id: string; role: string; ts?: number; steering?: unknown }>,
              harness.injections
            )
          : undefined;
      let prevForAvatar: ChatMessage | undefined;
      /** 本回合（自最近一条用户消息起）的插话条数：详情抽屉 summary 行用 */
      let steersInTurn = 0;
      const rows = stream.slice(renderFrom, renderTo).map((item, relativeIndex) => {
        const streamIndex = renderFrom + relativeIndex;
        if (item.kind === 'gap') return <div key={`gap:${streamIndex}`} data-stream-index={streamIndex} data-history-gap={item.hidden ? 'hidden' : streamIndex}
          aria-hidden="true" style={{ height: item.hidden ? 0 : (virtualMeasuredHeightsRef.current[String(streamIndex)] ?? 96), flexShrink: 0 }} />;
        if (item.kind === 'compaction') {
          prevForAvatar = undefined;
          // 透明模式开启时压缩分隔换 §6.4 样式（⇡ 黄 + hairline 夹文案；规模数字来自压缩结果）
          return harness?.on && item.marker.status === 'complete' ? (
            <HarnessCompactDivider
              streamIndex={streamIndex}
              key={`compact:${item.marker.id}`}
              tokensBefore={item.marker.tokensBefore}
              tokensAfter={item.marker.tokensAfter}
            />
          ) : (
            <CompactDivider
              key={`compact:${item.marker.id}`}
              status={item.marker.status}
              streamIndex={streamIndex}
            />
          );
        }
        const m = item.message;
        const i = item.srcIndex;
        const src = messages[i];
        // 插话线（§6.2）：开启态插话消息不渲染气泡，整行替换为紫线标注（不进锚点/停靠点）
        const steering = harness?.on && src ? props.model.steeringOf?.(src) : undefined;
        if (steering) {
          prevForAvatar = undefined;
          steersInTurn += 1;
          return (
            // 外层锚点保 data-mid：'send' 插话仍是历史停靠点，开启态渲染为线后
            // 跳转/clip-reveal 仍能定位（无锚点会静默失效）
            <div className="chat-turn-anchor" key={m.id} data-mid={m.id} data-stream-index={streamIndex} data-role={m.role}>
              <HarnessSteerLine text={m.content} ts={m.createdAt} />
            </div>
          );
        }
        const prevTs = i === 0 ? null : displayMessages[i - 1]!.createdAt;
        const showSep = shouldShowTimeSeparator(prevTs, m.createdAt);
        const omitAvatar = shouldOmitRepeatedAvatar(
          prevForAvatar,
          m,
          surfaceKind,
          showSep
        );
        prevForAvatar = m;
        const timeLabel = formatChatTimeLabel(m.createdAt);
        if (m.role === 'user') steersInTurn = 0;
        let cards: TranscriptInlineCards | null = null;
        if (src && props.model.getInlineCards) {
          const equal = props.model.messagesEqual;
          const cHit = cardsCacheRef.current.get(m.id);
          if (cHit && (cHit.src === src || (equal ? equal(cHit.src, src) : false))) {
            cards = cHit.out;
          } else {
            cards = props.model.getInlineCards(src);
            cardsCacheRef.current.set(m.id, { src, out: cards });
          }
        }
        const notesCache = msgNotesCacheRef.current;
        if (notesCache.src !== notes) {
          notesCache.src = notes ?? undefined;
          notesCache.byMsg.clear();
        }
        let msgNotes = notesCache.byMsg.get(m.id);
        if (!msgNotes) {
          msgNotes = (notes ?? []).filter((n) => n.messageId === m.id);
          if (msgNotes.length) notesCache.byMsg.set(m.id, msgNotes);
        }
        const noteOpenHere = msgNotes.some((n) => n.id === openBubbleId);
        const showPending = pendingNote && pendingNote.messageId === m.id;
        // 时间衰减只适用于历史回合，当前轮跨过 24h 也保留全部正文。
        const staleTurn =
          !props.replaying && m.role === 'assistant' && i < currentTurnStart && isStaleTurn(m.createdAt, now);
        const engineInputRef = harness?.on && src ? props.model.engineInputRefOf?.(src) : undefined;
        const loadEngineInput = engineInputRef ? harness?.engineInput : undefined;
        // Prefer the captured sent text and use a snapshot for older rows.
        const injCard = loadEngineInput ? undefined : injCards?.get(m.id);
        // assistant 回合的计量（chips + 抽屉）
        const hSumRaw = harness?.on && src ? props.model.harnessOf?.(src) : undefined;
        // B1-5/B1-6：hSum 与 hMetrics 一并走消息级缓存——src 克隆会让 hSum 引用
        // 每次事件都换新，不缓存的话行 deps 永不失配（HarnessDrawer/chips 都用它）
        let hSum: GuiHarnessSummary | undefined;
        let hMetrics: HarnessTurnMetrics | undefined;
        if (hSumRaw && src) {
          const hEqual = props.model.messagesEqual;
          const hHit = hMetricsCacheRef.current.get(m.id);
          if (hHit && (hHit.src === src || (hEqual ? hEqual(hHit.src, src) : false))) {
            hSum = hHit.sum;
            hMetrics = hHit.out;
          } else {
            hSum = hSumRaw;
            hMetrics = hSumRaw.usage
              ? {
                  inputTokens: hSumRaw.usage.inputTokens,
                  outputTokens: hSumRaw.usage.outputTokens,
                  ...(hSumRaw.usage.reasoningTokens
                    ? { reasoningTokens: hSumRaw.usage.reasoningTokens }
                    : {}),
                  ...(hSumRaw.durationMs !== undefined ? { durationMs: hSumRaw.durationMs } : {})
                }
              : undefined;
            hMetricsCacheRef.current.set(m.id, { src, out: hMetrics, sum: hSum });
          }
        }
        // ── B1-6 行级元素缓存：行渲染消费的全部自由变量逐槽快照（原始值按值、
        // 对象/回调按引用），与缓存 deps 全等即复用旧 element——React 对同引用
        // 元素跳过整棵子树调和。槽位必须穷尽：行内新消费自由变量必须同步进 deps
        //（行级失效用例守护）。回滚=退回单 useMemo 整窗。 ──
        const streamingProp = i === activeStreamIdx && m.role === 'assistant';
        const collapsedTurn = m.role === 'assistant' && i < currentTurnStart;
        const activityOnly = m.role === 'assistant' && !busy && !collapsedTurn && !!m.parts?.length;
        const historyPrompt = getTurnRailPrompt(m);
        const favorited = historyPrompt ? favoriteIds.has(m.id) : undefined;
        const setMessageFavorite = historyPrompt ? setFavorite : undefined;
        const forceFoldOpen = findActive?.messageId === m.id;
        const notesResolved = msgNotes.length ? msgNotes : undefined;
        const openNoteIdResolved = noteOpenHere ? openBubbleId : undefined;
        const noteClickResolved = msgNotes.length ? onNoteClick : undefined;
        const editAbortedResolved = i === editAbortedIdx ? onEditAborted : undefined;
        const retryResolved = i === retryIdx ? onRetry : undefined;
        const cancelResolved = onCancelQueued && m.queued ? onCancelQueued : undefined;
        const planResolved = onPlanAction && m.plan ? onPlanAction : undefined;
        const planDisabledResolved = planActionDisabled ?? busy;
        const pendingPos = showPending ? notePos[PENDING_NOTE_ID] : undefined;
        const deps: unknown[] = [
          sessionId, props.page?.generation,
          m, streamIndex, item.decorations, streamingProp, collapsedTurn, activityOnly, staleTurn, forceFoldOpen,
          timeLabel, showSep, omitAvatar, favorited, setMessageFavorite,
          cwd, props.avatarContext, forkHandler, editAbortedResolved, notesResolved, noteClickResolved,
          openNoteIdResolved, retryResolved, cancelResolved, planResolved,
          planDisabledResolved, mode, onFileLink, cards, hMetrics,
          injCard, hSum, steersInTurn, engineInputRef, loadEngineInput, t, onNoteUpdate, onNoteDelete,
          notes, pendingNote, pendingPos, onPendingConfirm, onPendingCancel, busy,
          setOpenBubbleId
        ];
        for (const n of msgNotes) deps.push(n, notePos[n.id]);
        const cachedRow = rowCacheRef.current.get(m.id);
        if (cachedRow && rowDepsEqual(cachedRow.deps, deps)) return cachedRow.el;
        const el = (
          <React.Fragment key={m.id}>
            {/* data-mid 锚点：会话历史面板跳转按 id 找消息（包一层不影响 quiet 布局）；
                data-role：批注只允许 AI 回复（划词动作侧校验）；批注卡片绝对定位于这层。
                在停靠点内的用户消息整块右键 → 弹出会话历史面板（左键易误触，2026-09-09 改右键） */}
            <div
              className={`chat-turn-anchor${
                historyPrompt ? ' is-history-trigger' : ''
              }${omitAvatar ? ' is-continued' : ''}`}
              data-mid={m.id}
              data-stream-index={streamIndex}
              data-role={m.host ? 'host' : m.source === 'scheduler' ? 'scheduler' : m.source === 'agent' ? 'agent' : m.role}
              onContextMenu={
                historyPrompt
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setHistoryOrigin((previous) => ({ id: m.id, sequence: (previous?.sequence ?? 0) + 1 }));
                      setHistoryOpen(true);
                    }
                  : undefined
              }
            >
              {showSep && timeLabel ? (
                <div className="chat-time-sep chat-time-sep-in-row" aria-hidden>
                  <span>{timeLabel}</span>
                </div>
              ) : null}
              <ChatMessageView
                transcriptKey={`${sessionId}:${props.page?.generation ?? 0}`}
                message={m}
                streaming={streamingProp}
                timeLabel={timeLabel}
                quiet
                cwd={cwd}
                omitAvatar={omitAvatar}
                avatarContext={props.avatarContext}
                favorited={favorited}
                onToggleFavorite={historyPrompt && setMessageFavorite
                  ? () => { setMessageFavorite(historyPrompt, !favorited); }
                  : undefined}
                onFork={forkHandler}
                onEditAborted={editAbortedResolved}
                notes={notesResolved}
                onNoteClick={noteClickResolved}
                openNoteId={openNoteIdResolved}
                onRetry={retryResolved}
                onCancelQueued={
                  cancelResolved ? () => onCancelQueued!(m.id) : undefined
                }
                onPlanAction={planResolved}
                planActionDisabled={planDisabledResolved}
                planMode={mode}
                onFileLink={onFileLink}
                inlineApproval={cards?.approval}
                approvalAnchor={cards?.approvalAnchor}
                inlineUserQuestion={cards?.question}
                questionAnchor={cards?.questionAnchor}
                collapsedTurn={collapsedTurn}
                activityOnly={activityOnly}
                forceFoldOpen={forceFoldOpen}
                staleTurn={staleTurn}
                harnessMetrics={hMetrics}
                engineInputRef={engineInputRef}
                loadEngineInput={loadEngineInput}
              />
              {injCard ? <HarnessInjectCard snapshot={injCard.snapshot} change={injCard.change} loadDetails={harness?.injectionDetails} /> : null}
              {cards?.changes}
              {hSum ? <HarnessDrawer summary={hSum} steerCount={steersInTurn} /> : null}
              {msgNotes.map((n, noteIdx) => {
                const p = notePos[n.id];
                const open = openBubbleId === n.id;
                return (
                  <React.Fragment key={n.id}>
                    <button
                      type="button"
                      className={`msg-note-badge${open ? ' is-open' : ''}${p ? '' : ' is-from-bar'}`}
                      data-note-entry=""
                      style={
                        p
                          ? {
                              top: p.top - 9,
                              left: Math.min(p.right + 2, p.wrapW - 20)
                            }
                          : ({ ['--note-i']: noteIdx } as React.CSSProperties)
                      }
                      aria-label={t('批注 {{n}}', { n: n.seq })}
                      onClick={() => setOpenBubbleId((cur) => (cur === n.id ? null : n.id))}
                    >
                      {n.seq}
                    </button>
                    {open ? (
                      <NoteBubble
                        mode="edit"
                        initial={n.note}
                        pos={p ? noteBubblePos(p) : undefined}
                        fromBar={!p}
                        onSave={(text) => {
                          onNoteUpdate?.(n.id, text);
                          setOpenBubbleId(null);
                        }}
                        onDelete={() => onNoteDelete?.(n.id)}
                        onCancel={() => setOpenBubbleId(null)}
                      />
                    ) : null}
                  </React.Fragment>
                );
              })}
              {showPending && notePos[PENDING_NOTE_ID] ? (
                <>
                  <span
                    className="msg-note-badge is-pending"
                    data-note-entry=""
                    style={{
                      top: notePos[PENDING_NOTE_ID]!.top - 9,
                      left: Math.min(
                        notePos[PENDING_NOTE_ID]!.right + 2,
                        notePos[PENDING_NOTE_ID]!.wrapW - 20
                      )
                    }}
                  >
                    {nextNoteSeq((notes ?? []).map((x) => x.seq))}
                  </span>
                  <NoteBubble
                    mode="create"
                    pending
                    initial=""
                    pos={noteBubblePos(notePos[PENDING_NOTE_ID]!)}
                    onSave={onPendingConfirm!}
                    onCancel={onPendingCancel!}
                  />
                </>
              ) : null}
              {item.decorations?.map(marker => <CompactDivider key={`compact:${marker.id}`} status={marker.status} />)}
            </div>
          </React.Fragment>
        );
        rowCacheRef.current.set(m.id, { deps, el });
        return el;
      });
      // 剪枝已删除消息的卡缓存（与 displayCache 同口径，防泄漏）
      const seenIds = new Set(displayMessages.map((m) => m.id));
      for (const id of cardsCacheRef.current.keys()) {
        if (!seenIds.has(id)) cardsCacheRef.current.delete(id);
      }
      // hMetricsCacheRef 同口径剪枝（chat-transcript F-01）：只在 set 从不删，
      // clear()/撤轮/压缩替换后旧消息 id 的条目（含 src 消息引用）会永久残留
      for (const id of hMetricsCacheRef.current.keys()) {
        if (!seenIds.has(id)) hMetricsCacheRef.current.delete(id);
      }
      for (const id of rowCacheRef.current.keys()) {
        if (!seenIds.has(id)) rowCacheRef.current.delete(id);
      }
      return {
        rows,
        clipStart,
        nextProgressBudget,
        progressDone: renderFrom <= clipStart,
        virtual
      };
    },
    [
      displayMessages,
      sessionId,
      props.page?.generation,
      messages,
      busy,
      cwd,
      clipExtra,
      progressTick,
      forkHandler,
      editAbortedIdx,
      onEditAborted,
      onNoteClick,
      setOpenBubbleId,
      retryIdx,
      onRetry,
      onCancelQueued,
      onPlanAction,
      planActionDisabled,
      mode,
      onFileLink,
      activeStreamIdx,
      currentTurnStart,
      props.replaying,
      notes,
      pendingNote,
      notePos,
      openBubbleId,
      onNoteUpdate,
      onNoteDelete,
      onPendingConfirm,
      onPendingCancel,
      favoriteIds,
      setFavorite,
      props.model,
      stream,
      props.harness,
      props.avatarContext,
      findActive,
      t,
      virtualTick
    ]
  );
  clipStartRef.current = renderedWindow.clipStart;
  virtualResultRef.current = renderedWindow.virtual;
  if (renderedWindow.virtual?.anchor) {
    const anchorItem = stream.get(renderedWindow.virtual.anchor.index);
    if (anchorItem && anchorItem.kind !== 'gap') {
      virtualAnchorRef.current = {
        key: anchorItem.kind === 'message' ? `m:${anchorItem.message.id}` : `c:${anchorItem.marker.id}`,
        offset: renderedWindow.virtual.anchor.offset
      };
    }
  }
  const virtualRowsKey = renderedWindow.virtual
    ? [
        renderedWindow.virtual.window.start,
        renderedWindow.virtual.window.end,
        Math.round(renderedWindow.virtual.beforeHeight),
        ...stream
          .slice(renderedWindow.virtual.window.start, renderedWindow.virtual.window.end)
          .map((item) => item.kind === 'message'
            ? `m:${item.message.id}`
            : item.kind === 'compaction' ? `c:${item.marker.id}:${item.marker.status}` : `gap:${item.index}:${item.hidden}`)
      ].join(':')
    : '';

  // Absolute sparse coordinates survive payload eviction. Fetch gaps in either
  // direction and retain the viewport plus a bounded live tail.
  useEffect(() => {
    const virtual = renderedWindow.virtual;
    if (!props.onVirtualWindow || !virtual || props.interactionActive === false) return;
    if (stream.sparse) {
      props.onVirtualWindow({ ...virtual.window, anchorIndex: virtual.anchor?.index });
      return;
    }
    let start = displayMessages.length;
    let end = 0;
    for (const item of stream.slice(virtual.window.start, virtual.window.end)) {
      if (item.kind !== 'message') continue;
      start = Math.min(start, props.messageIndex?.(item.message.id) ?? item.srcIndex);
      end = Math.max(end, (props.messageIndex?.(item.message.id) ?? item.srcIndex) + 1);
    }
    if (start < end) props.onVirtualWindow({ start, end });
  }, [displayMessages.length, props.onVirtualWindow, props.interactionActive, renderedWindow.virtual, stream]);

  // Measure mounted rows after each window commit. The map is sparse, so rows
  // outside the current window never require DOM nodes and retain their last
  // known height for spacer calculations.
  useLayoutEffect(() => {
    if (!renderedWindow.virtual || props.interactionActive === false) return;
    const virtual = renderedWindow.virtual;
    const root = scrollRef.current;
    if (!root) return;
    const syncVirtualBase = (): void => {
      const firstRow = root.querySelector<HTMLElement>('[data-stream-index]');
      if (!firstRow) return;
      const firstRowStyle = window.getComputedStyle(firstRow);
      const firstRowMarginTop = Number.parseFloat(firstRowStyle.marginTop) || 0;
      const base = Math.max(
        0,
        firstRow.getBoundingClientRect().top - root.getBoundingClientRect().top +
          root.scrollTop - virtual.beforeHeight -
          (virtual.window.start > 0 ? MEASURED_VIRTUALIZER_ROW_GAP : 0) -
          firstRowMarginTop
      );
      if (Math.abs(base - virtualBaseOffsetRef.current) > 0.5) {
        virtualBaseOffsetRef.current = base;
        virtualViewportRef.current = {
          offset: Math.max(0, root.scrollTop - base),
          height: root.clientHeight
        };
        setVirtualTick((tick) => tick + 1);
      }
    };
    syncVirtualBase();
    const observer = new ResizeObserver((entries) => {
      // Hidden keep-alive tabs report zero geometry. Those observations are not
      // real row measurements and must not destroy the retained scroll model.
      if (!interactionActiveRef.current || root.clientHeight <= 0) return;
      let changed = false;
      const previous = virtualMeasuredHeightsRef.current;
      const previousMargins = virtualMeasuredMarginsRef.current;
      const next = { ...previous };
      const nextMargins = { ...previousMargins };
      const geometryChanged = (before: number | undefined, after: number): boolean =>
        before === undefined || Math.abs(before - after) > 0.25;
      for (const entry of entries) {
        const index = entry.target instanceof HTMLElement
          ? entry.target.dataset.streamIndex
          : undefined;
        const element = entry.target instanceof HTMLElement ? entry.target : null;
        const style = element ? window.getComputedStyle(element) : null;
        const margin = style
          ? (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0)
          : 0;
        const marginTop = style ? Number.parseFloat(style.marginTop) || 0 : 0;
        // A continuation row can have a negative top margin larger than its
        // content box. Keep a small positive footprint so it remains in the
        // sparse model instead of falling back to the 96px estimate forever.
        const height = Math.max(0.5, entry.contentRect.height + margin);
        if (index == null || !Number.isFinite(height)) continue;
        if (geometryChanged(next[index], height) || geometryChanged(nextMargins[index], marginTop)) {
          next[index] = height;
          nextMargins[index] = marginTop;
          changed = true;
        }
      }
      if (changed) {
        const currentVirtual = virtualResultRef.current;
        if (!stickBottomRef.current && currentVirtual?.anchor) {
          const root = scrollRef.current;
          const compensation = root
            ? computeAnchorCompensation({
                anchor: currentVirtual.anchor,
                estimatedRowHeight: currentVirtual.estimatedRowHeight,
                previousMeasuredHeights: previous,
                nextMeasuredHeights: next,
                scrollOffset: root.scrollTop
              })
            : null;
          if (root && compensation && compensation.scrollAdjustment !== 0) {
            root.scrollTop = compensation.scrollOffset ?? root.scrollTop;
            lastScrollTopRef.current = root.scrollTop;
            virtualViewportRef.current = {
              offset: Math.max(0, root.scrollTop - virtualBaseOffsetRef.current),
              height: root.clientHeight
            };
          }
        }
        virtualMeasuredHeightsRef.current = next;
        virtualMeasuredMarginsRef.current = nextMargins;
        syncVirtualBase();
        setVirtualTick((tick) => tick + 1);
      }
    });
    root.querySelectorAll<HTMLElement>('[data-stream-index]').forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [virtualRowsKey, sessionId, props.interactionActive]);

  useLayoutEffect(() => {
    const markers = (props.compactions ?? EMPTY_COMPACTION_MARKERS)
      .map((marker) => `${marker.id}:${marker.createdAt}`)
      .join('|');
    const middleIndex = Math.floor(displayMessages.length / 2);
    const next = {
      head: displayMessages[0]?.id ?? null,
      middle: displayMessages[middleIndex]?.id ?? null,
      tail: displayMessages.at(-1)?.id ?? null,
      length: displayMessages.length,
      markers
    };
    const previous = virtualProjectionRef.current;
    if (stream.sparse) return;
    const replaced = previous && (
      previous.head !== next.head ||
      previous.length > next.length ||
      previous.markers !== next.markers ||
      (previous.length === next.length && previous.middle !== next.middle)
    );
    virtualProjectionRef.current = next;
    if (!replaced) return;
    const prependAnchor = virtualizerActiveRef.current && previous &&
      next.length > previous.length && next.head !== previous.head
      ? clipAnchorRef.current
      : null;
    const anchorId = prependAnchor?.id;
    const anchorIndex = anchorId
      ? stream.findIndex((item) => item.kind === 'message' && item.message.id === anchorId)
      : -1;
    const preservedKey = prependAnchor?.visible
      ? `m:${anchorId}`
      : virtualizerActiveRef.current && !stickBottomRef.current ? virtualAnchorRef.current?.key : undefined;
    const preservedIndex = preservedKey
      ? stream.findIndex((item) => item.kind === 'message'
        ? `m:${item.message.id}` === preservedKey
        : item.kind === 'compaction' && `c:${item.marker.id}` === preservedKey)
      : -1;
    if (anchorIndex >= 0 && prependAnchor?.visible) {
      const height = virtualViewportRef.current.height > 0 ? virtualViewportRef.current.height : 600;
      const target = computeVirtualWindow({
        total: stream.length,
        viewport: { offset: virtualViewportRef.current.offset, height },
        estimatedRowHeight: 96,
        rowGap: MEASURED_VIRTUALIZER_ROW_GAP,
        measuredHeights: {},
        overscan: MEASURED_VIRTUALIZER_OVERSCAN,
        maxWindow: TRANSCRIPT_CLIP_WINDOW,
        anchor: { index: anchorIndex, offset: -prependAnchor.visible.offset },
        direction: 'forward'
      });
      virtualMeasuredHeightsRef.current = {};
      virtualMeasuredMarginsRef.current = {};
      virtualViewportRef.current = { offset: target.scrollOffset, height };
      virtualBaseOffsetRef.current = 0;
      setVirtualTick((tick) => tick + 1);
      return;
    }
    if (preservedIndex >= 0 && virtualAnchorRef.current) {
      const height = virtualViewportRef.current.height > 0 ? virtualViewportRef.current.height : 600;
      const base = virtualBaseOffsetRef.current;
      const root = scrollRef.current;
      if (root && !clipAnchorRef.current) {
        const visible = visibleTranscriptAnchor(root);
        if (visible) {
          clipAnchorRef.current = {
            height: root.scrollHeight,
            top: root.scrollTop,
            visible,
            id: visible.node.dataset.mid ?? null
          };
        }
      }
      const target = computeVirtualWindow({
        total: stream.length,
        viewport: { offset: virtualViewportRef.current.offset, height },
        estimatedRowHeight: 96,
        rowGap: MEASURED_VIRTUALIZER_ROW_GAP,
        measuredHeights: {},
        measuredMargins: {},
        overscan: MEASURED_VIRTUALIZER_OVERSCAN,
        maxWindow: TRANSCRIPT_CLIP_WINDOW,
        anchor: { index: preservedIndex, offset: virtualAnchorRef.current.offset },
        direction: 'forward'
      });
      virtualMeasuredHeightsRef.current = {};
      virtualMeasuredMarginsRef.current = {};
      virtualViewportRef.current = { offset: target.scrollOffset, height };
      if (root) {
        root.scrollTop = Math.max(0, base + target.scrollOffset);
        lastScrollTopRef.current = root.scrollTop;
      }
      setVirtualTick((tick) => tick + 1);
      return;
    }
    virtualMeasuredHeightsRef.current = {};
    virtualMeasuredMarginsRef.current = {};
    virtualViewportRef.current = { height: 0 };
    virtualBaseOffsetRef.current = 0;
    setVirtualTick((tick) => tick + 1);
  }, [displayMessages, props.compactions, sessionId]);

  // A parts budget is not a viewport budget: hundreds of folded tools may leave
  // just one short reply. Fill the first viewport before paint, then let older
  // history keep its frame budget. Doubling avoids repeated empty commits when
  // the next whole message costs more than a normal progressive step.
  useLayoutEffect(() => {
    if (!initialViewportPendingRef.current || props.interactionActive === false) return;
    const el = scrollRef.current;
    if (!el || el.clientHeight <= 0) return;
    if (!stickBottomRef.current || pendingRestoreRef.current) {
      initialViewportPendingRef.current = false;
      return;
    }
    syncChatSurfaceLayout(el.closest<HTMLElement>('.chat-surface-view'));
    initialLayoutCleanupRef.current?.();
    initialLayoutCleanupRef.current = prepareTranscriptBottom(el);
    scrollController.followBottom(true);
    if (!renderedWindow.progressDone && el.scrollHeight <= el.clientHeight) {
      progressiveRef.current.budget = Math.max(progressiveRef.current.budget * 2, renderedWindow.nextProgressBudget);
      setProgressTick(n => n + 1);
    } else {
      initialViewportPendingRef.current = false;
    }
  }, [renderedWindow, props.interactionActive, scrollController]);

  // A remounted long session may restore an anchor that is outside the initial
  // tail window. Seed the measured range from that durable row before the
  // absolute fallback runs, so variable row heights do not clamp the reader to
  // the first rendered window.
  useLayoutEffect(() => {
    const mem = pendingRestoreRef.current;
    if (!mem || !renderedWindow.virtual || !mem.anchorMid) return;
    const anchorIndex = stream.findIndex(
      (item) => item.kind === 'message' && item.message.id === mem.anchorMid
    );
    if (anchorIndex < 0) {
      const ensure = props.onEnsureMessageLoaded;
      if (stream.sparse && ensure && restoreRequestRef.current !== mem.anchorMid) {
        const id = mem.anchorMid;
        restoreRequestRef.current = id;
        void ensure(id).then(found => {
          if (pendingRestoreRef.current !== mem) return;
          if (!found) mem.anchorMid = null;
          restoreRequestRef.current = null;
          setVirtualTick(tick => tick + 1);
        }).catch(() => {
          if (pendingRestoreRef.current !== mem) return;
          mem.anchorMid = null;
          restoreRequestRef.current = null;
          setVirtualTick(tick => tick + 1);
        });
      }
      return;
    }
    const root = scrollRef.current;
    const height = virtualViewportRef.current.height > 0
      ? virtualViewportRef.current.height
      : root?.clientHeight || 600;
    const target = computeVirtualWindow({
      total: stream.length,
      viewport: { offset: virtualViewportRef.current.offset, height },
      estimatedRowHeight: 96,
      rowGap: MEASURED_VIRTUALIZER_ROW_GAP,
      measuredHeights: virtualMeasuredHeightsRef.current,
      measuredMargins: virtualMeasuredMarginsRef.current,
      overscan: MEASURED_VIRTUALIZER_OVERSCAN,
      maxWindow: TRANSCRIPT_CLIP_WINDOW,
      anchor: { index: anchorIndex, offset: -mem.anchorOffset },
      direction: 'forward'
    });
    if (virtualViewportRef.current.offset === target.scrollOffset &&
      virtualViewportRef.current.height === height) return;
    virtualViewportRef.current = { offset: target.scrollOffset, height };
    if (root) {
      scrollController.cancel();
      root.scrollTop = Math.max(0, virtualBaseOffsetRef.current + target.scrollOffset);
      lastScrollTopRef.current = root.scrollTop;
    }
    setVirtualTick((tick) => tick + 1);
  }, [renderedWindow, stream, sessionId]);

  // 首开渐进扩批：未挂满时每帧自尾部补一批。prepend 前记锚定几何（无溢出时
  // top=0、按增量挪回即贴底），提交后由下方补偿 effect 还原视口——与「加载
  // 更早」同机制，阅读位置/贴底跟随都不跳。
  useEffect(() => {
    if (renderedWindow.progressDone || props.interactionActive === false) return;
    const raf = requestAnimationFrame(() => {
      capturePrepend();
      progressiveRef.current.budget += PROGRESSIVE_STEP_PARTS;
      setProgressTick((n) => n + 1);
    });
    return () => cancelAnimationFrame(raf);
  }, [renderedWindow, props.interactionActive, capturePrepend]);

  // 阅读位置恢复（LRU 逐出重挂配套）：渐进挂载走满（轻会话首帧即满）后一拍
  // 执行一次；reveal/查找显式跳转会先清 pending——显式导航优先于位置恢复。
  // 重挂首拍转录未到（rows 为空）时保留 pending 待消息到达重试。锚定消息
  // 优先（content-visibility 估高使绝对 scrollHeight 跨挂载漂移）；锚缺失
  // 或行被删退绝对值。恢复即接管视口——渐进扩张的锚定补偿同时作废。
  useLayoutEffect(() => {
    if (!renderedWindow.progressDone || props.interactionActive === false) return;
    const mem = pendingRestoreRef.current;
    if (!mem) return;
    const el = scrollRef.current;
    if (!el) return;
    if (!renderedWindow.rows.length || el.scrollHeight === 0) return;
    let top = mem.top;
    const anchor =
      mem.anchorMid != null
        ? el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(mem.anchorMid)}"]`)
        : null;
    const anchorInProjection = mem.anchorMid != null && stream.some(
      (item) => item.kind === 'message' && item.message.id === mem.anchorMid
    );
    if (stream.sparse && mem.anchorMid && !anchorInProjection && props.onEnsureMessageLoaded) return;
    if (renderedWindow.virtual && anchorInProjection && !anchor) return;
    pendingRestoreRef.current = null;
    clipAnchorRef.current = null;
    if (anchor) {
      top = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop + mem.anchorOffset;
    }
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    top = Math.max(0, Math.min(top, max));
    el.scrollTop = top;
    lastScrollTopRef.current = top;
    if (renderedWindow.virtual) {
      virtualViewportRef.current = {
        offset: Math.max(0, top - virtualBaseOffsetRef.current),
        height: el.clientHeight
      };
    }
    stickBottomRef.current = isTranscriptAtBottom(el);
    setShowJump(!stickBottomRef.current);
    if (anchor && !stickBottomRef.current) correctReadingAnchor({ node: anchor, offset: mem.anchorOffset });
  }, [renderedWindow, props.interactionActive, correctReadingAnchor]);

  // 停靠点跳转 reveal：历史面板点到未挂载的旧回合时（querySelector 落空），
  // 在滚动容器上派发 chat-clip:reveal；这里一次扩窗覆盖目标，渲染提交后由
  // 下方补偿 effect 滚到其锚点。非裁剪态锚点恒在 DOM，本事件不会发生
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onReveal = (ev: Event): void => {
      const detail = (ev as CustomEvent<string | { historyMessageId: string } | undefined>).detail;
      const fromHistory = typeof detail === 'object' && detail !== null;
      const id = fromHistory ? detail.historyMessageId : detail;
      if (typeof id !== 'string' || !id) return;
      const mounted = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
      if (mounted) { navigateToElement(mounted); return; }
      cancelReadingWork(); scrollController.cancel();
      detachFromBottom();
      let idx = props.messageIndex?.(id) ?? -1;
      if (idx < 0) {
        for (let i = 0; i < messages.length; i++) {
          if (messages[i]!.id === id) {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0) {
        const reportMissing = (): void => {
          if (fromHistory) showTip(t('无法打开这条历史消息'), { tone: 'error' });
        };
        const ensureMessageLoaded = props.onEnsureMessageLoaded;
        if (!ensureMessageLoaded) {
          reportMissing();
          return;
        }
        if (revealLoadRef.current?.id === id && revealLoadRef.current.sessionId === sessionId) return;
        const request = { id, sessionId, ready: false };
        revealLoadRef.current = request;
        revealTargetRef.current = id;
        void ensureMessageLoaded(id).then((found) => {
          if (revealLoadRef.current !== request) return;
          if (!found || !scrollRef.current || revealTargetRef.current !== id) {
            if (!found && revealTargetRef.current === id) reportMissing();
            revealLoadRef.current = null;
            if (revealTargetRef.current === id) revealTargetRef.current = null;
            return;
          }
          // A resolved range request can precede React's message commit. Let
          // the committed projection trigger navigation instead of recursively
          // calling the loader through a stale event listener.
          request.ready = true;
          setRevealLoadTick(tick => tick + 1);
        }).catch(() => {
          if (revealLoadRef.current !== request) return;
          if (revealTargetRef.current === id) reportMissing();
          revealLoadRef.current = null;
          if (revealTargetRef.current === id) revealTargetRef.current = null;
        });
        return;
      }
      revealTargetRef.current = id;
      // 渐进预算直接放行到挂满（显式跳转，一次性挂载成本可接受）；
      // 显式导航优先于阅读位置恢复
      pendingRestoreRef.current = null;
      if (virtualizerActiveRef.current) {
        const streamIndex = stream.sparse ? idx : stream.findIndex(
          (item) => item.kind === 'message' && item.message.id === id
        );
        if (streamIndex >= 0) {
          const height = virtualViewportRef.current.height > 0 ? virtualViewportRef.current.height : 600;
          const target = computeVirtualWindow({
            total: stream.length,
            viewport: { offset: virtualViewportRef.current.offset, height },
            estimatedRowHeight: 96,
            rowGap: MEASURED_VIRTUALIZER_ROW_GAP,
            measuredHeights: virtualMeasuredHeightsRef.current,
            measuredMargins: virtualMeasuredMarginsRef.current,
            overscan: MEASURED_VIRTUALIZER_OVERSCAN,
            maxWindow: TRANSCRIPT_CLIP_WINDOW,
            anchor: { index: streamIndex, offset: 8 },
            direction: 'forward'
          });
          virtualViewportRef.current = { offset: target.scrollOffset, height };
          // Seek the physical viewport together with the virtual window. A
          // smooth traversal from the old tail would report intermediate rows,
          // unmount the destination and release its navigation lease too early.
          el.scrollTop = Math.max(0, virtualBaseOffsetRef.current + target.scrollOffset);
          lastScrollTopRef.current = el.scrollTop;
          setVirtualTick((tick) => tick + 1);
          return;
        }
      }
      if (progressiveRef.current.budget !== Infinity) {
        progressiveRef.current.budget = Infinity;
        setProgressTick((n) => n + 1);
      }
      // 覆盖 idx 所需窗口：stream 长度 ≈ 消息数 + 分割线数，多给 8 条余量
      const streamLen =
        displayMessages.length + (props.compactions ?? EMPTY_COMPACTION_MARKERS).length;
      const need = Math.max(0, streamLen - idx + 8 - TRANSCRIPT_CLIP_WINDOW);
      setClipExtra((cur) => Math.max(cur, need));
    };
    el.addEventListener(CLIP_REVEAL_EVENT, onReveal);
    return () => el.removeEventListener(CLIP_REVEAL_EVENT, onReveal);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- messages/compactions 变化即重建监听（闭包需新值）
  }, [messages, displayMessages.length, props.compactions, props.onEnsureMessageLoaded, t]);

  useEffect(() => {
    const request = revealLoadRef.current;
    if (!request?.ready || request.sessionId !== sessionId || revealTargetRef.current !== request.id) return;
    if (!messages.some(message => message.id === request.id)) return;
    revealLoadRef.current = null;
    scrollRef.current?.dispatchEvent(new CustomEvent(CLIP_REVEAL_EVENT, { detail: request.id }));
  }, [messages, sessionId, revealLoadTick]);

  // 窗口变化后的视口补偿（提交后、paint 前）：reveal 跳转优先（接管视口，
  // 锚定还原不必再做）；否则「加载更早」按高度增量还原 scrollTop
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const revealId = revealTargetRef.current;
    if (revealId) {
      const target = el.querySelector<HTMLElement>(`[data-mid="${revealId}"]`);
      if (target) {
        revealTargetRef.current = null;
        clipAnchorRef.current = null;
        navigateToElement(target);
        return;
      }
      // 目标仍未挂载（扩窗不足）：保留 ref 下次窗口变化再试；消息已被删则不会触发
    }
    const anchor = clipAnchorRef.current;
    if (!anchor) return;
    clipAnchorRef.current = null;
    // Prepending is layout settlement, not navigation. A following viewport
    // must land at the new bottom before paint, even with smooth follow enabled.
    if (stickBottomRef.current && interactionActiveRef.current) {
      scrollController.followBottom(true);
      return;
    }
    const delta = el.scrollHeight - anchor.height;
    const visibleNode = anchor.visible?.node.isConnected
      ? anchor.visible.node
      : anchor.id
        ? el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(anchor.id)}"]`)
        : null;
    const visible = visibleNode && anchor.visible
      ? { node: visibleNode, offset: anchor.visible.offset }
      : null;
    if (delta > 0 || visible) {
      scrollController.cancel();
      el.scrollTop = visible ? transcriptAnchorTop(el, visible) : anchor.top + delta;
      lastScrollTopRef.current = el.scrollTop;
      if (visible) correctReadingAnchor(visible);
    }
  }, [renderedWindow, sessionId]);

  useLayoutEffect(() => {
    const wasPending = wasSnapshotPending.current;
    wasSnapshotPending.current = snapshotPending;
    if (!wasPending || snapshotPending || !interactionActiveRef.current || !stickBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    syncChatSurfaceLayout(el.closest<HTMLElement>('.chat-surface-view'));
    initialLayoutCleanupRef.current?.();
    initialLayoutCleanupRef.current = prepareTranscriptBottom(el);
    scrollController.followBottom(true);
  }, [snapshotPending, scrollController]);

  return (
    <div
      className={`chat-list-shell${props.className ? ` ${props.className}` : ''}`}
    >
      <div
        className="chat-list"
        ref={scrollRef}
        style={snapshotPending ? { visibility: 'hidden' } : undefined}
        aria-busy={snapshotPending || undefined}
        onScroll={onScroll}
        onWheel={onWheel}
        data-sel-area={props.selArea ?? 'gui-chat'}
        data-session-id={sessionId}
        data-sel-cwd={cwd || undefined}
      >
        <div className="agent-chat-col">
          {props.header}
          {renderedWindow.clipStart > 0 || props.hasEarlier ? (
            <div className="chat-clip-more">
              <button
                type="button"
                className="chat-clip-more-btn"
                onClick={loadEarlier}
                title={t('加载更早的消息')}
              >
                <IconChevronDown size={14} className="chat-clip-more-caret" />
                {t('加载更早的消息')}
              </button>
            </div>
          ) : null}
          {renderedWindow.virtual && renderedWindow.virtual.beforeHeight > 0 ? (
            <div
              className="chat-virtual-spacer chat-virtual-spacer-before"
              style={{ height: renderedWindow.virtual.beforeHeight, flex: '0 0 auto' }}
              aria-hidden="true"
            />
          ) : null}
          {renderedWindow.rows}
          {renderedWindow.virtual && renderedWindow.virtual.afterHeight > 0 ? (
            <div
              className="chat-virtual-spacer chat-virtual-spacer-after"
              style={{ height: renderedWindow.virtual.afterHeight, flex: '0 0 auto' }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </div>
      {jumpPresence.mounted ? (
        <div className="chat-jump-bottom-pos">
          <button
            type="button"
            className="chat-jump-bottom mp-pop mp-pop-up"
            data-mp-stage={jumpPresence.stage}
            title={t('滚动到底部')}
            aria-label={t('滚动到底部')}
            onClick={jumpBottom}
          >
            <IconChevronDown size={16} />
          </button>
        </div>
      ) : null}
      {historyPresence.mounted ? (
        <ChatHistoryPanel
          key={historyId}
          historyId={historyId}
          stage={historyPresence.stage}
          stops={turnStops}
          origin={historyOrigin}
          scrollRef={scrollRef}
          onNavigate={navigateToMessage}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
    </div>
  );
}

export const ChatTranscript = React.memo(ChatTranscriptInner) as typeof ChatTranscriptInner;

/** 内容坐标只定位零尺寸锚点；编辑卡独立挂到 body，按实际尺寸避让输入区。 */
function noteBubblePos(p: NotePos): { top: number; left: number } {
  return { top: p.top + 22, left: Math.max(4, p.right - 48) };
}

/** 批注气泡：正文已有划线，不在编辑卡中重复原文。 */
function NoteBubble(props: {
  pos?: { top: number; left: number };
  fromBar?: boolean;
  initial: string;
  mode: 'create' | 'edit';
  pending?: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}): React.JSX.Element {
  const { pos, fromBar, initial, mode, onSave, onCancel, onDelete, pending } = props;
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const peek = usePagePeek(anchor);
  const presence = usePresence(!!anchor && !peek, MOTION.microMs);
  const host = stripOverlayHost(anchor);
  useOverlayDismiss(!peek, onCancel);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!anchor || !card) return;
    const list = anchor.closest('.chat-list-shell');
    const composer = anchor.closest('.chat-surface-view')?.querySelector('.agent-chat-composer-wrap');
    const page = pageForOverlay(anchor);
    const strip = page?.closest('.h-strip');
    const place = (): void => {
      if (page?.hasAttribute('data-h-peek')) return;
      const a = anchor.getBoundingClientRect();
      const view = list?.getBoundingClientRect();
      const dock = composer?.getBoundingClientRect();
      const edge = 8;
      const leftEdge = Math.max(edge, view?.left ?? edge);
      const rightEdge = Math.min(window.innerWidth - edge, view?.right || window.innerWidth - edge);
      const width = Math.min(420, Math.max(0, rightEdge - leftEdge));
      const height = card.offsetHeight;
      let topEdge = Math.max(edge, view?.top ?? edge);
      let bottomEdge = Math.min(window.innerHeight - edge, dock?.top || window.innerHeight - edge);
      // 很矮的阅读区允许浮层盖住输入条，仍确保所有操作在视口内。
      if (bottomEdge - topEdge < height) { topEdge = edge; bottomEdge = window.innerHeight - edge; }
      const preferred = a.top + height <= bottomEdge ? a.top : a.top - height - edge;
      const origin = overlayViewportOrigin(host);
      const next = { width, maxHeight: bottomEdge - topEdge,
        top: Math.max(topEdge, Math.min(preferred, bottomEdge - height)) - origin.top,
        left: Math.max(leftEdge, Math.min(a.left, rightEdge - width)) - origin.left };
      setPlacement(previous => previous.width === next.width && previous.maxHeight === next.maxHeight &&
        previous.top === next.top && previous.left === next.left ? previous : next);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(card);
    if (list) ro.observe(list);
    if (composer) ro.observe(composer);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    const onStripMove = (event: Event): void => { if (event.target === strip) place(); };
    strip?.addEventListener('transitionend', onStripMove);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      strip?.removeEventListener('transitionend', onStripMove);
    };
  }, [pos?.top, pos?.left, fromBar, anchor, host]);
  return <>
    <span ref={setAnchor} className="msg-note-bubble-anchor" aria-hidden="true"
      style={fromBar || !pos ? { bottom: 28, left: 8 } : { top: pos.top, left: pos.left }}/>
    {anchor && createPortal(<div ref={cardRef} className="msg-note-bubble is-fixed mp-pop"
      data-note-pending={pending ? '' : undefined} data-overlay-root data-h-strip-overlay=""
      aria-hidden={peek || undefined} {...(peek ? { inert: '' } : {})}
      data-mp-stage={presence.stage} style={presence.mounted ? placement : { ...placement, visibility: 'hidden' }}>
      <NoteEditor initial={initial} edit={mode === 'edit'}
        onSave={onSave} onCancel={onCancel} onDelete={mode === 'edit' ? onDelete : undefined}/>
    </div>, host)}
  </>;
}
