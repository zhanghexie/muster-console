import { showTip } from '../tips';
/**
 * GUI Worker 会话适配器：把 agentSession:* IPC 与 agentSession:event 推送流
 * 适配成统一 ChatSurface 合同。本文件是全仓唯一认识 GUI 会话协议的渲染层模块——
 * 会话壳与统一视图不得直接触碰 window.api.agentSession.*（人机交互卡除外，
 * 它们属协议适配层见 guiApprovalCards.tsx）。
 *
 * 消息模型：GuiChatMessage（parts 交错）；转写经 guiMessageView.toDisplayMessage 映射。
 * delta 合批走共享 RafBatcher（节奏与调度适配器同源），增量应用用 applyGuiMessageDelta。
 */
import { useEffect, useMemo, useRef } from 'react';
import type {
  ChatImageAttachment,
  GuiWorkerMode
} from '../../../shared/types';
import type { CodexModelListItem } from '../../../shared/codexModels';
import type { ModelParameterState } from '../../../shared/modelParameters';
import type {
  ChatQueuedItem,
  ChatSurface,
  ChatSurfaceCaps,
  ChatSurfaceSnapshot,
  ChatSurfacePageState,
  ChatSurfacePageWindow,
  ChatStatusInfo,
  SessionHarnessModelExpected
} from '../../../shared/chatSurface';
import type { GuiChatMessage, GuiMessagePart, GuiWorkerHistoryPage, GuiWorkerPush } from '../../../shared/guiWorker';
import type { GuiInjectionView } from '../../../shared/guiHistoryMetadata';
import { applyGuiMessageDelta, applyGuiMessagePart, guiChatMessageEqual, guiMessageText, isExtensionDomainNudge } from '../../../shared/guiWorker';
import { locateAbortedTurn } from '../../../shared/chatTurnRail';
import type { HarnessViewState } from '../../../shared/chatSurface';
import type { SetModelConfigurationInput, SetModelConfigurationResult } from '../../../shared/harnessPicker';
import { CHAT_RUNTIME_CAPABILITIES } from '../../../shared/agentRuntimeCapabilities';
import { inferModelSupportsImages } from '../../../shared/modelCapabilities';
import { parseExternalPiModelKey } from '../../../shared/externalPiModel';
import { t } from '../../../shared/i18n';
import { localizeGuiForkError, localizeGuiHostError } from '../../../shared/guiHostError';
import {
  applyCompactionEvent,
  beginCompaction,
  compactionAnchorAt,
  completePendingCompaction,
  dropCompaction,
  markersFromCompactions,
  newPendingCompactionId,
  type ChatCompactionMarker
} from '../../../shared/chatCompaction';
import type { ChatPresetRosterItem } from '../../../shared/chatSurface';
import { useUiActionsStore } from '../store';
import { jumpToSession } from '../sessionJump';
import { createRafBatcher } from './deltaBatcher';
import {
  PageMapCoordinator,
  type PageMapSnapshot
} from './pageMapCoordinator';
import { notifyComposerError } from '../components/agentComposer/composerNotice';
import { guiPermissionOptions } from '../../../shared/guiPermissionOptions';
import { harnessModelSelectionKey, type HarnessModelSelections } from '../../../shared/harnessModelSelection';

/** 空排队列表单例：快照高频重建时空队列不再每批新分配（与调度面同配方） */
const EMPTY_QUEUED: ReadonlyArray<ChatQueuedItem> = [];
const GUI_HISTORY_PAGE_SIZE = 120;

function capabilitiesOf(runtimeId?: string): ChatRuntimeCaps | null {
  if (runtimeId && runtimeId in CHAT_RUNTIME_CAPABILITIES) {
    return CHAT_RUNTIME_CAPABILITIES[runtimeId as keyof typeof CHAT_RUNTIME_CAPABILITIES];
  }
  return null;
}
type ChatRuntimeCaps = (typeof CHAT_RUNTIME_CAPABILITIES)[keyof typeof CHAT_RUNTIME_CAPABILITIES];

/** 全局 LLM 配置 → 当前模型信息（GUI Worker 与调度共用一套） */
function modelInfoFromConfig(
  c: {
    llm?: {
      providers?: Array<{
        id: string;
        enabled?: boolean;
        models: Array<{ id: string; name?: string; multimodal?: boolean }>;
      }>;
      activeProviderId?: string;
      activeModelId?: string;
    };
  },
  /** 会话级模型覆盖：优先按它取（找不到时回落显示裸 id） */
  override?: { providerId: string; modelId: string; params?: Array<{ id: string; value: string }> } | null
): {
  providerId: string;
  modelId: string;
  label: string;
  params?: Array<{ id: string; value: string }>;
  supportsImages?: boolean;
} | null {
  const llm = c.llm;
  if (override) {
    const ovProv = llm?.providers?.find((p) => p.id === override.providerId);
    const ovModel = ovProv?.models?.find((m) => m.id === override.modelId);
    return {
      providerId: override.providerId,
      modelId: override.modelId,
      label: ovModel?.name || override.modelId,
      supportsImages: inferModelSupportsImages(override.modelId, ovModel?.multimodal)
    };
  }
  const prov =
    llm?.providers?.find((p) => p.id === llm?.activeProviderId && p.enabled !== false) ??
    llm?.providers?.[0];
  if (!prov) return null;
  const model = prov.models?.find((m) => m.id === llm?.activeModelId) ?? prov.models?.[0];
  if (!model) return null;
  return {
    providerId: prov.id,
    modelId: model.id,
    label: model.name || model.id,
    supportsImages: inferModelSupportsImages(model.id, model.multimodal)
  };
}

interface StoreDeps {
  flashTip: (text: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}


/** 会话生命周期与状态时钟（U1/U2 修复，r2 细分）：
 *  - epoch：会话生命周期代。dispose()/重新 attach 各自 +1，一切异步回调按它判死——
 *    仅看 alive 布尔无法区分「同会话内新请求已发出」的 StrictMode 重挂/切回场景。
 *  - clearSeq：clear() 计数。clear 之前发出的 history 响应整体作废，防止已清空历史复活。
 *  - syncSeq：全量 sync 推送应用计数。sync 是主进程权威整表替换（合同只含 messages），
 *    capture 之后应用过 sync ⇒ 本地消息列表严格新于在途 history 快照 ⇒ 消息段作废。
 *  - msgClock/busyClock/modeClock：消息列表 / busy / mode 域时钟。
 *  - 元数据域按携带者细分（r2-①②）：usageClock（context 推送）、injClock（injections
 *    推送）、compactClock（compaction 推送与本地压缩标记变更）、engineClock（
 *    engine-meta 推送）、presetClock（changePreset/history piModeId）、modelClock
 *    （setModel 应用/history modelOverride）。参数域判代不在 capture 内：走
 *    parameterRequest 代 + 推送身份硬判（见 parameters 推送分支）。
 *    history 逐域比对：未动取快照（初次挂载任一推送先到不再殃及其余字段装载）；
 *    动过保本地（新推送/新设置优先）。不用单一计数器——避免无关推送互相误伤。 */
interface HistoryCapture {
  epoch: number;
  clearSeq: number;
  syncSeq: number;
  msgClock: number;
  busyClock: number;
  executionClock: number;
  modeClock: number;
  usageClock: number;
  injClock: number;
  compactClock: number;
  engineClock: number;
  presetClock: number;
  modelClock: number;
}

/**
 * 单会话外部 store：状态 + version + 订阅（useSyncExternalStore 契约）。
 * 一个 sessionId 一个实例（壳在 sessionId 变化时重建）。
 */
export class AgentSessionSurfaceStore {
  private messages: GuiChatMessage[] = [];
  /**
   * Shadow bounded-page projection. `messages` stays the compatibility
   * projection consumed by existing rows while this map owns absolute ranges,
   * cursors and generation-scoped load guards for the measured virtualizer.
   */
  private readonly pageMap = new PageMapCoordinator<GuiChatMessage>();
  private busy = false;
  private execution?: import('../../../shared/executionLifecycle').ExecutionLifecycle;
  private executionClock = 0;
  private mode: GuiWorkerMode = 'auto';
  private piModeId = '';
  private sessionModel: { providerId: string; modelId: string; params?: Array<{ id: string; value: string }> } | null = null;
  private modelParameters: ModelParameterState[] = [];
  private parameterModelInfo: { providerId: string; modelId: string; label: string; supportsImages?: boolean; params?: Array<{ id: string; value: string }> } | null = null;
  private parameterRequest = 0;
  private codexCatalog: CodexModelListItem[] = [];
  private codexDefaultModel = '';
  private codexCatalogWarning = '';
  private codexCatalogRequest = 0;
  private codexManualPending = false;
  private harnessCatalog: Array<{ id: string; name: string }> = [];
  private harnessCatalogState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private harnessCatalogError = '';
  private harnessCatalogRequest: string | null = null;
  private harnessCatalogUpdatePending = false;
  private harnessCatalogSeq = 0;
  private harnessStateSeq = 0;
  private harnessIdentity: SessionHarnessModelExpected | null = null;
  private harnessCatalogView?: NonNullable<ChatStatusInfo['harnessModelCatalog']>;
  private modelSelections: HarnessModelSelections = {};
  private modelSelectionsReady = false;
  private modelSelectionsError = '';
  private modelSelectionsRevision = 0;
  private modelSelectionView?: { key: string; modelIds: string[] | undefined; ready: boolean; error: string;
    value: NonNullable<ChatStatusInfo['harnessModelSelection']> };
  private modelInfo: {
    providerId: string;
    modelId: string;
    label: string;
    params?: Array<{ id: string; value: string }>;
    supportsImages?: boolean;
  } | null = null;
  private usage: {
    tokens: number | null;
    contextWindow: number;
    ts?: number;
    stale?: boolean;
  } | null = null;
  private slashCommands: Array<{ name: string; description?: string; inputHint?: string }> = [];
  private engineMode: { modeId: string; name?: string } | null = null;
  private compactions: ChatCompactionMarker[] = [];
  /** Harness 透明（pi-trajectory-plan extension）：开关态（默认关=现状零变化）+ 注入快照信封 */
  private harnessOn = false;
  private injections: GuiInjectionView[] = [];
  private metadataMessages = new Map<string, { injection?: GuiInjectionView; compactions: NonNullable<GuiWorkerHistoryPage['compactions']> }>();
  private liveInjections: GuiInjectionView[] = [];
  private readonly injectionDetails: NonNullable<HarnessViewState['injectionDetails']> = ref => window.api.agentSession.injectionDetails(this.sessionId, ref);
  private readonly engineInput: NonNullable<HarnessViewState['engineInput']> = (messageId, ref) => window.api.agentSession.engineInput(this.sessionId, messageId, ref);

  private refreshHarnessSnapshot(): void {
    const previous = this.harnessSnap;
    if (previous.on === this.harnessOn && previous.injections === this.injections &&
        previous.injectionDetails === this.injectionDetails) return;
    this.harnessSnap = { on: this.harnessOn, injections: this.injections,
      injectionDetails: this.injectionDetails, engineInput: this.engineInput };
  }

  private trimMetadata(): void {
    const ids = new Set(this.messages.map(message => message.id));
    for (const id of this.metadataMessages.keys()) if (!ids.has(id)) this.metadataMessages.delete(id);
    const unique = new Map<string, GuiInjectionView>();
    for (const { injection: view } of this.metadataMessages.values()) if (view) unique.set('kind' in view ? view.details.key : String(view.at), view);
    for (const view of this.liveInjections) unique.set('kind' in view ? view.details.key : String(view.at), view);
    const nextInjections = [...unique.values()].sort((a, b) => a.at - b.at);
    if (nextInjections.length !== this.injections.length || nextInjections.some((view, index) => view !== this.injections[index])) this.injections = nextInjections;
    const records = [...this.metadataMessages.values()].flatMap(message => message.compactions);
    const markers = markersFromCompactions([...new Map(records.map(record => [record.at, record])).values()].sort((a,b) => a.at-b.at));
    const live = this.compactions.filter(marker => !marker.id.startsWith('hc-e'));
    const previousMarkers = new Map(this.compactions.map(marker => [marker.id, marker]));
    const nextMarkers = [...markers, ...live.slice(-120)].map(marker => {
      const previous = previousMarkers.get(marker.id);
      return previous && previous.status === marker.status && previous.createdAt === marker.createdAt &&
        previous.tokensBefore === marker.tokensBefore && previous.tokensAfter === marker.tokensAfter ? previous : marker;
    });
    if (nextMarkers.length !== this.compactions.length || nextMarkers.some((marker, index) => marker !== this.compactions[index])) this.compactions = nextMarkers;
    this.refreshHarnessSnapshot();
  }
  /** useSyncExternalStore 契约：快照引用稳定（变化时才换新对象） */
  private harnessSnap: HarnessViewState = { on: false, injections: [] };
  private alive = false;
  private suspended = false;
  private epoch = 0;
  private clearSeq = 0;
  private syncSeq = 0;
  private msgClock = 0;
  private busyClock = 0;
  private modeClock = 0;
  private permissionStrategyClock = 0;
  private usageClock = 0;
  private injClock = 0;
  private compactClock = 0;
  private engineClock = 0;
  private presetClock = 0;
  private modelClock = 0;
  private modelInfoRequest = 0;
  /** 最后一次被主进程确认的 mode（history 或 setMode 成功；失败回滚目标） */
  private confirmedMode: GuiWorkerMode = 'auto';
  /** setMode 串行队列：请求按发出顺序在主进程落定，失败只回滚属于自己的乐观态 */
  private modeReq = 0;
  private modeChain: Promise<void> = Promise.resolve();
  /** setModel 串行队列（与 setMode 同类入口加固；报告仅实测 mode） */
  private modelChain: Promise<void> = Promise.resolve();
  /** history 单飞：在途期间新的 resync 请求挂起，应用完成后再拉一次。
 *  状态随生命周期换代：dispose 重置 pending/refetch，旧 settle 回调按 epoch 失配
 *  跳过——旧请求悬挂时重挂也能立即发出新生命周期的请求（r1-2）。 */
  private historyPending = false;
  private historyBefore: number | undefined;
  private historyHasEarlier = false;
  /** Message-only live cursor. A gap or duplicate is handled before applying the event. */
  private liveMessageSeq: number | undefined;
  private liveRecoveryPending = false;
  private liveRecoveryMaxSeq: number | undefined;
  private liveRecoveryPageSeq: number | undefined;
  private historyError = '';
  private historyRefetch = false;
  /** 逐消息本地变更时钟（r1-3）：id → 该消息最后一次被推送（delta/part/sync）应用时的
 *  msgClock。迟到快照合并时：touched > capture 时钟 ⇒ 本地领先（含快照后增量），
 *  保本地；否则快照版本更新（resync 权威补齐能落地），取快照。 */
  private touched = new Map<string, number>();

  private listeners = new Set<() => void>();
  private version = 0;
  private snap: ChatSurfaceSnapshot | null = null;
  /** 元数据推送不改变转写；按消息源与过滤开关保留可见列表身份。 */
  private visibleCache: { source: GuiChatMessage[]; harnessOn: boolean; messages: GuiChatMessage[] } | null = null;
  /** 排队列表摘要缓存：流式期快照每批重建，(id,text) 未变则复用旧数组 */
  private queuedCache: { source: GuiChatMessage[]; digest: string; items: ReadonlyArray<ChatQueuedItem> } | null = null;
  private offEvent: (() => void) | null = null;
  private offCatalogEvent: (() => void) | null = null;
  private offModelSelections: (() => void) | null = null;
  private deps: StoreDeps | null = null;

  constructor(
    readonly sessionId: string,
    private readonly runtime: {
      id: string;
      pi: boolean;
      claude: boolean;
      acp: boolean;
      codex: boolean;
    }
  ) {}

  get runtimeId(): string { return this.runtime.id; }

  /** Inspection hook for range and payload-retention tests. */
  getPageMapSnapshot(): PageMapSnapshot<GuiChatMessage> {
    return this.pageMap.getSnapshot();
  }

  retainPageWindow(window: ChatSurfacePageWindow): void {
    this.retainedWindow = window;
    if (this.navigationWindow && window.start <= this.navigationWindow.index && window.end > this.navigationWindow.index) {
      this.navigationWindow = undefined;
    }
    if (this.trimPages()) {
      this.snap = null;
      this.notify();
    }
    for (const range of this.pageMap.missingWindows(window)) void this.loadPage(range.end);
  }

  private retainedWindow?: ChatSurfacePageWindow;
  private navigationWindow?: ChatSurfacePageWindow & { index: number };

  private trimPages(): boolean {
    const known = new Set(this.pageMap.loadedSlots().map(slot => slot.messageId));
    this.pageMap.updatePayloads(this.messages.map(payload => ({ messageId: payload.id, payload })));
    const total = this.pageMap.getSnapshot().total;
    const changed = this.pageMap.retainWindow(this.retainedWindow ?? { start: Math.max(0, total - 120), end: total }, this.navigationWindow);
    const retained = this.pageMap.getSnapshot();
    const extras = this.messages.filter(message => !known.has(message.id) || message.queued);
    const retainedIds = new Set(retained.messages.map(message => message.messageId));
    const next = [...retained.messages.map(message => message.payload), ...extras.filter(message => !retainedIds.has(message.id))];
    if (next.length !== this.messages.length || next.some((message, index) => message !== this.messages[index])) {
      this.messages = next;
      this.trimMetadata();
      const ids = new Set(next.map(message => message.id));
      for (const id of this.touched.keys()) if (!ids.has(id)) this.touched.delete(id);
      return true;
    }
    this.trimMetadata();
    return changed;
  }

  messageIndex(messageId: string): number | undefined {
    return this.pageMap.locateMessage(messageId)?.index;
  }

  async ensureMessageLoaded(messageId: string): Promise<boolean> {
    if (!messageId) return false;
    if (this.messages.some(message => message.id === messageId) || this.pageMap.locateMessage(messageId)) return true;
    await this.loadPage(undefined, messageId);
    return this.messages.some(message => message.id === messageId) || !!this.pageMap.locateMessage(messageId);
  }

  private readonly rangeRequests = new Map<string, Promise<void>>();

  private loadPage(before?: number, targetMessageId?: string): Promise<void> {
    const key = `${this.epoch}:${this.clearSeq}:${before ?? 'tail'}:${targetMessageId ?? ''}`;
    const existing = this.rangeRequests.get(key);
    if (existing) return existing;
    const request = this.fetchPage(before, targetMessageId).finally(() => {
      if (this.rangeRequests.get(key) === request) this.rangeRequests.delete(key);
    });
    this.rangeRequests.set(key, request);
    return request;
  }

  private pageState(): ChatSurfacePageState {
    const snapshot = this.pageMap.getSnapshot();
    return {
      generation: snapshot.generation,
      total: snapshot.total,
      slots: this.pageMap.loadedSlots(),
      loadedRanges: snapshot.loadedRanges,
      cursor: snapshot.cursor,
      loadState: snapshot.loadState
    };
  }
  private get harnessModelRuntime(): string | undefined {
    const id = this.runtime.id;
    return ['acp', 'claude', 'pi-external', 'omp', 'muse-gui', 'zcode-gui'].includes(id) ? id : undefined;
  }

  private getHarnessCatalogView(runtimeId: string): NonNullable<ChatStatusInfo['harnessModelCatalog']> {
    const agentId = runtimeId === 'acp' ? this.harnessIdentity?.agentId : undefined;
    const identityReady = !!this.harnessIdentity;
    const error = this.harnessCatalogError || undefined;
    const cached = this.harnessCatalogView;
    if (cached && cached.runtimeId === runtimeId && cached.agentId === agentId &&
        cached.state === this.harnessCatalogState && cached.items === this.harnessCatalog &&
        cached.identityReady === identityReady && cached.error === error) return cached;
    return this.harnessCatalogView = {
      runtimeId, sessionId: this.sessionId, ...(agentId ? { agentId } : {}),
      state: this.harnessCatalogState, items: this.harnessCatalog, identityReady,
      ...(error ? { error } : {})
    };
  }

  /** Harness 透明视图态（壳的开关与注入标注消费；与快照同批 notify） */
  readonly harnessStore = {
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
    get: (): HarnessViewState => this.harnessSnap
  };

  setHarnessOn(on: boolean): void {
    if (this.harnessOn === on) return;
    this.harnessOn = on;
    this.refreshHarnessSnapshot();
    this.snap = null;
    this.notify();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  /**
   * 渲染可见消息：透明开关关闭时滤掉宿主静默插话（steering:'host'）——它们在现状里
   * 完全不可见（硬验收：关闭=现状零变化）；开启时保留（渲染为 §6.2 插话线）。
   */
  private visibleMessages(): GuiChatMessage[] {
    const hit = this.visibleCache;
    if (hit?.source === this.messages && hit.harnessOn === this.harnessOn) return hit.messages;
    const filtered = this.harnessOn ? this.messages : this.messages.filter((m) => m.steering !== 'host' && !isExtensionDomainNudge(m));
    const messages = filtered.length === this.messages.length ? this.messages : filtered;
    this.visibleCache = { source: this.messages, harnessOn: this.harnessOn, messages };
    return messages;
  }

  /** Apply an absolute page and rebuild the bounded render projection. */
  private recordPageMapRange(
    start: number,
    total: number,
    hasEarlier: boolean,
    messages: readonly GuiChatMessage[],
    generation: number
  ): void {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(total) || total < start) return;
    const currentById = new Map(this.messages.map(message => [message.id, message]));
    const pageMessages = messages.map(message => ({
      messageId: message.id,
      payload: currentById.get(message.id) ?? message
    }));
    const fullReplacement = start === 0 && messages.length === total && this.messages.length === total;
    this.pageMap.applyWindow({
      generation,
      range: { start, end: start + pageMessages.length },
      messages: pageMessages,
      cursor: {
        before: start,
        total: Math.max(total, start + pageMessages.length),
        hasEarlier
      }
    }, fullReplacement);
    this.trimPages();
  }

  private recordGuiHistoryPage(page: GuiWorkerHistoryPage, generation: number): void {
    // Metadata is owned by actual message IDs, not sliding range cursors.
    // An overlapping response replaces each ID rather than retaining another
    // whole envelope. Page-head baseline and same-timestamp order are preserved.
    const injections = [...(page.injections ?? [])].sort((a,b) => a.at - b.at);
    for (const message of page.messages) {
      let injection = injections[0];
      for (const candidate of injections) { if (candidate.at > message.ts) break; injection = candidate; }
      this.metadataMessages.set(message.id, { injection, compactions: [] });
    }
    for (const record of page.compactions ?? []) {
      const owner = page.messages.find(message => message.ts >= record.at) ?? page.messages.at(-1);
      if (owner) this.metadataMessages.get(owner.id)!.compactions.push(record);
    }
    this.recordPageMapRange(page.before, page.total, page.hasEarlier, page.messages, generation);
    this.trimMetadata();
  }

  getSnapshot = (): ChatSurfaceSnapshot => {
    if (this.snap) return this.snap;
    const modelInfo = this.parameterModelInfo && (!this.modelInfo || this.modelInfo.providerId !== this.parameterModelInfo.providerId || this.modelInfo.modelId !== this.parameterModelInfo.modelId)
      ? this.parameterModelInfo : this.modelInfo;
    const harnessRuntime = this.harnessModelRuntime;
    const overrideModelId = this.sessionModel?.modelId ?? '';
    const externalPiIdentity = harnessRuntime === 'pi-external' || harnessRuntime === 'omp'
      ? parseExternalPiModelKey(overrideModelId) : null;
    const status: ChatStatusInfo | null =
      harnessRuntime
        ? {
            modelLabel: overrideModelId ? this.harnessCatalog.find(item => item.id === overrideModelId)?.name ?? (externalPiIdentity ? `${externalPiIdentity.providerId} / ${externalPiIdentity.modelId}` : overrideModelId) : t('跟随引擎默认'),
            providerId: harnessRuntime,
            modelId: overrideModelId || 'default',
            modelPinned: !!this.sessionModel,
            harnessModelCatalog: this.getHarnessCatalogView(harnessRuntime),
            usage: this.usage,
            thinking: null
          }
        : modelInfo
          ? {
              modelLabel: modelInfo.label,
              providerId: modelInfo.providerId,
              modelId: modelInfo.modelId,
              modelPinned: !!this.sessionModel,
              supportsImages: modelInfo.supportsImages,
              ...(this.runtime.codex ? { codexModelCatalog: this.codexCatalog, modelCatalogWarning: this.codexCatalogWarning } : {}),
              // r2-⑥：当前会话选择的 params（含 effort 等）优先于 modelInfo 的派生副本
              // （派生副本在 refresh 异步窗口内可能是旧值；modelInfo 已含 parameterModelInfo 兜底）
              modelParams: this.sessionModel?.params ?? modelInfo.params,
              usage: this.usage,
              // 泛化参数体系：思考档不再是独立快照域，
              // 由参数面板 modelParameters 承载；判代迁移至参数域（见 parameters 推送分支）
              thinking: null
            }
          : null;
    if (status) {
      status.modelParameters = this.modelParameters;
      const key = harnessModelSelectionKey(this.runtimeId, this.runtimeId === 'acp' ? this.harnessIdentity?.agentId || this.piModeId : undefined);
      const modelIds = Object.hasOwn(this.modelSelections, key) ? this.modelSelections[key] : undefined;
      let view = this.modelSelectionView;
      if (!view || view.key !== key || view.modelIds !== modelIds || view.ready !== this.modelSelectionsReady || view.error !== this.modelSelectionsError) {
        view = { key, modelIds, ready: this.modelSelectionsReady, error: this.modelSelectionsError,
          value: { runtimeId: this.runtimeId, ready: this.modelSelectionsReady,
            ...(modelIds !== undefined ? { modelIds } : {}),
            ...(this.modelSelectionsError ? { error: this.modelSelectionsError } : {}) } };
        this.modelSelectionView = view;
      }
      status.harnessModelSelection = view.value;
    }
    const messages = this.visibleMessages();
    const queuedItems = this.queuedItemsOf(messages);
    this.snap = {
      messages,
      historyLoading: this.historyPending && messages.length === 0,
      historyError: this.historyError,
      historyHasEarlier: this.historyHasEarlier,
      page: this.pageState(),
      busy: this.busy,
      execution: this.execution,
      queuedCount: queuedItems.length,
      queuedItems,
      status,
      mode: this.mode,
      preset:
        this.runtime.pi
          ? { id: this.piModeId, locked: this.messages.length > 0 }
          : null,
      ...(this.slashCommands.length ? { engineSlashCommands: this.slashCommands } : {}),
      ...(this.engineMode
        ? { engineModeLabel: this.engineMode.name || this.engineMode.modeId }
        : {}),
      ...(this.compactions.length ? { compactions: this.compactions } : {})
    };
    return this.snap;
  };

  /**
   * 排队列表引用稳定化：流式期快照每批（~50ms）重建一次，排队 (id,text) 未变时
   * 复用旧数组、空队列复用模块级单例——排队面板 props 不随每批快照换引用。
   * 队列真变（新增/编辑/取消）摘要失配，自然换新数组新内容。
   */
  private queuedItemsOf(messages: GuiChatMessage[]): ReadonlyArray<ChatQueuedItem> {
    const hit = this.queuedCache;
    if (hit?.source === messages) return hit.items;
    const queued = messages.filter((m) => m.queued);
    if (queued.length === 0) {
      this.queuedCache = { source: messages, digest: '', items: EMPTY_QUEUED };
      return EMPTY_QUEUED;
    }
    const digest = queued
      .map((m) => `${m.id}\u0000${guiMessageText(m)}\u0000${m.images?.length ?? 0}`)
      .join('\u0001');
    if (hit && hit.digest === digest) {
      this.queuedCache = { ...hit, source: messages };
      return hit.items;
    }
    const items = queued.map((m) => ({
      id: m.id,
      text: guiMessageText(m),
      ...(m.images?.length
        ? {
            imageCount: m.images.length,
            imagePreviews: m.images.map((im) => ({
              id: im.id,
              url: im.url || `data:${im.mimeType};base64,${im.data}`,
              ...(im.name ? { name: im.name } : {})
            }))
          }
        : {})
    }));
    this.queuedCache = { source: messages, digest, items };
    return items;
  }

  private get pi(): boolean {
    return this.runtime.pi;
  }
  private get acp(): boolean {
    return this.runtime.acp;
  }

  dispose(preserveReadingPages = false): void {
    // 先失效一切在途回调（epoch+1），再做既有清理——旧请求回来不得再写任何状态；
    // 单飞状态一并换代：旧 settle 回调按 epoch 失配跳过，重挂立即能发新请求（r1-2）
    this.epoch += 1;
    this.alive = false;
    this.suspended = preserveReadingPages;
    this.historyPending = false;
    this.liveMessageSeq = undefined;
    this.liveRecoveryPending = false;
    this.liveRecoveryMaxSeq = undefined;
    this.liveRecoveryPageSeq = undefined;
    this.historyRefetch = false;
    if (preserveReadingPages) this.pageMap.cancelLoads();
    else {
      this.historyBefore = undefined;
      this.historyHasEarlier = false;
      this.pageMap.reset();
      this.metadataMessages.clear(); this.liveInjections = []; this.injections = []; this.refreshHarnessSnapshot();
      this.retainedWindow = undefined;
    }
    this.navigationWindow = undefined;
    this.rangeRequests.clear();
    this.codexCatalogRequest++;
    this.codexManualPending = false;
    this.resetHarnessCatalog();
    this.offCatalogEvent?.(); this.offCatalogEvent = null;
    this.offModelSelections?.(); this.offModelSelections = null;
    this.offEvent?.();
    this.offEvent = null;
    this.batcher.dispose();
  }

  /** 装载历史 + 订阅推送（visible 变真也补拉：重启后 entry 在首次 select 时才 open） */
  attach(runtimeId: string | undefined, deps: StoreDeps): void {
    this.deps = deps;
    if (this.offEvent) return;
    this.alive = true;
    this.epoch += 1;
    // Visibility changes end subscriptions/requests, not the history lifetime.
    // Keep the reader's bounded pages and generation while epoch rejects old IO.
    if (!this.suspended) {
      this.pageMap.reset();
      this.metadataMessages.clear(); this.liveInjections = []; this.injections = []; this.refreshHarnessSnapshot();
      this.retainedWindow = undefined;
    }
    this.suspended = false;
    this.navigationWindow = undefined;
    this.rangeRequests.clear();
    this.fetchHistory();
    this.modelSelectionsReady = false; this.modelSelectionsError = '';
    this.offModelSelections = window.api.on('agentSession:harnessModelSelectionsChanged', ({ key, selections }) => {
      if (!this.alive) return;
      const currentKey = harnessModelSelectionKey(this.runtimeId, this.runtimeId === 'acp' ? this.harnessIdentity?.agentId || this.piModeId : undefined);
      const relevant = key === currentKey || !this.modelSelectionsReady;
      if (this.modelSelectionsReady) {
        const next = { ...this.modelSelections };
        if (Object.hasOwn(selections, key)) next[key] = selections[key]!;
        else delete next[key];
        this.modelSelections = next;
      } else this.modelSelections = selections;
      this.modelSelectionsRevision++; this.modelSelectionsReady = true; this.modelSelectionsError = '';
      if (!relevant) return;
      if (this.runtime.codex) { ++this.parameterRequest; this.parameterModelInfo = null; this.modelInfo = this.codexModelInfo(); void this.loadModelParameters(); }
      this.snap = null; this.notify();
      // A settings refresh may have updated the cache before a model was
      // selected. Re-read that snapshot only; never start discovery here.
      if (key !== currentKey) return;
      if (this.runtime.codex && !this.codexManualPending) void this.loadCodexCatalog(false);
      else if (this.harnessIdentity && this.harnessModelRuntime) {
        if (this.harnessCatalogRequest) this.harnessCatalogUpdatePending = true;
        else void this.loadHarnessCatalog(false);
      }
    });
    const selectionEpoch = this.epoch, selectionRevision = this.modelSelectionsRevision;
    void window.api.agentSession.getHarnessModelSelections().then(selections => {
      if (!this.alive || this.epoch !== selectionEpoch || this.modelSelectionsRevision !== selectionRevision) return;
      this.modelSelections = selections; this.modelSelectionsReady = true; this.modelSelectionsError = '';
      if (this.runtime.codex) { ++this.parameterRequest; this.parameterModelInfo = null; this.modelInfo = this.codexModelInfo(); void this.loadModelParameters(); }
      this.snap = null; this.notify();
    }).catch(error => {
      if (!this.alive || this.epoch !== selectionEpoch || this.modelSelectionsRevision !== selectionRevision) return;
      this.modelSelectionsError = (error as Error).message || String(error);
      this.snap = null; this.notify();
    });
    if (this.harnessModelRuntime) void this.refreshHarnessModelState().then(() => this.loadHarnessCatalog(false));
    const reloadHarnessCatalog = () => {
      if (this.harnessCatalogRequest) this.harnessCatalogUpdatePending = true;
      else void this.loadHarnessCatalog(false);
    };
    const offNativeCatalog = window.api.on('agentSession:modelCatalogUpdated', event => {
      if (!this.alive || event.error || event.runtimeId !== this.runtimeId) return;
      if (event.requestId && event.requestId === this.harnessCatalogRequest) return;
      if (this.runtime.codex) { if (!this.codexManualPending) void this.loadCodexCatalog(false); return; }
      if (!this.harnessIdentity || event.cwd !== (this.harnessIdentity.catalogCwd ?? this.harnessIdentity.cwd) ||
          (event.runtimeId === 'acp' && event.agentId !== this.harnessIdentity.agentId)) return;
      reloadHarnessCatalog();
    });
    const offCoreCatalog = this.runtimeId === 'pi' ? window.api.on('agentSession:coreReasoningCatalogUpdated', () => {
      if (this.alive) this.refreshModelInfo(false);
    }) : undefined;
    this.offCatalogEvent = () => { offNativeCatalog(); offCoreCatalog?.(); };
    this.refreshModelInfo(false);
    this.offEvent = window.api.on('agentSession:event', (payload: GuiWorkerPush) => {
      if (!payload || payload.sessionId !== this.sessionId) return;
      if (payload.kind === 'sync') {
        const versionDecision = this.observeLiveMessageSeq(payload.liveSeq, true);
        if (versionDecision !== 'apply') return;
        this.batcher.flush();
        const syncStart = typeof payload.before === 'number' && Number.isSafeInteger(payload.before)
          ? Math.max(0, payload.before)
          : Math.max(0, payload.messages.length - GUI_HISTORY_PAGE_SIZE);
        const hasRangeMetadata = typeof payload.before === 'number' && typeof payload.total === 'number';
        const syncMessages = hasRangeMetadata ? payload.messages : payload.messages.slice(syncStart);
        const currentIds = new Set(syncMessages.map(message => message.id));
        if (hasRangeMetadata && syncStart === 0 && payload.total! < this.pageMap.getSnapshot().total) {
          this.pageMap.reset();
      this.metadataMessages.clear(); this.liveInjections = []; this.injections = []; this.refreshHarnessSnapshot();
          this.clearSeq++;
          this.retainedWindow = undefined;
          this.navigationWindow = undefined;
        }
        const syncBoundary = syncMessages[0]?.ts;
        const loadedEarlier = hasRangeMetadata && syncStart > 0
          ? this.messages.filter(message => !currentIds.has(message.id) &&
            (syncBoundary === undefined || message.ts <= syncBoundary))
          : [];
        // A bounded live sync is a tail patch. Keep older pages already loaded by
        // the reader instead of replacing them with the tail-only payload.
        const earlier = hasRangeMetadata && syncStart > 0
          ? this.messages.filter(message => !currentIds.has(message.id))
          : [];
        this.messages = reconcileById(this.messages, [...earlier, ...syncMessages]);
        if (hasRangeMetadata) {
          this.recordPageMapRange(
            syncStart,
            payload.total!,
            payload.hasEarlier ?? syncStart > 0,
            syncMessages,
            this.pageMap.generation
          );
        }
        this.historyBefore = hasRangeMetadata
          ? Math.max(0, syncStart - loadedEarlier.length)
          : syncStart;
        this.historyHasEarlier = this.historyBefore > 0 && (payload.hasEarlier ?? syncStart > 0);
        // sync 是消息域的权威整表替换：推动消息时钟 + 逐消息时钟（r1-3），
        // 并使在途 history 的「消息段」作废（其余字段仍按各自时钟应用，r1-1）
        this.syncSeq += 1;
        this.msgClock += 1;
        this.touched.clear();
        for (const m of syncMessages) this.touched.set(m.id, this.msgClock);
        this.snap = null;
        this.notify();
      } else if (payload.kind === 'permission-mode') {
        if (!this.pi) return;
        // A persisted permission toggle replaces both the displayed mode and
        // the rollback target. Older history and queued selections cannot undo it.
        this.permissionStrategyClock++;
        this.modeClock++;
        this.mode = payload.mode;
        this.confirmedMode = payload.mode;
        this.snap = null;
        this.notify();
      } else if (payload.kind === 'parameters') {
        // 参数域按模型判代（r3-① 泛化迁移）：推送携带 host 侧快照身份，与会话
        // 显式模型选择不一致 ⇒ 旧 era 迟到推送，丢弃不污染新模型参数面板。
        // （sessionModel 为空=跟随默认时无从硬判，依赖后续 loadModelParameters 补拉收敛）
        if (
          this.sessionModel &&
          payload.providerId &&
          payload.modelId &&
          (payload.providerId !== this.sessionModel.providerId ||
            payload.modelId !== this.sessionModel.modelId)
        ) return;
        ++this.parameterRequest;
        this.modelParameters = payload.controls;
        if (payload.warning) this.deps?.flashTip(payload.warning);
        this.snap = null;
        this.notify();
      } else if (payload.kind === 'delta') {
        if (this.observeLiveMessageSeq(payload.liveSeq, false) !== 'apply') return;
        this.batcher.enqueue({
          messageId: payload.messageId,
          partIndex: payload.partIndex,
          deltaKind: payload.deltaKind,
          delta: payload.delta
        });
      } else if (payload.kind === 'part') {
        if (this.observeLiveMessageSeq(payload.liveSeq, false) !== 'apply') return;
        this.applyPart(payload.messageId, payload.partIndex, payload.part);
      } else if (payload.kind === 'execution') {
        if (payload.state && this.execution?.id === payload.state.id && this.execution.revision >= payload.state.revision) return;
        this.execution = payload.state;
        this.executionClock += 1;
        this.snap = null;
        this.notify();
      } else if (payload.kind === 'busy') {
        if (this.busy !== payload.busy) {
          this.busy = payload.busy;
          this.busyClock += 1;
          // 回合边沿刷新参数面板（泛化参数体系：next-turn 参数在回合边界应用）
          if (!payload.busy) this.loadModelParameters();
          this.snap = null;
          this.notify();
        }
      } else if (payload.kind === 'error') {
        if (this.deps) showTip(localizeGuiHostError(payload.message), { tone: 'error' });
      } else if (payload.kind === 'context') {
        this.usage = payload.usage;
        this.usageClock += 1;
        this.snap = null;
        this.notify();
      } else if (payload.kind === 'injections') {
        this.liveInjections = [...this.liveInjections.filter(view => view.at !== payload.injection.at), payload.injection].slice(-120);
        this.trimMetadata();
        this.refreshHarnessSnapshot();
        this.injClock += 1;
        this.snap = null;
        this.notify();
      } else if (payload.kind === 'compaction') {
        const anchor = compactionAnchorAt(this.messages, Date.now());
        this.compactions = applyCompactionEvent(
          this.compactions,
          {
            id: payload.markerId,
            status: payload.status,
            ...(payload.tokensBefore !== undefined ? { tokensBefore: payload.tokensBefore } : {}),
            ...(payload.tokensAfter !== undefined ? { tokensAfter: payload.tokensAfter } : {})
          },
          payload.at,
          anchor
        );
        // r2-②：compaction 推送推进自己的时钟——迟到 history 的旧 compactions 列表
        // 不得删掉本地已出现的 running/complete 标记
        this.compactClock += 1;
        this.snap = null;
        this.notify();
      } else if (payload.kind === 'engine-meta') {
        if (payload.slashCommands) this.slashCommands = payload.slashCommands;
        if (payload.engineMode) this.engineMode = payload.engineMode;
        // r2-②：engine-meta 推送推进自己的时钟——迟到 history 的旧 commands/engineMode
        // 不得回退本地已更新的值
        this.engineClock += 1;
        this.snap = null;
        this.notify();
      }
    });
  }

  /**
   * 单个 part 落定（工具卡新增/出结果）：只替换那一个 part，不重建整条消息树。
   *
   * 消息对象换新引用（行级 memo 靠它识别该行要重渲），其余消息保持原引用不动。
   * 消息找不到或下标跳号（错过前序推送）说明本地已与主进程不同步——立即回退全量
   * 拉取，不能静默丢：丢一个 part 就是工具卡永久缺一块或永远停在「进行中」。
   */
  private applyPart(messageId: string, partIndex: number, part: GuiMessagePart): void {
    // 先排干 delta 队列：队列里的追加按 partIndex 定位，与本次替换同一条消息时顺序敏感
    this.batcher.flush();
    const next = applyGuiMessagePart(this.messages, messageId, partIndex, part);
    if (!next) {
      // A bounded surface may legitimately receive a late update for a message
      // that lives in an unloaded older page. The durable range source will
      // return the updated part when that page is requested. Only a short/full
      // surface treats an unknown target as a true desynchronization.
      if (this.historyHasEarlier && typeof window.api.agentSession.historyRange === 'function') return;
      this.resync();
      return;
    }
    this.messages = next;
    this.msgClock += 1;
    this.touched.set(messageId, this.msgClock);
    this.snap = null;
    this.notify();
  }

  /** 与主进程状态不同步时的兑底：重新拉一次权威快照（与初始 attach 同一条单飞链） */
  private resync(): void {
    this.liveRecoveryPending = true;
    this.liveRecoveryMaxSeq = Math.max(this.liveRecoveryMaxSeq ?? 0, this.liveMessageSeq ?? 0);
    this.liveRecoveryPageSeq = undefined;
    this.fetchHistory();
  }

  /**
   * Message pushes carry the same opaque epoch/revision used by history reads.
   * A repeated revision is a duplicate, a lower revision is stale, and a jump
   * means the renderer missed at least one incremental event. Sync snapshots
   * are bounded authoritative tails, so they can heal a jump directly.
   */
  private observeLiveMessageSeq(
    sequence: number | undefined,
    snapshot: boolean
  ): 'apply' | 'ignore' | 'recover' {
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return 'apply';
    if (this.liveRecoveryPending && !snapshot) {
      this.liveRecoveryMaxSeq = Math.max(this.liveRecoveryMaxSeq ?? 0, sequence);
      return 'ignore';
    }
    const previous = this.liveMessageSeq;
    if (previous === undefined) {
      this.liveMessageSeq = sequence;
      return 'apply';
    }
    if (sequence === previous) return 'ignore';
    if (!snapshot && sequence > previous + 1) {
      this.resync();
      return 'recover';
    }
    if (sequence < previous) {
      this.resync();
      return 'recover';
    }
    this.liveMessageSeq = sequence;
    this.liveRecoveryPending = false;
    return 'apply';
  }

  /** history 单飞拉取：在途期间的新请求记到 historyRefetch，当前响应应用完再拉一次。
   *  防并发 range 乱序互相覆盖，也避免 desync 兑底请求被静默吞掉后卡死。
   *  settle 按发请求时的 epoch 校验：换代后（dispose/重挂）旧 settle 不再碰单飞状态
   *  （r1-2）——旧请求悬挂时重挂能立即发新请求，也不会被旧 settle 误触发追拉。 */
  private fetchHistory(): void {
    if (this.historyPending) {
      this.historyRefetch = true;
      return;
    }
    this.historyPending = true;
    const pageLoad = this.pageMap.startLoad('tail');
    let pageLoadFinished = false;
    const finishPageLoad = (error?: string): void => {
      if (pageLoadFinished) return;
      pageLoadFinished = true;
      this.pageMap.finishLoad(pageLoad, error);
    };
    this.historyError = '';
    this.snap = null; this.notify();
    const cap: HistoryCapture = {
      epoch: this.epoch,
      clearSeq: this.clearSeq,
      syncSeq: this.syncSeq,
      msgClock: this.msgClock,
      busyClock: this.busyClock,
      executionClock: this.executionClock,
      modeClock: this.modeClock,
      usageClock: this.usageClock,
      injClock: this.injClock,
      compactClock: this.compactClock,
      engineClock: this.engineClock,
      presetClock: this.presetClock,
      modelClock: this.modelClock
    };
    const settle = (): void => {
      if (this.epoch !== cap.epoch) return;
      const queuedRecoverySeq=this.liveRecoveryMaxSeq;
      if(queuedRecoverySeq!==undefined&&(this.liveRecoveryPageSeq===undefined
        ?queuedRecoverySeq>(this.liveMessageSeq??0):queuedRecoverySeq>this.liveRecoveryPageSeq))this.historyRefetch=true;
      this.historyPending=false;this.liveRecoveryPending=false;
      this.liveRecoveryMaxSeq=undefined;this.liveRecoveryPageSeq=undefined;
      this.snap=null;this.notify();
      const requested=this.historyRefetch;this.historyRefetch=false;
      if(requested&&this.alive)this.fetchHistory();
    };
    const readingWindow=this.navigationWindow??this.retainedWindow;
    const anchorIndex=this.navigationWindow?.index??this.retainedWindow?.anchorIndex??readingWindow?.start;
    const anchorId=anchorIndex===undefined?undefined:this.pageMap.loadedSlots().find(slot=>slot.index>=anchorIndex&&slot.index<(readingWindow?.end??Infinity))?.messageId;
    // Recovery uses the same bounded source as initial attach. A failed or
    // malformed page remains an error; it never switches to a complete snapshot.
    let request:Promise<GuiWorkerHistoryPage|null>;
    try{request=Promise.resolve(anchorId?window.api.agentSession.historyRange(this.sessionId,undefined,GUI_HISTORY_PAGE_SIZE,anchorId):window.api.agentSession.historyRange(this.sessionId,undefined,GUI_HISTORY_PAGE_SIZE));}
    catch(error){request=Promise.reject(error);}
    void request.then(page=>{
        if(this.epoch!==cap.epoch||this.clearSeq!==cap.clearSeq){finishPageLoad('stale history response');settle();return;}
        if(!isGuiHistoryPage(page))throw new Error('Invalid GUI history range response');
        this.applyHistory(page,cap);
        // A newer sync has already replaced the authoritative message domain.
        // Its page map must not acquire IDs/cursors from this older response.
        if(this.syncSeq===cap.syncSeq){
          this.recordGuiHistoryPage(page,pageLoad.generation);
          const pageIds=new Set(page.messages.map(message=>message.id));
          const pageBoundary=page.messages[0]?.ts;
          const loadedEarlier=pageBoundary===undefined?0:this.messages.filter(message=>!pageIds.has(message.id)&&message.ts<=pageBoundary).length;
          this.historyBefore=Math.max(0,page.before-loadedEarlier);this.historyHasEarlier=this.historyBefore>0;
        }
        finishPageLoad();
        if(typeof page.liveSeq==='number'&&Number.isSafeInteger(page.liveSeq)){
          this.liveMessageSeq=Math.max(this.liveMessageSeq??0,page.liveSeq);this.liveRecoveryPageSeq=page.liveSeq;
        }
        settle();
      }).catch(error=>{
        if(this.epoch!==cap.epoch)return;
        if(this.clearSeq!==cap.clearSeq){finishPageLoad('stale history response');settle();return;}
        this.historyError=String(error);finishPageLoad(String(error));settle();
      });
  }

  /** U1 核心（r1-1 重写为分域应用）：迟到 history 不再「整体作废/整体替换」，
   *  按字段域分别判定——sync 合同只含 messages，其应用只作废快照的消息段：
   *  1) epoch/clearSeq 失配 ⇒ 整体作废（写死会话 / 复活已清历史）。
   *  2) 消息域：syncSeq+msgClock 均未动 ⇒ 本地不新于快照，整表替换（reconcileById
   *     复用引用，touched 清零）；仅 msgClock 动过（delta/part）⇒ 逐消息合并（r1-3：
   *     touched 快于 capture 的保本地增量，否则取快照版本——resync 权威补齐能落地）；
   *     syncSeq 动过 ⇒ 本地整表新于快照，消息段保持本地（不 merge，防复活已删消息）。
   *  3) busy/mode/元数据各按自身时钟：未动取快照值（初次挂载 sync 先到、history 后
   *     到时，mode/preset 等字段仍能可靠装载）；动过保本地（新推送优先）。
   *  flush 排干在途 delta 后才比对时钟：排干本身推动 msgClock/逐消息时钟，正确落入合并分支。 */
  private applyHistory(h: GuiWorkerHistoryPage, cap: HistoryCapture): void {
    if (this.epoch !== cap.epoch || this.clearSeq !== cap.clearSeq) {
      return;
    }
    this.batcher.flush();
    const page = h;
    const pageIds = page ? new Set(page.messages.map(message => message.id)) : null;
    const pageBoundary = page?.messages[0]?.ts;
    const historyMessages = h.messages;
    const incomingMessages = page && page.before > 0
      ? [
          ...this.messages.filter(message => !pageIds!.has(message.id) &&
            (pageBoundary === undefined || message.ts <= pageBoundary)),
          ...page.messages,
          ...this.messages.filter(message => !pageIds!.has(message.id) &&
            (pageBoundary !== undefined && message.ts > pageBoundary))
        ]
      : historyMessages;
    // ── 消息域 ──
    if (this.syncSeq === cap.syncSeq && this.msgClock === cap.msgClock) {
      this.messages = reconcileById(this.messages, incomingMessages);
      // 本地不新于快照：整表权威化，逐消息时钟归零（后续迟到快照从快照版本起算）
      this.touched.clear();
      this.msgClock += 1;

    } else if (this.syncSeq === cap.syncSeq) {
      const merged = mergeGuiHistory(this.messages, incomingMessages, this.touched, cap.msgClock);
      if (merged !== this.messages) {
        this.messages = merged;
        this.msgClock += 1;
      }
    }
    // syncSeq 动过 ⇒ 消息保持本地（sync 整表替换严格新于快照）
    // ── busy 域 ──
    if (this.executionClock === cap.executionClock) {
      this.execution = h.execution;
      this.executionClock += 1;
    }
    if (this.busyClock === cap.busyClock && this.busy !== h.busy) {
      this.busy = h.busy;
      this.busyClock += 1;
    }
    // ── mode 域 ──
    if (h.mode !== undefined && this.modeClock === cap.modeClock) {
      if (this.mode !== h.mode) {
        this.mode = h.mode;
        this.modeClock += 1;
      }
      this.confirmedMode = h.mode;
    }
    // ── 元数据各细分域（r2-①：任一推送先到不再殄及其余字段装载）──
    if (this.usageClock === cap.usageClock && h.usage !== undefined) {
      this.usage = h.usage;
      this.usageClock += 1;
    }
    if (this.presetClock === cap.presetClock && h.piModeId !== undefined && this.piModeId !== h.piModeId) {
      this.piModeId = h.piModeId;
      this.presetClock += 1;
    }
    // r3-① 判代语义已迁移到参数域（泛化体系）：思考字段不再装载（旧结构由
    // 已由通用参数体系取代），旧 era 参数不污染新模型由 parameters 推送身份硬判
    // + loadModelParameters 的 parameterRequest 代共同保证（见推送分支与 refreshModelInfo）。
    if (this.modelClock === cap.modelClock) {
      this.applyHistoryOverride(h);
    }
    if (this.compactClock === cap.compactClock) {
      // Page-owned compaction records are installed together with their body range.
      this.compactClock += 1;
    }
    if (this.injClock === cap.injClock) {
      this.injections = h.injections ?? [];
      this.refreshHarnessSnapshot();
      this.injClock += 1;
    }
    if (this.engineClock === cap.engineClock) {
      if (h.slashCommands) this.slashCommands = h.slashCommands;
      if (h.engineMode) this.engineMode = h.engineMode;
      this.engineClock += 1;
    }
    this.snap = null;
    this.notify();
  }

  /** Load one older GUI Worker page and prepend it without disturbing live tail updates. */
  async loadEarlier(): Promise<void> {
    if (!this.historyHasEarlier || this.historyBefore === undefined) return;
    return this.loadPage(this.historyBefore);
  }

  private async fetchPage(before?: number, targetMessageId?: string): Promise<void> {
    const rangeApi = window.api.agentSession.historyRange;
    if (typeof rangeApi !== 'function') return;
    const epoch = this.epoch;
    const clearSeq = this.clearSeq;
    const capSyncSeq = this.syncSeq;
    const capMsgClock = this.msgClock;
    const pageLoad = this.pageMap.startLoad('earlier');
    let pageLoadFinished = false;
    const finishPageLoad = (error?: string): void => {
      if (pageLoadFinished) return;
      pageLoadFinished = true;
      this.pageMap.finishLoad(pageLoad, error);
    };
    this.snap = null;
    this.notify();
    try {
      const page = targetMessageId
        ? await rangeApi(this.sessionId, before, GUI_HISTORY_PAGE_SIZE, targetMessageId)
        : await rangeApi(this.sessionId, before, GUI_HISTORY_PAGE_SIZE);
      if (this.epoch !== epoch || this.clearSeq !== clearSeq || this.syncSeq !== capSyncSeq || !isGuiHistoryPage(page)) {
        finishPageLoad('stale or invalid history page');
        if (this.epoch === epoch && this.clearSeq === clearSeq) {
          this.snap = null;
          this.notify();
        }
        return;
      }
      if (page.messages.length === 0) { finishPageLoad(); return; }
      if (targetMessageId) {
        const offset = page.messages.findIndex(message => message.id === targetMessageId);
        if (offset >= 0) this.navigationWindow = { start: page.before, end: page.before + page.messages.length, index: page.before + offset };
      }
      if (targetMessageId || !this.retainedWindow) {
        this.retainedWindow = { start: page.before, end: page.before + page.messages.length };
      }
      const existingIds = new Set(this.messages.map(message => message.id));
      const older = page.messages.filter(message => !existingIds.has(message.id));
      const pageById = new Map(page.messages.map(message => [message.id, message]));
      const mergedCurrent = this.messages.map(message => {
        const pageMessage = pageById.get(message.id);
        if (!pageMessage) return message;
        const touched = this.touched.get(message.id);
        const localAhead = this.msgClock > capMsgClock || (touched !== undefined && touched > capMsgClock);
        if (!localAhead) return pageMessage;
        // A live delta landed while the older page was in flight. Keep the
        // newer local projection and only append durable parts the page knows
        // about beyond the local prefix.
        return pageMessage.parts.length > message.parts.length
          ? { ...message, parts: [...message.parts, ...pageMessage.parts.slice(message.parts.length)] }
          : message;
      });
      const hasOverlap = page.messages.some(message => existingIds.has(message.id));
      if (older.length || hasOverlap) {
        this.messages = [...older, ...mergedCurrent];
        this.msgClock += 1;
      }
      if (!targetMessageId && this.historyBefore === before) {
        this.historyBefore = page.before;
        this.historyHasEarlier = page.hasEarlier;
      }
      this.recordGuiHistoryPage(page, pageLoad.generation);
      finishPageLoad();
      this.historyError = '';
      if (typeof page.liveSeq === 'number' && Number.isSafeInteger(page.liveSeq)) {
        this.liveMessageSeq = Math.max(this.liveMessageSeq ?? 0, page.liveSeq);
      }
      this.snap = null;
      this.notify();
    } catch (error) {
      finishPageLoad(String(error));
      if (this.epoch === epoch && this.clearSeq === clearSeq) {
        this.historyError = String(error);
        this.snap = null;
        this.notify();
      }
    } finally {
      if (this.epoch === epoch && this.clearSeq === clearSeq) {
        this.snap = null;
        this.notify();
      }
    }
  }

  /** history 模型覆盖段（r3-② 修正）；应用即推 modelClock。生产 getHistory 透传
 *  完整 override（host/settings.ts:347，含 params）：快照携带 params ⇒ 权威采纳
 *  （即使与本地不同——同 id 新 effort 覆盖旧值）；字段缺失（防御性兼容非生产
 *  形态）⇒ 同 id 时保留本地 params，不静默丢参数选择。 */
  private applyHistoryOverride(h: GuiWorkerHistoryPage): void {
    const prevOverride = this.sessionModel;
    const snapFull = h.modelOverride as
      | { providerId: string; modelId: string; params?: Array<{ id: string; value: string }> }
      | null
      | undefined;
    const snap = snapFull ?? null;
    const next: {
      providerId: string;
      modelId: string;
      params?: Array<{ id: string; value: string }>;
    } | null =
      snap && snap.params === undefined && prevOverride &&
      prevOverride.providerId === snap.providerId &&
      prevOverride.modelId === snap.modelId &&
      prevOverride.params?.length
        ? { ...snap, params: prevOverride.params }
        : snap;
    const overrideChanged =
      prevOverride?.providerId !== next?.providerId ||
      prevOverride?.modelId !== next?.modelId ||
      JSON.stringify(prevOverride?.params ?? null) !== JSON.stringify(next?.params ?? null);
    if (overrideChanged) {
      ++this.parameterRequest;
      this.modelParameters = [];
      this.parameterModelInfo = null;
    }
    if (overrideChanged) {
      this.sessionModel = next;
      this.modelClock += 1;
      this.refreshModelInfo();
    }
  }

  private refreshModelInfo(refreshParameters = true): void {
    if (refreshParameters) this.loadModelParameters();
    if (this.runtime.codex) {
      this.modelInfo = this.codexModelInfo();
      this.snap = null;
      this.notify();
      return;
    }
    const epoch = this.epoch;
    const request = ++this.modelInfoRequest;
    void window.api.config.get().then(async c => {
      if (this.epoch !== epoch || this.modelInfoRequest !== request) return;
      const info = this.runtime.claude || this.harnessModelRuntime ? null : modelInfoFromConfig(c, this.sessionModel);
      if (this.runtimeId === 'pi' && info) {
        const input = await window.api.config.coreModelInput?.({ providerId: info.providerId, modelId: info.modelId }).catch(() => undefined);
        if (input) info.supportsImages = input.supportsImages;
      }
      if (this.epoch !== epoch || this.modelInfoRequest !== request) return;
      this.modelInfo = info;
      this.snap = null;
      this.notify();
    });
  }

  private codexModelInfo(): NonNullable<AgentSessionSurfaceStore['modelInfo']> {
    const selected = this.modelSelectionsReady ? this.modelSelections['runtime:codex-gui'] : undefined;
    const defaultId = !this.modelSelectionsReady ? '' : selected === undefined || selected.includes(this.codexDefaultModel)
      ? this.codexDefaultModel : this.codexCatalog.find(item => selected.includes(item.id))?.id ?? '';
    const id = this.sessionModel?.modelId || defaultId;
    return { providerId: 'codex-gui', modelId: id || 'default',
      label: this.codexCatalog.find((item) => item.id === id)?.displayName || id || 'Codex', supportsImages: true };
  }

  /** 独立 CLI 目录：失败仍显示重试入口，绝不展示全局 provider 的模型。 */
  async loadCodexCatalog(refresh = false): Promise<void> {
    if (!this.runtime.codex) return;
    const request = ++this.codexCatalogRequest;
    if (refresh) this.codexManualPending = true;
    const failed = (error: string): void => {
      if (!this.alive || request !== this.codexCatalogRequest) return;
      this.codexCatalogWarning = error;
      if (refresh) this.deps?.flashTip(error);
      this.modelInfo = this.codexModelInfo();
      this.snap = null;
      this.notify();
    };
    return window.api.agentSession.listCodexModels(this.sessionId, refresh).then((r) => {
      if (!this.alive || request !== this.codexCatalogRequest) return;
      if (!r?.ok) return failed(r?.error || t('Codex 未返回模型目录，请检查 CLI 登录与配置'));
      this.codexCatalog = r.items;
      this.loadModelParameters();
      this.codexDefaultModel = r.defaultModelId;
      this.codexCatalogWarning = r.warning || '';
      if (r.warning) this.deps?.flashTip(r.warning);
      this.modelInfo = this.codexModelInfo();
      this.snap = null;
      this.notify();
    }).catch((e) => failed((e as Error).message))
      .finally(() => { if (refresh && this.codexCatalogRequest === request) this.codexManualPending = false; });
  }

  async send(text: string, images?: ChatImageAttachment[]): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed && !images?.length) return true;
    try {
      // 忙时一律排队（统一排队面板「排队自动发送」语义）；插话只经 sendNow 显式触发
      const res = await window.api.agentSession.send(this.sessionId, trimmed, images, {
        steerOnBusy: false
      });
      if (!res?.ok) {
        if (res?.error) this.deps?.flashTip(localizeGuiHostError(res.error));
        return false;
      }
      return true;
    } catch (e) {
      this.deps?.flashTip(
        this.deps?.t('发送失败：{{message}}', { message: localizeGuiHostError((e as Error).message) }) ?? ''
      );
      return false;
    }
  }

  /**
   * 立即发送（统一排队面板「立即」）：Host 忙时优先 redirect（Pi steer 插话），
   * 不支持则返回 unsupported，由 GUI 输入层决定邮箱或中断后发送。
   */
  async sendNow(text: string): Promise<'sent' | 'steered' | 'unsupported' | 'queued' | 'failed'> {
    const trimmed = text.trim();
    if (!trimmed) return 'failed';
    try {
      const res = await window.api.agentSession.send(this.sessionId, trimmed, undefined, {
        steerOnBusy: true
      });
      if (!res?.ok) {
        if (res?.error) this.deps?.flashTip(localizeGuiHostError(res.error));
        return 'failed';
      }
      if (res.steerUnsupported) return 'unsupported';
      if (res.steered) return 'steered';
      // Adapter-owned native queues do not satisfy the Composer's immediate
      // steer contract. The workbench owns the fallback queue and dialog.
      if (res.queued) return 'unsupported';
      return 'sent';
    } catch {
      return 'failed';
    }
  }

  /**
   * 「立即」兜底：引擎不支持 steer 时由 Composer 显式选择通道。
   * mail = 投递员工邮箱；interrupt = 中断当前回合后重发（保留宿主队列，
   * 否则 Composer 移除该行时会被 drain 抢先提交，插入重复消息）。
   */
  async sendNowFallback(text: string, method: 'mail' | 'interrupt'): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;
    try {
      if (method === 'mail') {
        const result = await window.api.sessions.sendMessage({ sessionId: this.sessionId, text: trimmed });
        return !!result?.ok;
      }
      await window.api.agentSession.abort(this.sessionId, { holdQueue: true });
      const result = await window.api.agentSession.send(this.sessionId, trimmed, undefined, {
        steerOnBusy: false
      });
      return !!result?.ok && !result.queued;
    } catch (e) {
      this.deps?.flashTip(
        this.deps?.t('发送失败：{{message}}', { message: localizeGuiHostError((e as Error).message) }) ?? ''
      );
      return false;
    }
  }

  stop(): void {
    void window.api.agentSession.abort(this.sessionId);
  }

  /** 手动压缩：乐观插入进行中分割线；成败由 compaction 事件收口，失败再摘线。
   *  错误文案仍回给 Composer hint；成功不再 flashTip（GUI 会话看不见调度气泡）。 */
  async compact(instructions?: string): Promise<{ ok: boolean; error?: string }> {
    const pendingId = newPendingCompactionId();
    this.compactions = beginCompaction(this.compactions, pendingId, Date.now());
    // r2-②：本地压缩标记变更推 compactClock——迟到 history 的旧列表不删本地标记
    this.compactClock += 1;
    this.snap = null;
    this.notify();
    try {
      const r = await window.api.agentSession.compact({
        sessionId: this.sessionId,
        instructions
      });
      if (!r.ok) {
        this.compactions = dropCompaction(this.compactions, pendingId);
        this.compactClock += 1;
        this.snap = null;
        this.notify();
        return r.error ? { ...r, error: localizeGuiHostError(r.error) } : r;
      }
      this.compactions = completePendingCompaction(
        this.compactions,
        pendingId,
        compactionAnchorAt(this.messages, Date.now())
      );
      this.compactClock += 1;
      this.snap = null;
      this.notify();
      return r;
    } catch (e) {
      this.compactions = dropCompaction(this.compactions, pendingId);
      this.compactClock += 1;
      this.snap = null;
      this.notify();
      const msg = localizeGuiHostError((e as Error).message);
      this.deps?.flashTip(this.deps?.t('压缩失败：{{message}}', { message: msg }) ?? '');
      return { ok: false, error: msg };
    }
  }

  async clear(): Promise<void> {
    // clear 先于 IPC 失效在途 history：clear 之前发出的快照不得在清空后回写旧消息
    this.clearSeq += 1;
    this.historyBefore = undefined;
    this.historyHasEarlier = false;
    this.pageMap.reset();
      this.metadataMessages.clear(); this.liveInjections = []; this.injections = []; this.refreshHarnessSnapshot();
    this.retainedWindow = undefined;
    this.navigationWindow = undefined;
    this.rangeRequests.clear();
    this.compactions = [];
    this.snap = null;
    this.notify();
    try { await window.api.agentSession.clear(this.sessionId); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      const translated = localizeGuiHostError(error.message);
      if (translated === error.message) throw error;
      const copy = new Error(translated, { cause: error }); copy.name = error.name; throw copy;
    }
  }

  /** 失败回合重试：走 Host.retry——复用原用户消息、替换失败 assistant，不追加副本 */
  retry(): void {
    void window.api.agentSession.retry(this.sessionId).then((r) => {
      if (r && !r.ok && r.error) this.deps?.flashTip(r.error);
    }).catch((e) => {
      this.deps?.flashTip((e as Error).message);
    });
  }

  /** 重新编辑已终止回合的用户消息：移除该轮用户消息与已终止助手回复，返回原文与图片 */
  async recallAborted(
    messageId?: string
  ): Promise<{ ok: boolean; text?: string; images?: ChatImageAttachment[]; error?: string }> {
    try {
      const res = await window.api.agentSession.recallAborted(this.sessionId, messageId);
      if (!res?.ok) {
        return { ok: false, error: res?.error };
      }
      const loc = locateAbortedTurn(this.messages, messageId);
      if (loc) {
        const head = this.messages.slice(0, loc.userIdx);
        const tailQueued = this.messages.slice(loc.userIdx).filter((m) => m.queued);
        this.messages = [...head, ...tailQueued];
        this.syncSeq += 1;
        this.msgClock += 1;
        this.snap = null;
        this.notify();
      }
      return {
        ok: true,
        text: res.text ?? '',
        ...(res.images?.length ? { images: res.images } : {})
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // X4-F04：排队三通道 {ok,error?} 合同——失败/未就绪上浮，不再零反馈（消息卡队列不可见）
  cancelQueued(messageId: string): void {
    void window.api.agentSession.cancelQueued(this.sessionId, messageId).then((r) => {
      if (r && !r.ok && r.error) this.deps?.flashTip(r.error);
    }).catch((e) => {
      this.deps?.flashTip((e as Error).message);
    });
  }

  editQueued(messageId: string, text: string): void {
    void window.api.agentSession.editQueued(this.sessionId, messageId, text).then((r) => {
      if (r && !r.ok && r.error) this.deps?.flashTip(r.error);
    }).catch((e) => {
      this.deps?.flashTip((e as Error).message);
    });
  }

  reorderQueued(orderedIds: string[]): void {
    void window.api.agentSession.reorderQueued(this.sessionId, orderedIds).then((r) => {
      if (r && !r.ok && r.error) this.deps?.flashTip(r.error);
    }).catch((e) => {
      this.deps?.flashTip((e as Error).message);
    });
  }

  /** 排队条目随文图片（跨泳道 auto→manual 补全；快照只带张数） */
  getQueuedImages(messageId: string) {
    const m = this.visibleMessages().find((x) => x.id === messageId);
    return m?.images;
  }

  async fork(messageId: string): Promise<void> {
    const deps = this.deps;
    try {
      const res = await window.api.agentSession.fork(this.sessionId, messageId);
      if (res?.ok && res.sessionId) {
        deps?.flashTip(deps?.t('已分叉出新会话') ?? '');
        await jumpToSession({ sessionId: res.sessionId });
      } else if (res?.error) {
        deps?.flashTip(localizeGuiForkError(res.error));
      }
    } catch (e) {
      deps?.flashTip(
        deps?.t('分叉失败：{{message}}', { message: localizeGuiHostError((e as Error).message) }) ?? ''
      );
    }
  }

  /** 模式切换（chip 点击循环；主进程即时生效）。乐观更新；请求经串行队列按发出顺序
   *  在主进程落定（U2）：失败只回滚仍属于最新请求的乐观态，目标是最居后一次被主进程
   *  确认的值（confirmedMode）——旧请求晚到的失败/成功不再覆盖新选择；切会话（epoch
   *  变化）后回调直接作废，不内 UI 提示也不触碰状态。 */
  async setMode(next: GuiWorkerMode): Promise<void> {
    const req = ++this.modeReq;
    if (this.mode !== next) {
      this.mode = next;
      this.modeClock += 1;
      this.snap = null;
      this.notify();
    }
    // r1-4：生命周期在入队时绑定——dispose 后排队的请求不再发 IPC、不回写死 store
    const epoch = this.epoch;
    const strategyClock = this.permissionStrategyClock;
    const run = this.modeChain.then(() => this.runSetMode(next, req, epoch, strategyClock));
    this.modeChain = run.catch(() => undefined);
    await run;
  }

  private async runSetMode(next: GuiWorkerMode, req: number, epoch: number, strategyClock: number): Promise<void> {
    if (this.epoch !== epoch || this.permissionStrategyClock !== strategyClock) return; // 入队后已换代（切会话/重挂）：不发 IPC、不回写
    try {
      const res = await window.api.agentSession.setMode(this.sessionId, next);
      if (this.epoch !== epoch || this.permissionStrategyClock !== strategyClock) return;
      if (res && !res.ok) {
        if (this.modeReq === req && this.mode !== this.confirmedMode) {
          this.mode = this.confirmedMode;
          this.modeClock += 1;
          this.snap = null;
          this.notify();
        }
        if (res.error) this.deps?.flashTip(res.error);
      } else {
        // 串行队列内接续落定 ⇒ 这是最新一次成功；即使不是最新请求也推进 confirmedMode，
        // 供后续失败回滚到正确基准。r2-③：成功确认本身即一次权威应用——无条件推进
        // modeClock，使在确认之前 capture 的迟到 history 的 mode 段作废（否则
        // 成功后旧快照后到会把 plan→auto、confirmedMode 退回）
        this.confirmedMode = next;
        this.modeClock += 1;
        if (this.modeReq === req && this.mode !== next) {
          this.mode = next;
          this.snap = null;
          this.notify();
        }
      }
    } catch (e) {
      if (this.epoch !== epoch || this.permissionStrategyClock !== strategyClock) return;
      if (this.modeReq === req && this.mode !== this.confirmedMode) {
        this.mode = this.confirmedMode;
        this.modeClock += 1;
        this.snap = null;
        this.notify();
      }
      this.deps?.flashTip(
        this.deps?.t('模式切换失败：{{message}}', { message: (e as Error).message }) ?? ''
      );
    }
  }

  planAction(action: 'execute' | 'abandon' | 'revise', feedback?: string): void {
    // 修改意见走发消息通道：模式保持 plan，修订回合结束后 Host 自动挂新版计划卡
    if (action === 'revise') {
      if (feedback) void this.send(feedback);
      return;
    }
    void window.api.agentSession
      .planAction(this.sessionId, action)
      .then((res) => {
        if (!res?.ok && res?.error) this.deps?.flashTip(res.error);
      })
      .catch((e) => {
        this.deps?.flashTip(
          this.deps?.t('计划操作失败：{{message}}', { message: (e as Error).message }) ?? ''
        );
      });
  }

  /** 参数域按模型判代（r3-① 泛化迁移）：请求时捕获会话模型身份，响应回来时
 *  已切换模型（sessionModel 变更）⇒ 丢弃旧 era 快照；setModel 成功路径
 *  refreshModelInfo→loadModelParameters 的新请求（++parameterRequest）会作废
 *  在途旧响应，此处身份硬判是双保险（覆盖推送后补拉等交叉路径）。 */
  loadModelParameters(): void {
    const request = ++this.parameterRequest;
    const modelAtRequest = this.sessionModel
      ? `${this.sessionModel.providerId}|${this.sessionModel.modelId}`
      : null;
    void window.api.agentSession.getModelParameters(this.sessionId).then(snapshot => {
      if (!this.alive || request !== this.parameterRequest || !snapshot) return;
      const modelNow = this.sessionModel
        ? `${this.sessionModel.providerId}|${this.sessionModel.modelId}`
        : null;
      if (modelNow !== modelAtRequest) return; // 模型已切换：旧 era 参数不应用
      this.modelParameters = snapshot.controls;
      this.parameterModelInfo = snapshot.controls.length ? { providerId: snapshot.providerId, modelId: snapshot.modelId, label: snapshot.modelId || snapshot.runtimeId } : null;
      if (snapshot.warning && !snapshot.unavailable) this.deps?.flashTip(snapshot.warning);
      this.snap = null;
      this.notify();
    }).catch(e => { if (this.alive && request === this.parameterRequest) this.deps?.flashTip((e as Error).message); });
  }

  async setModelParameter(id: string, value: string | null): Promise<{ ok: boolean; error?: string }> {
    let result: Awaited<ReturnType<typeof window.api.agentSession.setModelParameters>>;
    try {
      result = await window.api.agentSession.setModelParameters(this.sessionId, { [id]: value });
    } catch (e) {
      this.deps?.flashTip((e as Error).message || t('参数设置失败'));
      return { ok: false, error: (e as Error).message };
    }
    if (result.ok) {
      ++this.parameterRequest;
      this.modelParameters = result.snapshot?.controls ?? this.modelParameters;
      if (result.applied === 'next-turn') this.deps?.flashTip(t('下一轮生效'));
      this.snap = null;
      this.notify();
    }
    return result;
  }

  setModelConfiguration(input: Omit<SetModelConfigurationInput, 'sessionId'>): Promise<SetModelConfigurationResult> {
    const epoch = this.epoch;
    const stale = (): SetModelConfigurationResult => ({ ok: false, error: t('会话配置已变化，请重新读取') });
    const operation = this.modelChain.then(async (): Promise<SetModelConfigurationResult> => {
      if (!this.alive || epoch !== this.epoch) return stale();
      const result = await window.api.agentSession.setModelConfiguration({ ...input, sessionId: this.sessionId });
      if (!this.alive || epoch !== this.epoch) return stale();
      if (!result.ok) return result;
      const changed = this.sessionModel?.providerId !== input.model?.providerId || this.sessionModel?.modelId !== input.model?.modelId;
      this.sessionModel = input.model;
      this.modelClock++;
      this.parameterRequest++;
      if (changed) {
        this.modelParameters = [];
        this.parameterModelInfo = null;
        this.usage = null;
        this.usageClock++;
        if (this.harnessIdentity) this.harnessIdentity = { ...this.harnessIdentity, modelOverride: input.model };
      }
      if (result.warning) this.deps?.flashTip(result.warning);
      if (result.applied === 'next-turn') this.deps?.flashTip(t('下一轮生效'));
      this.snap = null;
      this.notify();
      this.refreshModelInfo();
      return result;
    });
    this.modelChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** 会话级模型覆盖（null=跟随引擎默认）；下回合以新模型重建连接。
   *  与 setMode 同类入口加固（串行队列 + 生命周期校验；报告仅实测 mode，此处为
   *  同链路有据加固：旧请求晚到不覆盖新设置）。 */
  setModel(m: { providerId: string; modelId: string; params?: Array<{ id: string; value: string }> } | null): void {
    // r1-4：与 setMode 同型——生命周期在入队时绑定
    const epoch = this.epoch;
    const expected = this.harnessModelRuntime ? this.harnessIdentity : undefined;
    if (this.harnessModelRuntime && !expected) { this.deps?.flashTip(t('请先同步会话模型设置')); return; }
    const run = this.modelChain.then(() => this.runSetModel(m, epoch, expected ?? undefined));
    this.modelChain = run.catch(() => undefined);
  }

  private async runSetModel(m: { providerId: string; modelId: string; params?: Array<{ id: string; value: string }> } | null, epoch: number, expected?: SessionHarnessModelExpected): Promise<void> {
    if (this.epoch !== epoch) return; // 入队后已换代：不发 IPC、不回写
    try {
      const r = await window.api.agentSession.setModel(this.sessionId, m, expected);
      if (this.epoch !== epoch) return;
      if (!r.ok) {
        if (expected) { this.resetHarnessCatalog(); this.harnessCatalogState = 'error'; this.harnessCatalogError = r.error || t('模型切换失败'); this.snap = null; this.notify(); }
        if (r.error) this.deps?.flashTip(localizeGuiHostError(r.error));
        return;
      }
      // r2-④：主变更立即应用并推 modelClock——后续任何 await 窗口内到达的旧 resync
      // 快照的 modelOverride 段因时钟已动而作废，不会回退成 default/unpinned
      if (JSON.stringify(this.sessionModel) !== JSON.stringify(m)) {
        ++this.parameterRequest;
        this.modelParameters = [];
        this.parameterModelInfo = null;
      }
      this.sessionModel = m;
      if (expected && this.harnessIdentity) {
        const actual = this.harnessIdentity;
        const sameBinding = actual.runtimeId === expected.runtimeId && actual.cwd === expected.cwd && actual.catalogCwd === expected.catalogCwd && actual.workspaceId === expected.workspaceId &&
          actual.workspaceFingerprint === expected.workspaceFingerprint && actual.engineFingerprint === expected.engineFingerprint &&
          actual.presetId === expected.presetId && actual.agentId === expected.agentId && actual.agentFingerprint === expected.agentFingerprint &&
          JSON.stringify(actual.modelOverride) === JSON.stringify(expected.modelOverride);
        if (sameBinding) this.harnessIdentity = { ...actual, modelOverride: m };
        else this.resetHarnessCatalog();
      }
      this.modelClock += 1;
      if (r.warning) this.deps?.flashTip(r.warning);
      this.usage = null;
      this.usageClock += 1;
      this.snap = null;
      this.notify();
      // 参数域换代：新模型参数面板由 refreshModelInfo→loadModelParameters 重拉
      // （host 侧 reconcileModelParameters 已清理不兼容 override）
      this.refreshModelInfo();
    } catch (e) {
      if (this.epoch !== epoch) return;
      if (expected) { this.resetHarnessCatalog(); this.harnessCatalogState = 'error'; this.harnessCatalogError = (e as Error).message || String(e); this.snap = null; this.notify(); }
      this.deps?.flashTip(
        this.deps?.t('模型切换失败：{{message}}', { message: localizeGuiHostError((e as Error).message) }) ?? ''
      );
    }
  }

  private resetHarnessCatalog(): void {
    const requestId = this.harnessCatalogRequest;
    this.harnessCatalogRequest = null;
    this.harnessCatalogUpdatePending = false;
    this.harnessCatalog = [];
    this.harnessCatalogState = 'idle';
    this.harnessCatalogError = '';
    this.harnessIdentity = null;
    this.harnessStateSeq++;
    this.snap = null;
    if (requestId) void window.api.agentSession.cancelHarnessModels(requestId).catch(error => console.warn('模型目录取消失败', error));
  }

  async refreshHarnessModelState(preserveCatalog = false): Promise<void> {
    const runtimeId = this.harnessModelRuntime;
    if (!this.alive || !runtimeId) return;
    const previousIdentity = this.harnessIdentity;
    if (!preserveCatalog) this.resetHarnessCatalog();
    const epoch = this.epoch, request = ++this.harnessStateSeq;
    const previousPresetClock = this.presetClock, previousModelClock = this.modelClock;
    this.harnessCatalogState = 'loading'; this.snap = null; this.notify();
    try {
      const result = await window.api.agentSession.getSessionHarnessModelState(this.sessionId);
      if (!this.alive || this.epoch !== epoch || this.harnessStateSeq !== request) return;
      if (!result.ok) { this.harnessIdentity = null; this.harnessCatalog = []; this.harnessCatalogState = 'error'; this.harnessCatalogError = result.error; return; }
      if (result.expected.runtimeId !== runtimeId ||
          this.presetClock !== previousPresetClock && this.piModeId !== (result.expected.presetId ?? '') ||
          this.modelClock !== previousModelClock && JSON.stringify(this.sessionModel) !== JSON.stringify(result.expected.modelOverride)) {
        this.harnessIdentity = null; this.harnessCatalog = [];
        this.harnessCatalogState = 'error'; this.harnessCatalogError = t('会话配置已变化，请重新读取'); return;
      }
      if (runtimeId === 'acp' && this.piModeId !== (result.expected.presetId ?? '')) {
        this.piModeId = result.expected.presetId ?? ''; this.presetClock++;
      }
      if (JSON.stringify(this.sessionModel) !== JSON.stringify(result.expected.modelOverride)) {
        this.sessionModel = result.expected.modelOverride; this.modelClock++;
        this.usage = null; this.usageClock++;
      }
      if (preserveCatalog && JSON.stringify(previousIdentity) !== JSON.stringify(result.expected)) this.harnessCatalog = [];
      this.harnessIdentity = result.expected;
      this.harnessCatalogState = 'idle';
    } catch (error) {
      if (this.alive && this.epoch === epoch && this.harnessStateSeq === request) {
        this.harnessIdentity = null; this.harnessCatalog = [];
        this.harnessCatalogState = 'error'; this.harnessCatalogError = (error as Error).message || String(error);
      }
    } finally {
      if (this.alive && this.epoch === epoch && this.harnessStateSeq === request) { this.snap = null; this.notify(); }
    }
  }

  async loadHarnessCatalog(refresh = true): Promise<void> {
    const runtimeId = this.harnessModelRuntime;
    const expected = this.harnessIdentity;
    if (!this.alive || !runtimeId || !expected || this.harnessCatalogRequest) return;
    const epoch = this.epoch;
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++this.harnessCatalogSeq).toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.harnessCatalogRequest = requestId;
    this.harnessCatalogState = 'loading'; this.harnessCatalogError = '';
    this.snap = null; this.notify();
    try {
      const result = await window.api.agentSession.listSessionHarnessModels({ sessionId: this.sessionId, requestId, expected, refresh });
      if (!this.alive || this.epoch !== epoch || this.harnessCatalogRequest !== requestId) {
        if (!result.ok && result.cleanupFailed) notifyComposerError(t('模型探测进程回收失败：{{message}}', { message: result.error }));
        return;
      }
      if (!result.ok) { this.harnessCatalogState = 'error'; this.harnessCatalogError = result.error; }
      else if (result.runtimeId !== runtimeId || (runtimeId === 'acp' && result.agentId !== expected.agentId)) { this.harnessIdentity = null; this.harnessCatalogState = 'error'; this.harnessCatalogError = t('会话引擎已变化，请重试'); }
      else { this.harnessCatalog = result.items; this.harnessCatalogState = 'ready'; if (result.warning) this.deps?.flashTip(result.warning); this.loadModelParameters(); }
    } catch (error) {
      if (this.alive && this.epoch === epoch && this.harnessCatalogRequest === requestId) {
        this.harnessIdentity = null; this.harnessCatalogState = 'error'; this.harnessCatalogError = (error as Error).message || String(error);
      }
    } finally {
      if (this.alive && this.epoch === epoch && this.harnessCatalogRequest === requestId) {
        this.harnessCatalogRequest = null; this.snap = null; this.notify();
        if (this.harnessCatalogUpdatePending) { this.harnessCatalogUpdatePending = false; void this.loadHarnessCatalog(false); }
      }
    }
  }

  /** 模式胶囊花名册（现拉不缓存）；pi 空串=标准（无自定义模式）置顶 */
  async loadPresetRoster(): Promise<ChatPresetRosterItem[] | null> {
    if (this.pi) {
      const roster = await window.api.agentSession.listPiModes();
      if (!roster) return null;
      return [
        {
          id: '',
          name: this.deps?.t('标准') ?? t('标准'),
          description: this.deps?.t('不带自定义模式，直接开工') ?? '',
          trust: 'system' as const,
          order: 0,
          broken: undefined
        },
        ...roster
      ];
    }
    if (this.acp) {
      const roster = await window.api.agentSession.listAcpAgents();
      if (!roster) return null;
      return [
        {
          id: '',
          name: this.deps?.t('自动（PATH 上第一个可用）') ?? t('自动'),
          description: this.deps?.t('优先 OpenCode，其次 Gemini') ?? '',
          trust: 'system' as const,
          order: 0,
          broken: undefined
        },
        ...roster
      ];
    }
    return null;
  }

  async changePreset(presetId: string): Promise<void> {
    if (this.pi || this.acp) {
      const epoch = this.epoch;
      let r: Awaited<ReturnType<typeof window.api.agentSession.setPiMode>>;
      try {
        r = await window.api.agentSession.setPiMode(this.sessionId, presetId);
      } catch (e) {
        this.deps?.flashTip((e as Error).message || t('模式切换失败'));
        return;
      }
      if (this.epoch !== epoch) return;
      if (r.ok) {
        this.piModeId = presetId;
        if (this.acp) this.resetHarnessCatalog();
        this.presetClock += 1;
        this.snap = null;
        this.notify();
      } else {
        if (r.error) this.deps?.flashTip(r.error);
      }
    }
  }

  private batcher = createRafBatcher<{
    messageId: string;
    partIndex: number;
    deltaKind: 'text' | 'thinking';
    delta: string;
  }>({
    apply: (queue) => {
      // 聚合：同一 (messageId, partIndex, kind) 的增量拼成一段，一次落地
      const acc = new Map<
        string,
        { messageId: string; partIndex: number; deltaKind: 'text' | 'thinking'; text: string }
      >();
      for (const d of queue) {
        const key = `${d.messageId}\0${d.partIndex}\0${d.deltaKind}`;
        const hit = acc.get(key);
        if (hit) hit.text += d.delta;
        else
          acc.set(key, {
            messageId: d.messageId,
            partIndex: d.partIndex,
            deltaKind: d.deltaKind,
            text: d.delta
          });
      }
      let next = this.messages;
      let changed = false;
      for (const a of acc.values()) {
        const applied = next.map((m) =>
          m.id !== a.messageId ? m : applyGuiMessageDelta(m, a.partIndex, a.deltaKind, a.text)
        );
        if (applied.some((m, i) => m !== next[i])) changed = true;
        next = applied;
      }
      if (!changed) {
        // During the initial bounded range request the live tail may arrive
        // first. Do not silently lose that delta. Ask for another bounded
        // range once the in-flight request settles. Older unloaded pages are
        // intentionally left alone and will be repaired by loadEarlier.
        if (this.historyPending) this.resync();
        return;
      }
      this.messages = next;
      this.msgClock += 1;
      for (const a of acc.values()) this.touched.set(a.messageId, this.msgClock);
      this.snap = null;
      this.notify();
    }
  });
}

/** delta 合批器随 store 实例持有（dispose 时清理定时器） */

/** 会话能力位 → 统一 caps（Composer/视图的渲染分支全部由它驱动；导出供单测覆盖） */
export function capsFor(sessionId: string, runtimeId: string | undefined, variant: 'full' | 'extension' = 'full'): ChatSurfaceCaps {
  const isPi = runtimeId === 'pi';
  const caps = capabilitiesOf(runtimeId);
  // 扩展 Agent 侧栏是面板内助手：不显示模式选择与权限档位（会话固定 standard 档）。
  if (variant === 'extension') {
    return {
      surfaceKind: 'gui-session',
      draftKey: `agent-session:${sessionId}`,
      images: !!caps?.images,
      plusMenu: true,
      bgTasks: true,
      fork: true,
      notes: true,
      presets: false,
      modeOrder: [],
      modeLabels: {},
      modeDescriptions: {},
      modeDisabled: {},
      modeLockOnBusy: false,
      localCommands: false,
      manualCompact: isPi
    };
  }
  const choices = guiPermissionOptions(runtimeId);
  const labels = [...choices, ...guiPermissionOptions(runtimeId, 'default'), ...guiPermissionOptions(runtimeId, 'ask')];
  return {
    surfaceKind: 'gui-session',
    draftKey: `agent-session:${sessionId}`,
    images: !!caps?.images,
    plusMenu: true,
    bgTasks: true,
    fork: true,
    notes: true,
    // ACP preset is the harness identity, not an in-conversation mode.
    presets: isPi,
    presetLabels: {
      title:
        runtimeId === 'acp'
          ? t('引擎：选择本次对话的 ACP agent（OpenCode / Gemini）')
          : t('模式：选择本次对话的自定义模式（创造模式可现场创作）'),
      lockedTitle: t('对话开始后模式锁定，不可中途切换'),
      lockedNote: t('对话开始后模式锁定，不可中途切换')
    },
    modeOrder: choices.map(option => option.mode),
    // Keep translation keys here: the surface is memoized across locale changes.
    modeLabels: Object.fromEntries(labels.map(option => [option.mode, option.label])),
    modeDescriptions: Object.fromEntries(labels.map(option => [option.mode, option.description])),
    modeDisabled: Object.fromEntries(choices.filter(option => option.disabled).map(option => [option.mode, true])),
    modeLockOnBusy: !!caps?.modeSwitchReconnects,
    localCommands: false,
    // 手动压缩只有 pi SDK 有入口（/compact）；能力表 manualCompact 单源
    manualCompact: isPi
  };
}

/** P1-4：按 id 对齐 + guiChatMessageEqual 判等复用旧引用——attach/resync/切服务商
 *  后续 sync 推送的整体替换不再把未变消息换成 IPC 克隆新引用，下游（displayCache/
 *  cardsCache/hMetrics/行缓存）全走 === 命中；等价且全部原位复用时连数组引用也复用。
 *  回滚=三个替换点恢复直赋值。 */
function reconcileById(
  oldList: GuiChatMessage[],
  freshList: GuiChatMessage[]
): GuiChatMessage[] {
  const byId = new Map(oldList.map((m) => [m.id, m]));
  let allReused = freshList.length === oldList.length;
  const out = freshList.map((m, i) => {
    const prev = byId.get(m.id);
    if (prev && guiChatMessageEqual(prev, m)) {
      if (oldList[i] !== prev) allReused = false;
      return prev;
    }
    allReused = false;
    return m;
  });
  return allReused ? oldList : out;
}

function isGuiHistoryPage(value: unknown): value is GuiWorkerHistoryPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Partial<GuiWorkerHistoryPage>;
  const before = page.before;
  const total = page.total;
  return Array.isArray(page.messages) &&
    typeof before === 'number' && Number.isSafeInteger(before) && before >= 0 &&
    typeof total === 'number' && Number.isSafeInteger(total) && total >= page.messages.length &&
    before <= total && before + page.messages.length <= total &&
    typeof page.hasEarlier === 'boolean' && page.hasEarlier === (before > 0) &&
    // External Harness history omits Core's mode and reports native settings separately.
    (page.mode === undefined || typeof page.mode === 'string') &&
    typeof (page as { busy?: unknown }).busy === 'boolean';
}

/** U1 合并应用（r1-3 逐消息时钟版）：迟到 history 快照与本地消息的受控合并。
 *  - 同 id：touched > capMsgClock（该消息在快照请求发出后被推送更新过）⇒ 本地领先，
 *    保本地（含快照之后到达的增量，覆盖会丢 token）；否则本地不新于快照 ⇒ 取快照版本
 *    （resync 的权威补齐能落地；等价时保本地引用，行缓存照常命中）。
 *  - 快照独有消息（本地错过的事件）按 ts 插回本地列表：插到第一条 ts 严格更新的本地
 *    消息之前；ts 缺省归一 0 ⇒ 插到头部（旧消息在前）。
 *  - 本地独有消息（快照之后的新事件）原样保留。
 *  全量 sync 应用过时不会走到这里（消息段保持本地），不会复活已删消息。 */
function mergeGuiHistory(
  local: GuiChatMessage[],
  hist: GuiChatMessage[],
  touched: Map<string, number>,
  capMsgClock: number
): GuiChatMessage[] {
  const histById = new Map(hist.map((m) => [m.id, m]));
  let out = local.map((m) => {
    const snap = histById.get(m.id);
    if (!snap) return m; // 本地独有：快照之后的新事件
    const t = touched.get(m.id);
    const localAhead = t !== undefined && t > capMsgClock;
    if (!localAhead) {
      return guiChatMessageEqual(m, snap) ? m : snap; // 本地不新于快照：取权威版
    }
    // r2-⑤：本地领先（含快照后增量）时保留本地已有 parts，但快照里本地缺失的
    // 尾部 parts（desync 期间已落定的工具卡/段落）仍需补齐——只追加缺失尾部，
    // 不覆盖已有 part（本地文本新于快照，覆盖会丢 token）
    if (snap.parts.length > m.parts.length) {
      return { ...m, parts: [...m.parts, ...snap.parts.slice(m.parts.length)] };
    }
    return m;
  });
  const outIds = new Set(out.map((m) => m.id));
  let inserted = false;
  for (const m of hist) {
    if (outIds.has(m.id)) continue;
    const at = out.findIndex((x) => x.ts > m.ts);
    const idx = at === -1 ? out.length : at;
    out = [...out.slice(0, idx), m, ...out.slice(idx)];
    inserted = true;
  }
  return inserted || out.some((m, i) => m !== local[i]) ? out : local;
}

/** GUI 会话表面：一个 sessionId 一个实例（壳在 sessionId 变化时自然重建） */
export function useAgentSessionSurface(args: {
  sessionId: string;
  visible: boolean;
  runtimeId?: string;
  /** extension = 扩展面板侧栏：Composer 不显示模式选择与权限档位。 */
  variant?: 'full' | 'extension';
}): ChatSurface {
  const { sessionId, visible, runtimeId, variant = 'full' } = args;
  const { flashTip } = useUiActionsStore();
  const flashTipRef = useRef(flashTip);
  flashTipRef.current = flashTip;
  const storeRef = useRef<AgentSessionSurfaceStore | null>(null);
  if (!storeRef.current || storeRef.current.sessionId !== sessionId || storeRef.current.runtimeId !== (runtimeId ?? '')) {
    storeRef.current?.dispose();
    storeRef.current = new AgentSessionSurfaceStore(sessionId, {
      id: runtimeId ?? '',
      pi: runtimeId === 'pi',
      claude: runtimeId === 'claude',
      acp: runtimeId === 'acp',
      // Claude、Codex、ACP 使用自己的模型目录，不吃全局 llm.providers。
      codex: runtimeId === 'codex-gui'
    });
  }
  const store = storeRef.current;

  useEffect(() => {
    if (!visible) return;
    store.attach(runtimeId, {
      flashTip: (text) => flashTipRef.current(text),
      // 翻译用共享 i18n（静态文案，无需随语言切换重渲染）
      t
    });
    store.loadCodexCatalog();
    store.loadModelParameters();
    return () => {
      store.dispose(true);
    };
    // deps 只随会话/可见性/引擎变化；flashTip 经 ref 转发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, visible, sessionId, runtimeId]);

  return useMemo(() => {
    const caps = capsFor(sessionId, runtimeId, variant);
    const surface: ChatSurface = {
      sessionId,
      caps,
      subscribe: store.subscribe,
      getSnapshot: store.getSnapshot,
      harness: store.harnessStore,
      actions: {
        send: (text, images) => store.send(text, images),
        sendNow: (text) => store.sendNow(text),
        sendNowFallback: (text, method) => store.sendNowFallback(text, method),
        editQueued: (id, text) => store.editQueued(id, text),
        reorderQueued: (ids) => store.reorderQueued(ids),
        getQueuedImages: (id) => store.getQueuedImages(id),
        stop: () => store.stop(),
        compact: (instructions) => store.compact(instructions),
        clear: () => store.clear(),
        loadEarlier: () => store.loadEarlier(),
        ensureMessageLoaded: (messageId) => store.ensureMessageLoaded(messageId),
        retainPageWindow: (window) => store.retainPageWindow(window),
        messageIndex: (messageId) => store.messageIndex(messageId),
        retry: () => store.retry(),
        recallAborted: (id) => store.recallAborted(id),
        cancelQueued: (id) => store.cancelQueued(id),
        planAction: (a, feedback) => store.planAction(a, feedback),
        setMode: (m) => void store.setMode(m as GuiWorkerMode),
        setModelParameter: (id, value) => store.setModelParameter(id, value),
        setModelConfiguration: (input) => store.setModelConfiguration(input),
        setModel: (m) => store.setModel(m),
        onModelSwitched: () => undefined,
        reloadCodexCatalog: () => store.loadCodexCatalog(true),
        reloadHarnessCatalog: async () => { await store.refreshHarnessModelState(true); await store.loadHarnessCatalog(); },
        refreshHarnessModelState: async () => { await store.refreshHarnessModelState(); await store.loadHarnessCatalog(false); },
        fork: (messageId) => void store.fork(messageId),
        loadPresetRoster: () => store.loadPresetRoster(),
        changePreset: (id) => void store.changePreset(id),
        setHarnessOn: (on) => store.setHarnessOn(on)
      }
    };
    return surface;
  }, [store, sessionId, runtimeId, variant]);
}
