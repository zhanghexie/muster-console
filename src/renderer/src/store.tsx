import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { useTranslation } from 'react-i18next';
import { showTip } from './tips';
import { t } from '../../shared/i18n';
import type { RightContent, RightOpenScope } from '../../shared/rightWorkspace';
import type { TurnChangeTarget } from '../../shared/turnChanges';
import { TURN_REVIEW_EVENT } from './chatSurface/turnReviewNavigation';
import type { ConfirmCancelledBy } from '../../shared/confirmDialog';
import type { PermissionDecision } from '../../shared/permissionOption';
import type {
  AgentRuntimeEntry,
  BubbleState,
  ChatImageAttachment,
  ConfirmRequest,
  SessionMeta,
  WorkspaceInfo,
  WorkspaceFileRef,
  WorkspaceOpenOptions,
  WorkspaceUpdateOptions,
  WorkspaceSwitchResult
} from '../../shared/types';
import { registerWorkspaceAccents, setWorkspaceAccentDefault } from '../../shared/workspaceAccent';
import type { SchedulerStatus } from '../../shared/schedulerStatus';
import type { UiDialogRequest } from '../../shared/uiDialog';
import type { PaletteMode } from '../../shared/commandPalette';
import { isChatRuntimeId } from '../../shared/agentRuntimeCapabilities';
import { clearDraft } from './composerDrafts';
import { clearAttachmentDraft } from './composerAttachmentDrafts';
import { subscribeRevealNeedsRead } from './sessionJump';
import { resolveCenterActiveId } from '../../shared/workspaceActiveSession';
import { BOOT_REHYDRATE_EVENT } from './bootStatus';

/**
 * 会话删除的渲染层残留清理：GUI/CLI 草稿与 GUI tosend 队列由渲染层管理，
 * CLI 待发附件也在本次运行中按会话缓存，主进程删除时不知道这些键——
 * 在 sessions:changed 全量差集里懒清理（列表本身是跨工作区全量广播）。
 */
function pruneRemovedSessionLocals(prev: SessionMeta[], next: SessionMeta[]): void {
  if (!prev.length) return;
  const nextIds = new Set(next.map((s) => s.id));
  for (const s of prev) {
    if (nextIds.has(s.id)) continue;
    if (s.type === 'terminal' && s.launchKind !== 'shell' && (!s.runtime || !isChatRuntimeId(s.runtime))) {
      const key = `cli-session:${s.id}`;
      clearAttachmentDraft(key);
      clearDraft(key);
      try { localStorage.removeItem(`muster.cli-composer-collapsed:${s.id}`); } catch { /* localStorage unavailable */ }
      continue;
    }
    if (!s.runtime || !isChatRuntimeId(s.runtime)) continue;
    try {
      localStorage.removeItem(`muster.tosend.v1:agent-session:${s.id}`);
      clearDraft(`agent-session:${s.id}`);
    } catch {
      /* localStorage 异常等情况非关键路径，忽略 */
    }
  }
}

/** 气泡默认态：text 保持中文原文作 key（模块级常量不翻），消费点经 t() 翻译 */
const DEFAULT_BUBBLE: BubbleState = { text: '待命', status: 'idle' };

/**
 * 纯 JSON 数据的无分配深度相等：首差异早退，逐 key 比较，不产出临时串。
 * SessionMeta 来自 IPC 结构化克隆（纯 JSON，无循环引用）。
 */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonDeepEqual(a[i], bb[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!jsonDeepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * 单会话渲染等价：全字段深比较。SessionMeta 的每个字段都可能是渲染消费面
 * （liveStatus/queuedInjects 胶囊、status/lifecycle 图标、name/pinned/archived
 * 列表、phase/activity 看板、modelOverride/thinkingLevel 详情等），以全字段
 * 覆盖为准——任何字段变化都不等价。
 */
export function sessionsEquivalent(a: SessionMeta, b: SessionMeta): boolean {
  if (a === b) return true;
  return jsonDeepEqual(a, b);
}

/**
 * 逐会话结构等价 + 全表引用复用（B1-4）：sessions:changed 广播（500ms 心跳与
 * lifecycle 翻转）每次都携带全新数组与全新会话对象（IPC 结构化克隆），无差别
 * setSessions 会让全部消费面板与转录整表重渲。逐会话（按下标配对，顺序变化
 * 视为变化）比较：等价会话复用旧引用，全表等价连数组引用一起复用（React 同
 * 引用 bail out，零重渲）；任一字段变化只换该会话与数组引用。
 * 回滚=等价门短路（直接 return next）即回现状。
 */
export function reconcileSessions(prev: SessionMeta[], next: SessionMeta[]): SessionMeta[] {
  if (prev === next) return next;
  if (prev.length !== next.length) return next;
  let allSame = true;
  const out = next.map((s, i) => {
    const old = prev[i]!;
    if (old.id === s.id && sessionsEquivalent(old, s)) return old;
    allSame = false;
    return s;
  });
  return allSame ? prev : out;
}

interface StoreValue {
  sessions: SessionMeta[];
  /** 当前工作区可见会话（terminal / scheduled 都按 workspaceId 过滤） */
  visibleSessions: SessionMeta[];
  /** registry 快照；写操作后经 runtimes:changed 刷新 */
  runtimes: AgentRuntimeEntry[];
  activeId: string | null;
  /** 中栏实际亮的会话：activeId 不属于当前工作区时为 null（跨区 select 不串台） */
  displayActiveId: string | null;
  /** active 工作区气泡（自动开聊等） */
  bubble: BubbleState;
  bubblesByWs: Record<string, BubbleState>;
  /** 调度会话 phase（按工作区；点亮左下角气泡，不进看板） */
  schedulerByWs: Record<string, SchedulerStatus>;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string | null;
  /** 主进程给新建面板的推荐路径/名称；null = 尚未拉到或旧主进程不提供。 */
  workspaceRecommendation: { root: string; name: string } | null;
  chatWorkspaceId: string | null;
  setChatWorkspaceId: (id: string | null) => void;
  setChatWorkspaceIdAndLoad: (id: string | null) => Promise<void>;
  confirms: ConfirmRequest[];
  dialogs: UiDialogRequest[];
  switching: boolean;
  respondConfirm: (
    requestId: string,
    confirmed: boolean,
    cancelledBy?: ConfirmCancelledBy,
    decision?: PermissionDecision
  ) => void;
  respondDialog: (requestId: string, cancelled: boolean, value?: string | string[]) => void;
  openWorkspace: (
    arg?: string | WorkspaceOpenOptions
  ) => Promise<{ ok: boolean; message?: string; }>;
  switchWorkspace: (id: string) => Promise<{ ok: boolean; message?: string; }>;
  updateWorkspace: (id: string, opts: WorkspaceUpdateOptions) => Promise<Pick<WorkspaceSwitchResult, 'ok' | 'message' | 'rootDependencies'>>;
  closeWorkspace: (id: string) => Promise<{ ok: boolean; message?: string; }>;
  composerInsert: {
    text: string;
    nonce: number;
    target?: string;
    replace?: boolean;
    images?: ChatImageAttachment[];
  } | null;
  requestComposerInsert: (
    text: string,
    opts?: { target?: string; replace?: boolean; images?: ChatImageAttachment[]; }
  ) => void;
  clearComposerInsert: () => void;
  openWorkspaceFile: { path: string; fileRef?: WorkspaceFileRef; line?: number; col?: number; source?: 'preview' | 'keep'; replacePreview?: boolean; scope?: RightOpenScope; ownerSessionId?: string; ownerWorkspaceId?: string; nonce: number; } | null;
  requestOpenWorkspaceFile: (args: { path: string; fileRef?: WorkspaceFileRef; line?: number; col?: number; source?: 'preview' | 'keep'; replacePreview?: boolean; scope?: RightOpenScope; ownerSessionId?: string; ownerWorkspaceId?: string; }) => void;
  clearOpenWorkspaceFile: () => void;
  openTurnReview: { workspaceId: string; sessionId: string; content: Extract<RightContent, { kind: 'review' }>; nonce: number } | null;
  clearTurnReview: () => void;
  sideDockRequest: { dock: 'git'; nonce: number; } | null;
  requestShowWorkspace: () => void;
  clearSideDockRequest: () => void;
  commandPalette: { mode: PaletteMode; nonce: number; seq: number; } | null;
  openCommandPalette: (mode: PaletteMode) => void;
  closeCommandPalette: () => void;
  /** 请求打开调度 Agent 面板并切到指定工作区（定时任务历史跳转用） */
  agentPanelRequest: { workspaceId: string; nonce: number; purpose?: 'dispatch' | 'memory'; } | null;
  requestAgentPanel: (workspaceId: string, purpose?: 'dispatch' | 'memory') => void;
  clearAgentPanelRequest: () => void;
  workspaceEditRequest: { workspaceId: string; nonce: number; } | null;
  requestWorkspaceEdit: (workspaceId: string) => void;
  clearWorkspaceEditRequest: () => void;
  flashTip: (text: string) => void;
}

/**
 * 切片按「变化频率」分组，不按业务归类——一个 context 的值一变，它的全部消费者
 * 就要重渲。流式聊天每帧都在改 messages，所以它单独一片：输入框、中栏、左栏只订
 * 阅各自那片，打字时不跟着抖。新增字段前先问它多久变一次。
 */
type SessionSlice = Pick<StoreValue, 'sessions' | 'visibleSessions' | 'activeId' | 'displayActiveId'>;
/** registry 快照：只在 runtimes:changed 时变，是全应用最冷的一片 */
type RuntimesSlice = Pick<StoreValue, 'runtimes'>;
type ChatSlice = Pick<
  StoreValue,
  | 'bubble'
  | 'bubblesByWs'
  | 'schedulerByWs'
  | 'chatWorkspaceId'
  | 'setChatWorkspaceId'
  | 'setChatWorkspaceIdAndLoad'
>;
type WorkspaceSlice = Pick<
  StoreValue,
  | 'workspaces'
  | 'activeWorkspaceId'
  | 'workspaceRecommendation'
  | 'switching'
  | 'openWorkspace'
  | 'switchWorkspace'
  | 'updateWorkspace'
  | 'closeWorkspace'
>;
type UiSlice = Pick<
  StoreValue,
  | 'confirms'
  | 'respondConfirm'
  | 'dialogs'
  | 'respondDialog'
  | 'composerInsert'
  | 'requestComposerInsert'
  | 'clearComposerInsert'
  | 'openWorkspaceFile'
  | 'requestOpenWorkspaceFile'
  | 'clearOpenWorkspaceFile'
  | 'openTurnReview'
  | 'clearTurnReview'
  | 'sideDockRequest'
  | 'requestShowWorkspace'
  | 'clearSideDockRequest'
  | 'commandPalette'
  | 'openCommandPalette'
  | 'closeCommandPalette'
  | 'agentPanelRequest'
  | 'requestAgentPanel'
  | 'clearAgentPanelRequest'
  | 'workspaceEditRequest'
  | 'requestWorkspaceEdit'
  | 'clearWorkspaceEditRequest'
  | 'flashTip'
>;
/** 转写/批注只需要动作：菜单、文件请求与确认框状态不应广播给全部保活会话。 */
type UiActionsSlice = Pick<UiSlice, 'flashTip' | 'requestOpenWorkspaceFile' | 'requestComposerInsert' | 'requestShowWorkspace'>;

/**
 * 终端↔Git 虚拟屏位移动画互斥（原 UiSlice 字段）：仅 TerminalView 读（写进 ref
 * 抑制终端识屏），却让十余个 UiSlice 消费者跟着每次脉冲重渲两回。挪出切片，
 * 落成模块级小 store —— 订阅者只剩各 TerminalView。
 */
const hStripBusyStore = {
  listeners: new Set<() => void>(),
  value: false,
  timer: null as number | null,
  subscribe(listener: () => void): () => void {
    hStripBusyStore.listeners.add(listener);
    return () => {
      hStripBusyStore.listeners.delete(listener);
    };
  },
  get(): boolean {
    return hStripBusyStore.value;
  },
  set(v: boolean): void {
    if (hStripBusyStore.value === v) return;
    hStripBusyStore.value = v;
    for (const l of hStripBusyStore.listeners) l();
  }
};

/** 横条动画进行中标记（默认 450ms）：期间抑制终端识屏，避免动画帧被扫描打断 */
export function pulseHStripBusy(ms = 450): void {
  hStripBusyStore.set(true);
  if (hStripBusyStore.timer != null) window.clearTimeout(hStripBusyStore.timer);
  hStripBusyStore.timer = window.setTimeout(() => {
    hStripBusyStore.timer = null;
    hStripBusyStore.set(false);
  }, ms);
}

export function useHStripBusy(): boolean {
  return useSyncExternalStore(hStripBusyStore.subscribe, hStripBusyStore.get);
}

const SessionStoreContext = createContext<SessionSlice | null>(null);
const RuntimesStoreContext = createContext<RuntimesSlice | null>(null);
const ChatStoreContext = createContext<ChatSlice | null>(null);
const WorkspaceStoreContext = createContext<WorkspaceSlice | null>(null);
const UiStoreContext = createContext<UiSlice | null>(null);
const UiActionsStoreContext = createContext<UiActionsSlice | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode; }): React.JSX.Element {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  /** 上一轮会话表快照：sessions:changed / 切区重拉两条入口共用做差集（懒清理 localStorage） */
  const prevSessionsRef = useRef<SessionMeta[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntimeEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [bubblesByWs, setBubblesByWs] = useState<Record<string, BubbleState>>({});
  const [schedulerByWs, setSchedulerByWs] = useState<Record<string, SchedulerStatus>>({});
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  /** null 同时表示「初始快照未到」：零工作区时主进程给空串，不能把它当成未加载。 */
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [workspaceRecommendation, setWorkspaceRecommendation] = useState<{ root: string; name: string } | null>(null);
  const [chatWorkspaceId, setChatWorkspaceId] = useState<string | null>(null);
  const [confirms, setConfirms] = useState<ConfirmRequest[]>([]);
  // IPC 关闭与点击可能发生在同一帧；同步失效，避免退场快照/旧回调再次发送批准。
  const pendingConfirmIds = useRef(new Set<string>());
  const [dialogs, setDialogs] = useState<UiDialogRequest[]>([]);
  const [switching, setSwitching] = useState(false);
  const [composerInsert, setComposerInsert] = useState<{
    text: string;
    nonce: number;
    target?: string;
    replace?: boolean;
    images?: ChatImageAttachment[];
  } | null>(null);
  const [openWorkspaceFile, setOpenWorkspaceFile] = useState<{
    path: string;
    fileRef?: WorkspaceFileRef;
    line?: number;
    col?: number;
    source?: 'preview' | 'keep'; replacePreview?: boolean; scope?: RightOpenScope; ownerSessionId?: string; ownerWorkspaceId?: string;
    nonce: number;
  } | null>(null);
  const [sideDockRequest, setSideDockRequest] = useState<{ dock: 'git'; nonce: number; } | null>(
    null
  );
  const [openTurnReview, setOpenTurnReview] = useState<StoreValue['openTurnReview']>(null);
  const clearTurnReview = useCallback(() => setOpenTurnReview(null), []);
  const [commandPalette, setCommandPalette] = useState<{
    mode: PaletteMode;
    nonce: number;
    seq: number;
  } | null>(null);
  const [agentPanelRequest, setAgentPanelRequest] = useState<{
    workspaceId: string;
    nonce: number;
    purpose?: 'dispatch' | 'memory';
  } | null>(null);
  const insertNonceRef = useRef(0);
  const openFileNonceRef = useRef(0);
  const sideDockNonceRef = useRef(0);
  const commandPaletteNonceRef = useRef(0);
  const agentPanelNonceRef = useRef(0);
  const workspaceEditNonceRef = useRef(0);
  const [workspaceEditRequest, setWorkspaceEditRequest] = useState<{ workspaceId: string; nonce: number; } | null>(null);
  /** ui:bubble 缺 workspaceId 时回落 active（订阅 effect 闭包不能直接读最新 state） */
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;
  const activeReviewSessionRef = useRef(activeId);
  activeReviewSessionRef.current = activeId;
  const chatWorkspaceIdRef = useRef(chatWorkspaceId);
  chatWorkspaceIdRef.current = chatWorkspaceId;

  const setChatWorkspaceIdAndLoad = useCallback(
    async (id: string | null): Promise<void> => {
      // 历史/模式/上下文由 chatSurface/orchestratorSurface 在面板打开时装载
      setChatWorkspaceId(id);
    },
    []
  );

  const flashTip = useCallback((text: string): void => {
    showTip(text);
  }, []);

  const clearComposerInsert = useCallback((): void => {
    setComposerInsert(null);
  }, []);

  const requestComposerInsert = useCallback(
    (
      text: string,
      opts?: { target?: string; replace?: boolean; images?: ChatImageAttachment[]; }
    ): void => {
      const wsId = activeWorkspaceIdRef.current;
      const target = opts?.target || wsId;
      if (!target) {
        flashTip(t('请先打开工作区'));
        return;
      }
      insertNonceRef.current += 1;
      // replace=true：整框替换草稿（R-20 建议回复「填入可编辑」语义）；
      // 缺省仍是追加（划词插入等既有行为不变）
      setComposerInsert({
        text,
        nonce: insertNonceRef.current,
        target,
        replace: opts?.replace,
        ...(opts?.images?.length ? { images: opts.images } : {})
      });
      // 省略 target 的划词插入打开活动区调度，同屏的其他输入框不消费该草稿。
      if (!opts?.target && wsId) void setChatWorkspaceIdAndLoad(wsId);
    },
    [flashTip, setChatWorkspaceIdAndLoad, t]
  );

  const clearOpenWorkspaceFile = useCallback((): void => {
    setOpenWorkspaceFile(null);
  }, []);

  const clearSideDockRequest = useCallback((): void => {
    setSideDockRequest(null);
  }, []);
  const requestShowWorkspace = useCallback((): void => {
    sideDockNonceRef.current += 1;
    setSideDockRequest({ dock: 'git', nonce: sideDockNonceRef.current });
  }, []);

  useEffect(() => {
    const onReview = (event: Event) => {
      const detail = (event as CustomEvent<{ target: TurnChangeTarget; filePath?: string }>).detail;
      if (!detail?.target || !['gui', 'dispatch'].includes(detail.target.kind) || typeof detail.target.id !== 'string' || typeof detail.target.messageId !== 'string') return;
      const { target, filePath } = detail;
      const wsId = target.kind === 'dispatch' ? target.id : prevSessionsRef.current.find(s => s.id === target.id)?.workspaceId;
      if (!wsId || wsId !== activeWorkspaceIdRef.current) { flashTip(t('请先切换到该会话所在工作区')); return; }
      setOpenTurnReview({ workspaceId: wsId, sessionId: activeReviewSessionRef.current ?? '', nonce: ++openFileNonceRef.current, content: { kind: 'review', owner: { kind: target.kind, id: target.id }, messageId: target.messageId, filePath } });
      requestShowWorkspace();
    };
    window.addEventListener(TURN_REVIEW_EVENT, onReview);
    return () => window.removeEventListener(TURN_REVIEW_EVENT, onReview);
  }, [requestShowWorkspace, flashTip]);

  const openCommandPalette = useCallback((mode: PaletteMode): void => {
    setCommandPalette((prev) => {
      if (prev) return { mode, nonce: prev.nonce, seq: prev.seq + 1 };
      commandPaletteNonceRef.current += 1;
      return { mode, nonce: commandPaletteNonceRef.current, seq: 0 };
    });
  }, []);

  const closeCommandPalette = useCallback((): void => {
    setCommandPalette(null);
  }, []);

  const requestAgentPanel = useCallback((workspaceId: string, purpose: 'dispatch' | 'memory' = 'dispatch'): void => {
    agentPanelNonceRef.current += 1;
    setAgentPanelRequest({ workspaceId, nonce: agentPanelNonceRef.current, purpose });
  }, []);

  const clearAgentPanelRequest = useCallback((): void => {
    setAgentPanelRequest(null);
  }, []);
  const requestWorkspaceEdit = useCallback((workspaceId: string): void => {
    setWorkspaceEditRequest({ workspaceId, nonce: ++workspaceEditNonceRef.current });
  }, []);
  const clearWorkspaceEditRequest = useCallback((): void => setWorkspaceEditRequest(null), []);

  const requestOpenWorkspaceFile = useCallback(
    (args: { path: string; fileRef?: WorkspaceFileRef; line?: number; col?: number; source?: 'preview' | 'keep'; replacePreview?: boolean; scope?: RightOpenScope; ownerSessionId?: string; ownerWorkspaceId?: string; }): void => {
      const wsId = activeWorkspaceIdRef.current;
      if (!wsId) {
        flashTip(t('请先打开工作区'));
        return;
      }
      if (args.ownerWorkspaceId && args.ownerWorkspaceId !== wsId) {
        flashTip(t('请先切换到该会话所在工作区'));
        return;
      }
      if (args.fileRef && args.fileRef.workspaceId !== wsId) {
        flashTip(t('不在当前工作区：{{path}}', { path: args.path }));
        return;
      }
      openFileNonceRef.current += 1;
      setOpenWorkspaceFile({ ...args, nonce: openFileNonceRef.current });
      if (!args.ownerSessionId || args.ownerSessionId === activeReviewSessionRef.current) {
        sideDockNonceRef.current += 1;
        setSideDockRequest({ dock: 'git', nonce: sideDockNonceRef.current });
      }
    },
    [flashTip, t]
  );


  useEffect(() => window.api.on('extensionSurface:previewExport', ({ workspaceId, path }) => {
    requestOpenWorkspaceFile({ path, ownerWorkspaceId: workspaceId, scope: 'workspace', source: 'preview' });
  }), [requestOpenWorkspaceFile]);

  // 会话表统一入口：广播 / 直连重拉两条路径共用（差集清理 + 逐会话引用复用）
  const applySessions = useCallback((list: SessionMeta[]): void => {
    pruneRemovedSessionLocals(prevSessionsRef.current, list);
    // B1-4：逐会话结构等价——等价复用旧引用、全表等价连数组引用也复用，
    // 心跳/lifecycle 广播不再引发全量面板与转录重渲
    const merged = reconcileSessions(prevSessionsRef.current, list);
    prevSessionsRef.current = merged;
    setSessions(merged);
  }, []);

  const syncAndSet = useCallback((list: AgentRuntimeEntry[]) => {
    setRuntimes(Array.isArray(list) ? list : []);
  }, []);

  /**
   * 挂载期初始快照拉取（会话/工作区/配置/运行时）。X7-F01：bootWait 兜底超时降级
   * 挂载时这些 invoke 全部 reject（handler 未注册）——失败至少 console 可见，
   * 主进程就绪（app:boot:ready）后由 BOOT_REHYDRATE_EVENT 重放本函数补齐。
   */
  const pullInitialData = useCallback((): void => {
    const notePullFailure = (err: unknown): void => {
      console.error('[store] initial data pull failed (will retry once boot ready):', err);
    };
    window.api.sessions.list().then((r) => {
      applySessions(r.sessions);
      setActiveId(r.activeId);
      if (r.schedulerByWs) setSchedulerByWs(r.schedulerByWs);
    }, notePullFailure);
    window.api.workspaces.list().then((r) => {
      setWorkspaces(r.workspaces);
      setActiveWorkspaceId(r.activeWorkspaceId);
      setWorkspaceRecommendation(
        r.recommendedRoot ? { root: r.recommendedRoot, name: r.recommendedName || '' } : null
      );
    }, notePullFailure);
    window.api.config.get().then((c) => {
      setWorkspaceAccentDefault(c.workspaceAccentDefault);
      setWorkspaces(c.workspaces);
      setActiveWorkspaceId(c.activeWorkspaceId);
    }, notePullFailure);
    window.api.runtimes.list().then(syncAndSet, notePullFailure);
  }, [applySessions, syncAndSet]);

  useEffect(() => {
    pullInitialData();

    const offs = [
      window.api.on('runtimes:changed', (list: AgentRuntimeEntry[]) => {
        syncAndSet(Array.isArray(list) ? list : []);
      }),
      window.api.on('sessions:changed', (p: { sessions: SessionMeta[]; activeId: string | null; }) => {
        applySessions(p.sessions);
        setActiveId(p.activeId);
      }),
      window.api.on('scheduler:status', (p) => {
        setSchedulerByWs(p.byWorkspace ?? {});
      }),
      window.api.on(
        'workspaces:changed',
        (p) => {
          if (p.workspaceAccentDefault) setWorkspaceAccentDefault(p.workspaceAccentDefault);
          setWorkspaces(p.workspaces);
          setActiveWorkspaceId(p.activeWorkspaceId);
          const chatId = chatWorkspaceIdRef.current;
          if (chatId && !p.workspaces.some((w) => w.id === chatId)) {
            setChatWorkspaceId(null);
          }
        }
      ),
      window.api.on('ui:bubble', (b: BubbleState) => {
        setBubblesByWs((prev) => {
          const wsId = b.workspaceId?.trim() || activeWorkspaceIdRef.current || undefined;
          if (!wsId) return prev;
          return {
            ...prev,
            [wsId]: { text: b.text, status: b.status, workspaceId: wsId }
          };
        });
      }),
      window.api.on('ui:confirm', (c: ConfirmRequest) => {
        pendingConfirmIds.current.add(c.requestId);
        setConfirms((prev) => [...prev, c]);
      }),
      window.api.on('ui:confirmClosed', ({ requestId }) => {
        pendingConfirmIds.current.delete(requestId);
        setConfirms((prev) => prev.filter((c) => c.requestId !== requestId));
      }),
      window.api.on('ui:dialog', (d: UiDialogRequest) => setDialogs((prev) => [...prev, d])),
      window.api.on('ui:dialogClosed', ({ requestId }) => setDialogs((prev) => prev.filter(dialog => dialog.requestId !== requestId))),
      // 已读兜底：与 App 切页 effect 解耦，通知点击切区时不会被重绑拆掉
      subscribeRevealNeedsRead()
    ];
    return () => offs.forEach((off) => off());
  }, [pullInitialData, syncAndSet, applySessions]);

  // X7-F01：主进程启动链就绪（bootStatus.settleBoot 广播）后重拉初始快照，
  // 补齐 bootWait 兜底超时降级挂载期间「No handler registered」的失败拉取
  useEffect(() => {
    const rehydrate = (): void => pullInitialData();
    window.addEventListener(BOOT_REHYDRATE_EVENT, rehydrate);
    return () => window.removeEventListener(BOOT_REHYDRATE_EVENT, rehydrate);
  }, [pullInitialData]);

  const bubble = useMemo(() => {
    if (!activeWorkspaceId) return { ...DEFAULT_BUBBLE, text: t('待命') };
    return (
      bubblesByWs[activeWorkspaceId] ?? {
        ...DEFAULT_BUBBLE,
        text: t('待命'),
        workspaceId: activeWorkspaceId
      }
    );
  }, [bubblesByWs, activeWorkspaceId, t]);

  const visibleSessions = useMemo(() => {
    if (!activeWorkspaceId) return sessions;
    return sessions.filter((s) => (s.workspaceId ?? '') === activeWorkspaceId);
  }, [sessions, activeWorkspaceId]);

  const displayActiveId = useMemo(
    () => resolveCenterActiveId(sessions, activeId, activeWorkspaceId),
    [sessions, activeId, activeWorkspaceId]
  );

  const respondConfirm = useCallback(
    (
      requestId: string,
      confirmed: boolean,
      cancelledBy?: ConfirmCancelledBy,
      decision?: PermissionDecision
    ): void => {
      if (!pendingConfirmIds.current.delete(requestId)) return;
      // 仅在带四态应答时追加第 4 参：旧双按钮路径保持 3 参调用形状
      if (decision) window.api.confirmRespond(requestId, confirmed, cancelledBy, decision);
      else window.api.confirmRespond(requestId, confirmed, cancelledBy);
      setConfirms((prev) => prev.filter((c) => c.requestId !== requestId));
    },
    []
  );

  const respondDialog = useCallback(
    (requestId: string, cancelled: boolean, value?: string | string[]): void => {
      window.api.dialogRespond(
        requestId,
        cancelled ? { cancelled: true } : { cancelled: false, value: value ?? '' }
      );
      setDialogs((prev) => prev.filter((d) => d.requestId !== requestId));
    },
    []
  );

  const applyWorkspaceResult = useCallback(
    async (res: {
      ok: boolean;
      message?: string;
      workspaces?: WorkspaceInfo[];
      activeWorkspaceId?: string;
    }) => {
      if (!res.ok) return res;
      if (res.workspaces) {
        setWorkspaces(res.workspaces);
        const chatId = chatWorkspaceIdRef.current;
        if (chatId && !res.workspaces.some((w) => w.id === chatId)) {
          setChatWorkspaceId(null);
        }
      }
      if (res.activeWorkspaceId !== undefined) {
        // 空串也是有效结果：删掉最后一个工作区后必须清掉活动区，引导面板才会回来。
        // null 归一成空串，避免旧/mock 回执把「已加载的零工作区」误判成未加载。
        // ref 先行：过场编排在同一异步链里连续切区（以最后一次为准），不能等重渲染才同步
        const nextActive = res.activeWorkspaceId || '';
        activeWorkspaceIdRef.current = nextActive;
        setActiveWorkspaceId(nextActive);
      }
      // 切区时再拉一次会话表：后台区生命周期一直在算，但偶发 IPC 丢失时避免图标停在旧态
      try {
        const sess = await window.api.sessions.list();
        // 与 sessions:changed 同入口做差集清理（此处直连 setSessions 会绕过懒清理追踪）
        pruneRemovedSessionLocals(prevSessionsRef.current, sess.sessions);
        prevSessionsRef.current = sess.sessions;
        setSessions(sess.sessions);
        setActiveId(sess.activeId);
        if (sess.schedulerByWs) setSchedulerByWs(sess.schedulerByWs);
      } catch (err) {
        // X7-F01：catch{} 吞掉会让降级挂载期的失败彻底不可见——至少 console 可见
        console.error('[store] sessions re-pull after workspace switch failed:', err);
      }
      return res;
    },
    []
  );

  const openWorkspace = useCallback(
    async (arg?: string | WorkspaceOpenOptions) => {
      setSwitching(true);
      try {
        const res = await window.api.workspaces.open(arg);
        await applyWorkspaceResult(res);
        return { ok: res.ok, message: res.message };
      } finally {
        setSwitching(false);
      }
    },
    [applyWorkspaceResult]
  );

  const switchWorkspace = useCallback(
    async (id: string) => {
      if (id === activeWorkspaceIdRef.current) return { ok: true };
      setSwitching(true);
      try {
        const res = await window.api.workspaces.switch(id);
        await applyWorkspaceResult(res);
        return { ok: res.ok, message: res.message };
      } finally {
        setSwitching(false);
      }
    },
    [applyWorkspaceResult]
  );

  const closeWorkspace = useCallback(
    async (id: string) => {
      const res = await window.api.workspaces.close(id);
      await applyWorkspaceResult(res);
      if (res.ok && chatWorkspaceIdRef.current === id) {
        setChatWorkspaceId(null);
      }
      return { ok: res.ok, message: res.message };
    },
    [applyWorkspaceResult]
  );

  const updateWorkspace = useCallback(
    async (id: string, opts: WorkspaceUpdateOptions) => {
      const res = await window.api.workspaces.update(id, opts);
      if (res.ok) {
        if (res.workspaces) setWorkspaces(res.workspaces);
        if (res.activeWorkspaceId) setActiveWorkspaceId(res.activeWorkspaceId);
      }
      return { ok: res.ok, message: res.message, rootDependencies: res.rootDependencies };
    },
    []
  );

  const sessionSlice = useMemo<SessionSlice>(
    () => ({ sessions, visibleSessions, activeId, displayActiveId }),
    [sessions, visibleSessions, activeId, displayActiveId]
  );
  const runtimesSlice = useMemo<RuntimesSlice>(() => ({ runtimes }), [runtimes]);
  const chatSlice = useMemo<ChatSlice>(
    () => ({
      bubble,
      bubblesByWs,
      schedulerByWs,
      chatWorkspaceId,
      setChatWorkspaceId,
      setChatWorkspaceIdAndLoad
    }),
    [bubble, bubblesByWs, schedulerByWs, chatWorkspaceId, setChatWorkspaceId, setChatWorkspaceIdAndLoad]
  );
  const workspaceSlice = useMemo<WorkspaceSlice>(() => {
    // 渲染期登记（先于子树渲染）：只持 id 的调用点经 workspaceAccent(id) 取到用户设定色
    registerWorkspaceAccents(workspaces);
    return {
      workspaces,
      activeWorkspaceId,
      workspaceRecommendation,
      switching,
      openWorkspace,
      switchWorkspace,
      updateWorkspace,
      closeWorkspace
    };
  }, [
    workspaces,
    activeWorkspaceId,
    workspaceRecommendation,
    switching,
    openWorkspace,
    switchWorkspace,
    updateWorkspace,
    closeWorkspace
  ]);
  const uiSlice = useMemo<UiSlice>(
    () => ({
      confirms,
      respondConfirm,
      dialogs,
      respondDialog,
      composerInsert,
      requestComposerInsert,
      clearComposerInsert,
      openWorkspaceFile,
      requestOpenWorkspaceFile,
      clearOpenWorkspaceFile,
      openTurnReview,
      clearTurnReview,
      sideDockRequest,
      requestShowWorkspace,
      clearSideDockRequest,
      commandPalette,
      openCommandPalette,
      closeCommandPalette,
      agentPanelRequest,
      requestAgentPanel,
      clearAgentPanelRequest,
      workspaceEditRequest,
      requestWorkspaceEdit,
      clearWorkspaceEditRequest,
      flashTip
    }),
    [
      confirms,
      respondConfirm,
      dialogs,
      respondDialog,
      composerInsert,
      requestComposerInsert,
      clearComposerInsert,
      openWorkspaceFile,
      requestOpenWorkspaceFile,
      clearOpenWorkspaceFile,
      openTurnReview,
      clearTurnReview,
      sideDockRequest,
      requestShowWorkspace,
      clearSideDockRequest,
      commandPalette,
      openCommandPalette,
      closeCommandPalette,
      agentPanelRequest,
      requestAgentPanel,
      clearAgentPanelRequest,
      workspaceEditRequest,
      requestWorkspaceEdit,
      clearWorkspaceEditRequest,
      flashTip
    ]
  );
  const uiActionsSlice = useMemo<UiActionsSlice>(
    () => ({ flashTip, requestOpenWorkspaceFile, requestComposerInsert, requestShowWorkspace }),
    [flashTip, requestOpenWorkspaceFile, requestComposerInsert, requestShowWorkspace]
  );

  return (
      <SessionStoreContext.Provider value={sessionSlice}>
        <RuntimesStoreContext.Provider value={runtimesSlice}>
          <ChatStoreContext.Provider value={chatSlice}>
            <WorkspaceStoreContext.Provider value={workspaceSlice}>
              <UiStoreContext.Provider value={uiSlice}>
                <UiActionsStoreContext.Provider value={uiActionsSlice}>
                    {typeof import.meta !== 'undefined' &&
                    (import.meta as { env?: { DEV?: boolean; }; }).env?.DEV ? (
                      <BubbleDebugBridge />
                    ) : null}
                    {children}
                </UiActionsStoreContext.Provider>
              </UiStoreContext.Provider>
            </WorkspaceStoreContext.Provider>
          </ChatStoreContext.Provider>
        </RuntimesStoreContext.Provider>
      </SessionStoreContext.Provider>
  );
}

/** 供 CDP / 控制台排查气泡串台：window.__maBubbleDebug() */
function BubbleDebugBridge(): null {
  const { bubblesByWs, chatWorkspaceId, bubble } = useChatStore();
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  const { sessions } = useSessionStore();
  useEffect(() => {
    (window as unknown as { __maBubbleDebug?: () => unknown; }).__maBubbleDebug = () => ({
      activeWorkspaceId,
      chatWorkspaceId,
      dockBubble: bubble,
      bubblesByWs,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path })),
      sessions: sessions
        .filter((s) => s.type === 'terminal')
        .map((s) => ({
          id: s.id.slice(0, 8),
          name: s.name,
          workspaceId: s.workspaceId,
          cwd: s.cwd,
          live: s.liveStatus?.label,
          kind: s.liveStatus?.kind
        }))
    });
  }, [bubblesByWs, activeWorkspaceId, chatWorkspaceId, workspaces, sessions, bubble]);
  return null;
}

function requireSlice<T>(v: T | null, name: string): T {
  if (!v) throw new Error(t('{{name}} 必须在 StoreProvider 内使用', { name }));
  return v;
}

export function useSessionStore(): SessionSlice {
  return requireSlice(useContext(SessionStoreContext), 'useSessionStore');
}

export function useRuntimesStore(): RuntimesSlice {
  return requireSlice(useContext(RuntimesStoreContext), 'useRuntimesStore');
}

export function useChatStore(): ChatSlice {
  return requireSlice(useContext(ChatStoreContext), 'useChatStore');
}

export function useWorkspaceStore(): WorkspaceSlice {
  return requireSlice(useContext(WorkspaceStoreContext), 'useWorkspaceStore');
}

export function useUiStore(): UiSlice {
  return requireSlice(useContext(UiStoreContext), 'useUiStore');
}

/** 动作身份仍随语言等真实依赖更新；调用时读取 StoreProvider 的最新工作区 refs。 */
export function useUiActionsStore(): UiActionsSlice {
  return requireSlice(useContext(UiActionsStoreContext), 'useUiActionsStore');
}
