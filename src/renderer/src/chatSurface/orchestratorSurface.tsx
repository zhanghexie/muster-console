/**
 * 调度 Agent 会话适配器：把 orchestrator 的 chat:* IPC 与 agent:* 事件流
 * 适配成统一 ChatSurface 合同。本文件是全仓唯一认识调度聊天协议的渲染层模块——
 * 面板壳与统一视图不得直接触碰 window.api.chat.*。
 *
 * 消息模型：ChatMessage 原生（piProvider 产出的就是 parts 交错模型），
 * 本地回显（/status /help）并入消息尾（ChatMessage.local，不进模型上下文）。
 */
import type {
  AgentContextStatus,
  AgentDoneEvent,
  AgentHistoryEvent,
  AgentThinkingEvent,
  AgentTokenEvent,
  AgentToolEvent,
  ChatImageAttachment,
  ChatMessage,
  ChatUserQuestionView
} from '../../../shared/types';
import { CHAT_HISTORY_PAGE_SIZE } from '../../../shared/chatHistory';
import type {
  ChatQueuedItem,
  ChatHistoryPage,
  ChatSurface,
  ChatSurfaceCaps,
  ChatSurfacePageWindow,
  ChatSurfacePageState,
  ChatSurfaceSnapshot,
  ChatStatusInfo,
  SendNowResult
} from '../../../shared/chatSurface';
import { createRafBatcher } from './deltaBatcher';
import {
  PageMapCoordinator,
  type PageMapSnapshot
} from './pageMapCoordinator';
import { parseCompactCommand } from '../../../shared/compactCommand';
import { locateAbortedTurn } from '../../../shared/chatTurnRail';
import { answerFromText, findAskQuestionAnchor } from '../../../shared/orchestratorAskQuestion';
import { useEffect } from 'react';
import { t } from '../../../shared/i18n';
import { useUiStore } from '../store';
import {
  beginCompaction,
  compactionAnchorAt,
  completePendingCompaction,
  dropCompaction,
  newPendingCompactionId,
  type ChatCompactionMarker
} from '../../../shared/chatCompaction';

type WsId = string;

function stripWs<T extends { workspaceId?: string }>(m: T): Omit<T, 'workspaceId'> & ChatMessage {
  const { workspaceId: _w, ...rest } = m as T & ChatMessage;
  return rest as Omit<T, 'workspaceId'> & ChatMessage;
}

function mergeSchedulerPage(current: ChatMessage[], page: ChatHistoryPage, previousBefore?: number): {
  messages: ChatMessage[];
  before: number;
  hasEarlier: boolean;
} {
  const pageIds = new Set(page.messages.map(message => message.id));
  // A head snapshot is authoritative. This covers clear/shrink events where
  // the producer emits before=0 with an empty or shortened page. Preserve
  // already loaded rows only for an explicitly older-page prepend.
  if (previousBefore === undefined && page.before === 0) {
    return { messages: page.messages, before: 0, hasEarlier: page.hasEarlier };
  }
  if (previousBefore !== undefined && page.before < previousBefore) {
    const older = page.messages.filter(message => !current.some(existing => existing.id === message.id));
    return { messages: [...older, ...current], before: page.before, hasEarlier: page.hasEarlier };
  }
  const boundary = page.messages[0]?.createdAt ?? Number.POSITIVE_INFINITY;
  const earlier = current.filter(message => !pageIds.has(message.id) && message.createdAt <= boundary);
  const later = current.filter(message => !pageIds.has(message.id) && message.createdAt > boundary);
  const before = Math.max(0, page.before - earlier.length);
  return { messages: [...earlier, ...page.messages, ...later], before, hasEarlier: before > 0 };
}

function preserveLiveSchedulerPage(
  current: ChatMessage[],
  page: ChatHistoryPage,
  currentLiveSeq: number
): ChatHistoryPage {
  const pageSeq = typeof page.eventSeq === 'number' && Number.isSafeInteger(page.eventSeq)
    ? page.eventSeq
    : null;
  if (pageSeq === null || currentLiveSeq <= pageSeq) return page;
  const currentById = new Map(current.map((message) => [message.id, message]));
  return {
    ...page,
    messages: page.messages.map((message) => currentById.get(message.id) ?? message)
  };
}

/** agent:token/thinking/tool 事件不带 workspaceId（piProvider 直发）：回落到面板实况工作区 */
let fallbackWs: WsId | null = null;

/** 工作区生命周期代（U3）：全局单调计数器 + 每工作区当前代。
 *  - registerLive：首次接触到某工作区（建 surface / 装载历史）时登记一代；
 *  - ensureHistory 重拉：换新代（重开同 id ⇒ 新生命周期，旧请求代失配全作废）；
 *  - evictDeadWorkspaces：删除该工作区的代 ⇒ 一切在途回调（history/getMode/context/
 *    resync/compact/clear）按「代失配」丢弃，迟到响应不再重建 dead key；
 *  隐藏面板 ≠ 关闭：面板隐藏但工作区仍存活时代保留，实时推送照常落地。 */

export class OrchestratorChatStore {
  private messages = new Map<WsId, ChatMessage[]>();
  /** Shadow absolute page projection; messages[] remains the row contract. */
  private pageMaps = new Map<WsId, PageMapCoordinator<ChatMessage>>();
  private busy = new Map<WsId, boolean>();
  private busyRevision = new Map<WsId, object>();
  private context = new Map<WsId, AgentContextStatus>();
  private contextSeq = new Map<WsId, number>();
  private localNotes = new Map<WsId, ChatMessage[]>();
  private mode = new Map<WsId, 'default' | 'ask' | 'plan'>();
  private thinking = new Map<WsId, NonNullable<AgentContextStatus['thinking']>>();
  private compactions = new Map<WsId, ChatCompactionMarker[]>();
  private loaded = new Set<WsId>();
  private historyLoading = new Set<WsId>();
  private historyErrors = new Map<WsId, string>();
  private historyBefore = new Map<WsId, number>();
  private historyHasEarlier = new Map<WsId, boolean>();
  private historyPageRequests = new Map<WsId, Map<string, Promise<void>>>();
  private historyResyncRequests = new Map<WsId, Promise<void>>();
  /** Renderer cursor for ordered live agent events. */
  private liveSeq = new Map<WsId, number>();
  private liveRecovery = new Map<WsId, Promise<void>>();
  private liveRecoveryMax = new Map<WsId, number>();
  private listeners = new Set<() => void>();
  private version = 0;
  private snapCache = new Map<WsId, { v: number; snap: ChatSurfaceSnapshot }>();
  /** 排队列表摘要缓存（按工作区）：流式期快照每批重建，(id,text) 未变则复用旧数组 */
  private queuedCache = new Map<WsId, { digest: string; items: ReadonlyArray<ChatQueuedItem> }>();
  /** U3：工作区生命周期代（见文件头注释） */
  private genCounter = 0;
  private wsGen = new Map<WsId, number>();

  private pageMapFor(wsId: WsId): PageMapCoordinator<ChatMessage> {
    let map = this.pageMaps.get(wsId);
    if (!map) {
      map = new PageMapCoordinator<ChatMessage>();
      this.pageMaps.set(wsId, map);
    }
    return map;
  }

  /** Internal inspection hook for range tests and the next virtualizer stage. */
  getPageMapSnapshot(wsId: WsId): PageMapSnapshot<ChatMessage> | undefined {
    return this.pageMaps.get(wsId)?.getSnapshot();
  }

  retainPageWindow(wsId: WsId, window: ChatSurfacePageWindow): void {
    const map = this.pageMaps.get(wsId);
    if (!map) return;
    this.retainedWindows.set(wsId, window);
    const navigation = this.navigationWindows.get(wsId);
    if (navigation && window.start <= navigation.index && window.end > navigation.index) this.navigationWindows.delete(wsId);
    if (this.trimPages(wsId)) this.notify();
    for (const range of map.missingWindows(window)) void this.loadPage(wsId, range.end);
  }

  private readonly retainedWindows = new Map<WsId, ChatSurfacePageWindow>();
  private readonly navigationWindows = new Map<WsId, ChatSurfacePageWindow & { index: number }>();

  private trimPages(wsId: WsId): boolean {
    const map = this.pageMapFor(wsId);
    const current = this.messages.get(wsId) ?? [];
    const known = new Set(map.loadedSlots().map(slot => slot.messageId));
    map.updatePayloads(current.map(payload => ({ messageId: payload.id, payload })));
    const total = map.getSnapshot().total;
    const changed = map.retainWindow(this.retainedWindows.get(wsId) ?? { start: Math.max(0, total - 120), end: total }, this.navigationWindows.get(wsId));
    const retained = map.getSnapshot();
    const retainedIds = new Set(retained.messages.map(message => message.messageId));
    const next = [...retained.messages.map(message => message.payload),
      ...current.filter(message => (!known.has(message.id) || message.queued) && !retainedIds.has(message.id))];
    if (next.length !== current.length || next.some((message, index) => message !== current[index])) {
      this.messages.set(wsId, next);
      return true;
    }
    return changed;
  }

  messageIndex(wsId: WsId, messageId: string): number | undefined {
    return this.pageMaps.get(wsId)?.locateMessage(messageId)?.index;
  }

  async ensureMessageLoaded(wsId: WsId, messageId: string): Promise<boolean> {
    if (!messageId || !this.wsGen.has(wsId)) return false;
    if ((this.messages.get(wsId) ?? []).some(message => message.id === messageId) ||
        this.pageMapFor(wsId).locateMessage(messageId)) return true;
    await this.loadPage(wsId, undefined, messageId);
    return (this.messages.get(wsId) ?? []).some(message => message.id === messageId) ||
      !!this.pageMapFor(wsId).locateMessage(messageId);
  }

  private pageState(wsId: WsId): ChatSurfacePageState {
    const map = this.pageMaps.get(wsId);
    if (!map) return EMPTY_PAGE;
    const snapshot = map.getSnapshot();
    return {
      generation: snapshot.generation,
      total: snapshot.total,
      slots: map.loadedSlots(),
      loadedRanges: snapshot.loadedRanges,
      cursor: snapshot.cursor,
      loadState: snapshot.loadState
    };
  }

  private recordPageMapPage(
    wsId: WsId,
    page: ChatHistoryPage,
    messages: readonly ChatMessage[] = page.messages
  ): void {
    const map = this.pageMapFor(wsId);
    const currentById = new Map(messages.map(message => [message.id, message]));
    const fullReplacement = page.before === 0 && page.messages.length === page.total &&
      (this.messages.get(wsId)?.length ?? 0) === page.total;
    map.applyWindow({
      generation: map.generation,
      range: { start: page.before, end: page.before + page.messages.length },
      messages: page.messages.map(message => ({
        messageId: message.id,
        payload: currentById.get(message.id) ?? message
      })),
      cursor: {
        before: page.before,
        total: Math.max(page.total, page.before + page.messages.length),
        hasEarlier: page.hasEarlier
      }
    }, fullReplacement);
    this.trimPages(wsId);
  }

  private recordFullPage(wsId: WsId, messages: readonly ChatMessage[]): void {
    this.recordPageMapPage(wsId, {
      messages: [...messages],
      before: 0,
      total: messages.length,
      hasEarlier: false
    });
  }

  /** 首次接触登记代；已登记不动（不使在途请求失效） */
  registerLive(wsId: WsId): void {
    if (!this.wsGen.has(wsId)) this.wsGen.set(wsId, ++this.genCounter);
  }

  /** 工作区是否仍是当前生命周期（未被逐出/未被重开换代） */
  private genCurrent(wsId: WsId, gen: number | undefined): boolean {
    return gen !== undefined && this.wsGen.get(wsId) === gen;
  }

  /** 当前生命周期代（surface 动作回调捕获用；r1-6）；未登记返回 undefined */
  currentGen(wsId: WsId): number | undefined {
    return this.wsGen.get(wsId);
  }

  /** 代是否仍当前（对外暴露给 surface 动作回调校验） */
  genIsCurrent(wsId: WsId, gen: number | undefined): boolean {
    return this.genCurrent(wsId, gen);
  }

  private acceptLiveEvent(wsId: WsId, eventSeq: number | undefined, snapshot = false): boolean {
    if (typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq)) return true;
    if (!snapshot && this.liveRecovery.has(wsId)) {
      this.liveRecoveryMax.set(wsId, Math.max(this.liveRecoveryMax.get(wsId) ?? 0, eventSeq));
      return false;
    }
    const previous = this.liveSeq.get(wsId);
    if (previous !== undefined && eventSeq === previous) return false;
    if (snapshot && previous !== undefined && eventSeq < previous) return false;
    if (!snapshot && previous !== undefined && eventSeq < previous) {
      if (!this.liveRecovery.has(wsId)) {
        this.liveRecoveryMax.set(wsId, Math.max(this.liveRecoveryMax.get(wsId) ?? 0, eventSeq));
        const gen = this.wsGen.get(wsId);
        const recovery = this.loadHistoryPage(wsId)
          .then((page) => {
            if (!this.genCurrent(wsId, gen)) return;
            const current = this.messages.get(wsId) ?? [];
            const merged = mergeSchedulerPage(
              current,
              preserveLiveSchedulerPage(current, page, this.liveSeq.get(wsId) ?? 0)
            );
            this.messages.set(wsId, merged.messages);
            this.recordPageMapPage(wsId, page, merged.messages);
            this.historyBefore.set(wsId, merged.before);
            this.historyHasEarlier.set(wsId, merged.hasEarlier);
            if (typeof page.eventSeq === 'number' && Number.isSafeInteger(page.eventSeq)) {
              this.liveSeq.set(wsId, Math.max(this.liveSeq.get(wsId) ?? 0, page.eventSeq));
            } else {
              this.liveSeq.set(wsId, Math.max(this.liveSeq.get(wsId) ?? 0, eventSeq));
            }
            this.notify();
          })
          .catch(() => undefined)
          .finally(() => {
            if (this.liveRecovery.get(wsId) !== recovery) return;
            this.liveRecovery.delete(wsId);
            const queued = this.liveRecoveryMax.get(wsId);
            if (queued !== undefined && queued > (this.liveSeq.get(wsId) ?? 0)) {
              this.liveRecoveryMax.delete(wsId);
              this.acceptLiveEvent(wsId, queued, false);
            } else {
              this.liveRecoveryMax.delete(wsId);
            }
          });
        this.liveRecovery.set(wsId, recovery);
      }
      return false;
    }
    if (!snapshot && previous !== undefined && eventSeq > previous + 1) {
      if (!this.liveRecovery.has(wsId)) {
        this.liveRecoveryMax.set(wsId, Math.max(this.liveRecoveryMax.get(wsId) ?? 0, eventSeq));
        const gen = this.wsGen.get(wsId);
        const recovery = this.loadHistoryPage(wsId)
          .then((page) => {
            if (!this.genCurrent(wsId, gen)) return;
            const current = this.messages.get(wsId) ?? [];
            const merged = mergeSchedulerPage(
              current,
              preserveLiveSchedulerPage(current, page, this.liveSeq.get(wsId) ?? 0)
            );
            this.messages.set(wsId, merged.messages);
            this.recordPageMapPage(wsId, page, merged.messages);
            this.historyBefore.set(wsId, merged.before);
            this.historyHasEarlier.set(wsId, merged.hasEarlier);
            if (typeof page.eventSeq === 'number' && Number.isSafeInteger(page.eventSeq)) {
              this.liveSeq.set(wsId, Math.max(this.liveSeq.get(wsId) ?? 0, page.eventSeq));
            } else {
              this.liveSeq.set(wsId, Math.max(this.liveSeq.get(wsId) ?? 0, eventSeq));
            }
            this.notify();
          })
          .catch(() => undefined)
          .finally(() => {
            if (this.liveRecovery.get(wsId) !== recovery) return;
            this.liveRecovery.delete(wsId);
            const queued = this.liveRecoveryMax.get(wsId);
            if (queued !== undefined && queued > (this.liveSeq.get(wsId) ?? 0)) {
              this.liveRecoveryMax.delete(wsId);
              this.acceptLiveEvent(wsId, queued, false);
            } else {
              this.liveRecoveryMax.delete(wsId);
            }
          });
        this.liveRecovery.set(wsId, recovery);
      }
      return false;
    }
    this.liveSeq.set(wsId, eventSeq);
    return true;
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

  /** 引用稳定快照：version 变化才重建（useSyncExternalStore 要求） */
  snapshot(wsId: WsId | null): ChatSurfaceSnapshot {
    if (!wsId) return EMPTY_SNAPSHOT;
    const hit = this.snapCache.get(wsId);
    if (hit && hit.v === this.version) return hit.snap;
    const msgs = this.messages.get(wsId) ?? [];
    const notes = this.localNotes.get(wsId) ?? [];
    const list = notes.length ? [...msgs, ...notes] : msgs;
    const snap: ChatSurfaceSnapshot = {
      messages: list,
      historyLoading: this.historyLoading.has(wsId) && list.length === 0,
      historyError: this.historyErrors.get(wsId),
      historyHasEarlier: this.historyHasEarlier.get(wsId) ?? false,
      page: this.pageState(wsId),
      busy: !!this.busy.get(wsId),
      queuedCount: list.reduce((n, m) => (m.queued ? n + 1 : n), 0),
      queuedItems: this.queuedItemsOf(wsId, msgs),
      status: statusOf(wsId, this.context.get(wsId), this.thinking.get(wsId)),
      mode: this.mode.get(wsId) ?? null,
      preset: null,
      ...(this.compactions.get(wsId)?.length
        ? { compactions: this.compactions.get(wsId) }
        : {})
    };
    this.snapCache.set(wsId, { v: this.version, snap });
    return snap;
  }

  /**
   * 排队列表引用稳定化：流式期快照每批（~50ms）重建一次，排队 (id,text) 未变时
   * 复用旧数组、空队列复用模块级单例——排队面板 props 不随每批快照换引用。
   * 队列真变（新增/编辑/取消）摘要失配，自然换新数组新内容。
   */
  private queuedItemsOf(wsId: WsId, msgs: ChatMessage[]): ReadonlyArray<ChatQueuedItem> {
    const queued = msgs.filter((m) => m.queued);
    if (queued.length === 0) return EMPTY_QUEUED;
    const digest = queued
      .map((m) => `${m.id}\u0000${m.content}\u0000${m.images?.length ?? 0}`)
      .join('\u0001');
    const hit = this.queuedCache.get(wsId);
    if (hit && hit.digest === digest) return hit.items;
    const items = queued.map((m) => ({
      id: m.id,
      text: m.content,
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
    this.queuedCache.set(wsId, { digest, items });
    return items;
  }

  private patchMessages(wsId: WsId, patch: (prev: ChatMessage[]) => ChatMessage[]): void {
    const cur = this.messages.get(wsId);
    if (!cur) return;
    const next = patch(cur);
    if (next === cur) return;
    this.messages.set(wsId, next);
    this.notify();
  }

  /** 排队条目随文图片（跨泳道 auto→manual 补全；快照只带张数） */
  getQueuedImages(wsId: WsId, messageId: string): ChatImageAttachment[] | undefined {
    const m = (this.messages.get(wsId) ?? []).find((x) => x.id === messageId);
    return m?.images;
  }

  setBusy(wsId: WsId, v: boolean): void {
    if (!this.wsGen.has(wsId)) return; // dead key 不重建（U3）
    // 即使仍为 false，done 边沿也必须阻止迟到的 busy=true 快照覆盖。
    this.busyRevision.set(wsId, {});
    if (!!this.busy.get(wsId) === v) return;
    this.busy.set(wsId, v);
    this.notify();
  }

  setMode(wsId: WsId, m: 'default' | 'ask' | 'plan'): void {
    if (!this.wsGen.has(wsId)) return; // dead key 不重建（U3）
    this.mode.set(wsId, m);
    this.notify();
  }

  async ensureHistory(wsId: WsId): Promise<void> {
    batcher.flush();
    if (this.loaded.has(wsId)) return;
    // 重开同 id ⇒ 新生命周期代：在途回调（含上一生命周期的）代失配全作废
    const gen = ++this.genCounter;
    this.wsGen.set(wsId, gen);
    this.pageMapFor(wsId).reset();
    this.retainedWindows.delete(wsId);
    this.navigationWindows.delete(wsId);
    this.loaded.add(wsId);
    this.messages.set(wsId, []);
    this.liveSeq.delete(wsId);
    this.liveRecovery.delete(wsId);
    this.historyResyncRequests.delete(wsId);
    this.liveRecoveryMax.delete(wsId);
    this.historyLoading.add(wsId); this.historyErrors.delete(wsId); this.notify();
    const busyRevision = {};
    this.busyRevision.set(wsId, busyRevision);
    const stateRequest = window.api.chat.state(wsId).then((state) => {
      if (this.busyRevision.get(wsId) === busyRevision && this.loaded.has(wsId)) {
        this.setBusy(wsId, state.busy);
      }
    }).catch((error: unknown) => { console.warn('[chat] initial execution state unavailable', error); });
    try {
      const h = await this.loadHistoryPage(wsId);
      if (!this.genCurrent(wsId, gen)) return; // 逐出/重开：迟到响应不重建 dead key
      const live = this.messages.get(wsId) ?? [];
      const pageIds = new Set(h.messages.map(message => message.id));
      const currentLiveSeq = this.liveSeq.get(wsId) ?? 0;
      const pageSeq = typeof h.eventSeq === 'number' && Number.isSafeInteger(h.eventSeq)
        ? h.eventSeq
        : null;
      const liveWins = pageSeq == null ? currentLiveSeq > 0 : currentLiveSeq > pageSeq;
      const liveById = new Map(live.map(message => [message.id, message]));
      const authoritativePage = liveWins
        ? h.messages.map((message) => liveById.get(message.id) ?? message)
        : h.messages;
      this.messages.set(wsId, [
        ...authoritativePage,
        ...live.filter(message => !pageIds.has(message.id))
      ]);
      this.recordPageMapPage(wsId, h, authoritativePage);
      this.historyBefore.set(wsId, h.before);
      this.historyHasEarlier.set(wsId, h.hasEarlier);
      if (pageSeq != null) this.liveSeq.set(wsId, Math.max(currentLiveSeq, pageSeq));
      this.notify();
    } catch (error) {
      if (this.genCurrent(wsId, gen)) { this.loaded.delete(wsId); this.historyErrors.set(wsId, String(error)); }
    } finally {
      if (this.genCurrent(wsId, gen)) { this.historyLoading.delete(wsId); this.notify(); }
    }
    await stateRequest;
    try {
      const m = await window.api.chat.getMode(wsId);
      if (!this.genCurrent(wsId, gen)) return;
      this.setMode(wsId, m);
    } catch {
      /* 模式缺省三档，非关键路径 */
    }
  }

  private async loadHistoryPage(wsId: WsId, before?: number, targetMessageId?: string): Promise<ChatHistoryPage> {
    const map = this.pageMapFor(wsId);
    const token = map.startLoad(before === undefined ? 'tail' : 'earlier');
    this.notify();
    try {
      const historyRange = window.api.chat.historyRange;
      if (typeof historyRange === 'function') {
        const page = targetMessageId
          ? await historyRange(wsId, before, CHAT_HISTORY_PAGE_SIZE, targetMessageId)
          : await historyRange(wsId, before, CHAT_HISTORY_PAGE_SIZE);
        if (page && Array.isArray(page.messages) && Number.isSafeInteger(page.before) && page.before >= 0 &&
          Number.isSafeInteger(page.total) && page.total >= page.messages.length && page.before <= page.total &&
          page.before + page.messages.length <= page.total && page.hasEarlier === (page.before > 0)) {
          map.finishLoad(token);
          return page;
        }
      }
      throw new Error('History range unavailable');
    } catch (error) {
      map.finishLoad(token, String(error));
      throw error;
    }
  }

  async loadEarlier(wsId: WsId): Promise<void> {
    if (!this.wsGen.has(wsId) || !this.historyHasEarlier.get(wsId)) return;
    const before = this.historyBefore.get(wsId);
    if (before === undefined) return;
    return this.loadPage(wsId, before);
  }

  private async loadPage(wsId: WsId, before?: number, targetMessageId?: string): Promise<void> {
    const key = `${wsId}:${this.wsGen.get(wsId)}:${before ?? 'tail'}:${targetMessageId ?? ''}`;
    let requests = this.historyPageRequests.get(wsId);
    if (!requests) { requests = new Map(); this.historyPageRequests.set(wsId, requests); }
    const existing = requests.get(key);
    if (existing) return existing;
    const gen = this.wsGen.get(wsId);
    const request = this.loadHistoryPage(wsId, before, targetMessageId).then(page => {
      if (!this.genCurrent(wsId, gen)) return;
      if (page.messages.length === 0) return;
      if (targetMessageId) {
        const offset = page.messages.findIndex(message => message.id === targetMessageId);
        if (offset >= 0) this.navigationWindows.set(wsId, { start: page.before, end: page.before + page.messages.length, index: page.before + offset });
      }
      if (targetMessageId || !this.retainedWindows.has(wsId)) {
        this.retainedWindows.set(wsId, { start: page.before, end: page.before + page.messages.length });
      }
      const current = this.messages.get(wsId) ?? [];
      const merged = mergeSchedulerPage(
        current,
        preserveLiveSchedulerPage(current, page, this.liveSeq.get(wsId) ?? 0),
        targetMessageId ? page.before + page.messages.length : before
      );
      this.messages.set(wsId, merged.messages);
      this.recordPageMapPage(wsId, page, merged.messages);
      const currentBefore = this.historyBefore.get(wsId);
      if (!targetMessageId && currentBefore === before) {
        this.historyBefore.set(wsId, merged.before);
        this.historyHasEarlier.set(wsId, merged.hasEarlier);
      }
      this.historyErrors.delete(wsId);
      if (typeof page.eventSeq === 'number' && Number.isSafeInteger(page.eventSeq)) {
        this.liveSeq.set(wsId, Math.max(this.liveSeq.get(wsId) ?? 0, page.eventSeq));
      }
      this.notify();
    }).catch(error => {
      if (this.genCurrent(wsId, gen)) {
        this.historyErrors.set(wsId, String(error));
        this.notify();
      }
    }).finally(() => {
      if (requests.get(key) === request) requests.delete(key);
    });
    requests.set(key, request);
    return request;
  }

  async clear(wsId: WsId): Promise<void> {
    batcher.flush();
    const gen = this.wsGen.get(wsId);
    await window.api.chat.clear(wsId);
    if (!this.genCurrent(wsId, gen)) return; // 等待期间被逐出/重开：不写回
    // Invalidate every in-flight history/recovery response before clearing the
    // projection. A late page from the previous generation must not resurrect
    // messages after a successful clear.
    const nextGen = ++this.genCounter;
    this.wsGen.set(wsId, nextGen);
    this.pageMapFor(wsId).reset();
    this.retainedWindows.delete(wsId);
    this.navigationWindows.delete(wsId);
    this.historyPageRequests.delete(wsId);
    this.historyResyncRequests.delete(wsId);
    this.liveRecovery.delete(wsId);
    this.liveRecoveryMax.delete(wsId);
    this.historyLoading.delete(wsId);
    this.historyErrors.delete(wsId);
    this.messages.set(wsId, []);
    this.liveSeq.delete(wsId);
    this.liveRecovery.delete(wsId);
    this.liveRecoveryMax.delete(wsId);
    this.historyBefore.delete(wsId);
    this.historyHasEarlier.delete(wsId);
    this.localNotes.delete(wsId);
    this.compactions.delete(wsId);
    this.setBusy(wsId, false);
    this.notify();
  }

  localEcho(wsId: WsId, content: string): void {
    if (!this.wsGen.has(wsId)) return; // dead key 不重建（U3）
    const note: ChatMessage = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: 'assistant',
      content,
      createdAt: Date.now(),
      local: true
    };
    const prev = this.localNotes.get(wsId) ?? [];
    this.localNotes.set(wsId, [...prev.slice(-8), note]);
    this.notify();
  }

  /** A2-5-1：workspaces:changed 订阅入口——已关闭/被移除工作区逐出全部缓存键
   *  （messages/busy/context/localNotes/mode/thinking/compactions/loaded/
   *  snapCache/queuedCache + surfaceCache），长驻渲染进程内存从随工作区数单调
   *  增长变为有界（仅存活工作区）。被逐出工作区重进时靠既有 ensureHistory 重拉。
   *  fallbackWs（面板实况）与活跃区一并保留。回滚=移除本方法与订阅块。 */
  evictDeadWorkspaces(
    payload: { workspaces?: Array<{ id: string }>; activeWorkspaceId?: string | null } | null
  ): void {
    const live = new Set((payload?.workspaces ?? []).map((w) => w.id));
    if (payload?.activeWorkspaceId) live.add(payload.activeWorkspaceId);
    if (fallbackWs) live.add(fallbackWs);
    const dead = (wsId: WsId): boolean => !live.has(wsId);
    for (const wsId of [...this.messages.keys()]) if (dead(wsId)) this.messages.delete(wsId);
    for (const wsId of [...this.busy.keys()]) if (dead(wsId)) this.busy.delete(wsId);
    for (const wsId of [...this.busyRevision.keys()]) if (dead(wsId)) this.busyRevision.delete(wsId);
    for (const wsId of [...this.context.keys()]) if (dead(wsId)) this.context.delete(wsId);
    for (const wsId of [...this.contextSeq.keys()]) if (dead(wsId)) this.contextSeq.delete(wsId);
    for (const wsId of [...this.localNotes.keys()]) if (dead(wsId)) this.localNotes.delete(wsId);
    for (const wsId of [...this.mode.keys()]) if (dead(wsId)) this.mode.delete(wsId);
    for (const wsId of [...this.thinking.keys()]) if (dead(wsId)) this.thinking.delete(wsId);
    for (const wsId of [...this.compactions.keys()]) if (dead(wsId)) this.compactions.delete(wsId);
    for (const wsId of [...this.historyLoading]) if (dead(wsId)) this.historyLoading.delete(wsId);
    for (const wsId of [...this.historyErrors.keys()]) if (dead(wsId)) this.historyErrors.delete(wsId);
    for (const wsId of [...this.historyBefore.keys()]) if (dead(wsId)) this.historyBefore.delete(wsId);
    for (const wsId of [...this.historyHasEarlier.keys()]) if (dead(wsId)) this.historyHasEarlier.delete(wsId);
    for (const wsId of [...this.historyPageRequests.keys()]) if (dead(wsId)) this.historyPageRequests.delete(wsId);
    for (const wsId of [...this.historyResyncRequests.keys()]) if (dead(wsId)) this.historyResyncRequests.delete(wsId);
    for (const wsId of [...this.liveSeq.keys()]) if (dead(wsId)) this.liveSeq.delete(wsId);
    for (const wsId of [...this.liveRecovery.keys()]) if (dead(wsId)) this.liveRecovery.delete(wsId);
    for (const wsId of [...this.liveRecoveryMax.keys()]) if (dead(wsId)) this.liveRecoveryMax.delete(wsId);
    for (const wsId of [...this.loaded]) if (dead(wsId)) this.loaded.delete(wsId);
    for (const wsId of [...this.snapCache.keys()]) if (dead(wsId)) this.snapCache.delete(wsId);
    for (const wsId of [...this.queuedCache.keys()]) if (dead(wsId)) this.queuedCache.delete(wsId);
    for (const wsId of [...this.navigationWindows.keys()]) if (dead(wsId)) this.navigationWindows.delete(wsId);
    for (const wsId of [...this.retainedWindows.keys()]) if (dead(wsId)) this.retainedWindows.delete(wsId);
    for (const wsId of [...this.pageMaps.keys()]) if (dead(wsId)) this.pageMaps.delete(wsId);
    for (const wsId of [...surfaceCache.keys()]) if (dead(wsId)) surfaceCache.delete(wsId);
    // U3：同步逐出生命周期代——在途 history/getMode/context/resync 回调全部失配作废，
    // 迟到响应不再重建 dead key；隐藏面板不在 dead 集内，代保留、推送照常
    for (const wsId of [...this.wsGen.keys()]) if (dead(wsId)) this.wsGen.delete(wsId);
    this.notify();
  }

  /** 手动压缩：进行中/完成走消息流分割线；失败摘线，错误文案回 Composer hint */
  async compact(wsId: WsId, instructions?: string): Promise<{ ok: boolean; error?: string }> {
    batcher.flush();
    const gen = this.wsGen.get(wsId);
    const pendingId = newPendingCompactionId();
    this.compactions.set(
      wsId,
      beginCompaction(this.compactions.get(wsId) ?? [], pendingId, Date.now())
    );
    this.notify();
    try {
      const r = await window.api.chat.compact(instructions, wsId);
      if (!this.genCurrent(wsId, gen)) return r; // 等待期间被逐出：不再写回
      if (!r.ok) {
        this.compactions.set(wsId, dropCompaction(this.compactions.get(wsId) ?? [], pendingId));
        this.notify();
        return r;
      }
      this.compactions.set(
        wsId,
        completePendingCompaction(
          this.compactions.get(wsId) ?? [],
          pendingId,
          compactionAnchorAt(this.messages.get(wsId) ?? [], Date.now())
        )
      );
      this.notify();
      return r;
    } catch (e) {
      if (this.genCurrent(wsId, gen)) {
        this.compactions.set(wsId, dropCompaction(this.compactions.get(wsId) ?? [], pendingId));
        this.notify();
      }
      const msg = (e as Error).message;
      return { ok: false, error: msg };
    }
  }

  contextStatus(wsId: WsId): AgentContextStatus | undefined {
    return this.context.get(wsId);
  }

  /** 挂起中的 askQuestion（末条非排队 assistant 上的 pending 卡；无则 null）。
   *  发送即作答（R-20 来源一）判定用——与主进程 requestUserQuestion 的锚点同口径。 */
  pendingAsk(wsId: WsId): { questionId: string; questions: ChatUserQuestionView['questions'] } | null {
    const msgs = this.messages.get(wsId) ?? [];
    const anchor = findAskQuestionAnchor(msgs);
    const card = anchor?.userQuestion;
    if (!card || card.status !== 'pending') return null;
    return { questionId: card.questionId, questions: card.questions };
  }

  async fork(
    wsId: WsId,
    messageId: string
  ): Promise<{ ok: boolean; sessionFile?: string; error?: string }> {
    batcher.flush();
    try {
      const res = await window.api.chat.fork(messageId, wsId);
      if (res?.ok) {
        tipFn(t('已分叉出新会话'));
        return res;
      }
      if (res?.error) tipFn(res.error);
      return res ?? { ok: false };
    } catch (e) {
      const msg = (e as Error).message;
      tipFn(t('分叉失败：{{message}}', { message: msg }));
      return { ok: false, error: msg };
    }
  }

  async recallAborted(
    wsId: WsId,
    messageId?: string
  ): Promise<{ ok: boolean; text?: string; images?: ChatImageAttachment[]; error?: string }> {
    batcher.flush();
    try {
      const res = await window.api.chat.recallAborted(messageId, wsId);
      if (!res?.ok) {
        return { ok: false, error: res?.error };
      }
      const cur = this.messages.get(wsId);
      const loc = cur ? locateAbortedTurn(cur, messageId) : null;
      if (cur && loc) {
        const head = cur.slice(0, loc.userIdx);
        const tailQueued = cur.slice(loc.userIdx).filter((m) => m.queued);
        this.messages.set(wsId, [...head, ...tailQueued]);
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

  setThinkingState(
    wsId: WsId,
    thinking: NonNullable<AgentContextStatus['thinking']>
  ): void {
    if (!this.wsGen.has(wsId)) return; // dead key 不重建（U3）
    const prev = this.thinking.get(wsId);
    const next = { ...prev, ...thinking };
    if (prev && prev.level === next.level && prev.available === next.available &&
      prev.levels?.join(',') === next.levels?.join(',')) return;
    this.thinking.set(wsId, next);
    this.notify();
  }

  refreshContext(wsId: WsId): void {
    const gen = this.wsGen.get(wsId);
    if (gen === undefined) return; // 未登记（已逐出或从未打开）：不发起、不写回
    const seq = (this.contextSeq.get(wsId) ?? 0) + 1;
    this.contextSeq.set(wsId, seq);
    void window.api.chat
      .context(wsId)
      .then((st: AgentContextStatus) => {
        if (!this.genCurrent(wsId, gen) || this.contextSeq.get(wsId) !== seq) return;
        this.context.set(wsId, st);
        if (st.thinking) this.thinking.set(wsId, st.thinking);
        this.notify();
      })
      .catch(() => undefined);
  }

  // ── agent:* 事件流（自 store.tsx 平移；语义不变）──

  private patchWs = (wsId: WsId, patch: (prev: ChatMessage[]) => ChatMessage[]): void =>
    this.patchMessages(wsId, patch);

  applyDeltaBatch = (queue: StreamDelta[]): void => {
    // 聚合：每个 (wsId, messageId, partIndex, kind) 拼成一段文本，每个工作区只落一次
    const merged = new Map<
      WsId,
      Map<string, { content?: string; thinking?: string; parts?: Map<string, string> }>
    >();
    for (const d of queue) {
      let byMsg = merged.get(d.wsId);
      if (!byMsg) {
        byMsg = new Map();
        merged.set(d.wsId, byMsg);
      }
      const acc = byMsg.get(d.messageId) ?? {};
      if (d.partIndex == null) {
        // 旧扁平消息（无 parts 模型）
        if (d.kind === 'content') acc.content = (acc.content ?? '') + d.text;
        else acc.thinking = (acc.thinking ?? '') + d.text;
      } else {
        if (!acc.parts) acc.parts = new Map();
        // 事件侧 kind 是 content/thinking，part 侧是 text/thinking，key 统一成 part kind
        const partKind = d.kind === 'content' ? 'text' : 'thinking';
        const key = `${partKind}:${d.partIndex}`;
        acc.parts.set(key, (acc.parts.get(key) ?? '') + d.text);
      }
      byMsg.set(d.messageId, acc);
    }
    for (const [wsId, byMsg] of merged) {
      this.patchWs(wsId, (cur) => {
        let changed = false;
        let resync = false;
        const next = cur.map((m) => {
          const acc = byMsg.get(m.id);
          if (!acc) return m;
          changed = true;
          let parts = m.parts;
          if (acc.parts) {
            parts = [...(m.parts ?? [])];
            for (const [key, text] of acc.parts) {
              const [kind, idxStr] = key.split(':');
              const idx = Number(idxStr);
              const existing = parts[idx];
              const fresh =
                kind === 'thinking' ? { kind: 'thinking' as const, text } : { kind: 'text' as const, text };
              if (existing && (existing.kind === 'tool' || existing.kind !== kind)) {
                // A2-5-2：tool 卡 / kind 失配的 part 不被同下标 delta 覆盖——丢弃该批，
                // 拉权威历史（对齐 guiWorker.applyGuiMessagePart null→resync 的 GUI 语义）
                resync = true;
                return m;
              }
              if (existing) {
                parts[idx] = { ...existing, text: existing.text + text };
              } else if (idx === parts.length) {
                parts.push(fresh);
              } else {
                // 下标跳号（错过前序 part 落定）：不同步，等权威历史校正
                resync = true;
                return m;
              }
            }
          }
          return {
            ...m,
            ...(parts !== m.parts ? { parts } : {}),
            ...(acc.content !== undefined ? { content: m.content + acc.content } : {}),
            ...(acc.thinking !== undefined
              ? { thinking: (m.thinking ?? '') + acc.thinking }
              : {})
          };
        });
        // A delta can win the race with the initial bounded history page. Treat
        // an unknown target as a recovery request while that page is pending.
        if (!changed && (
          this.historyLoading.has(wsId) || !this.historyHasEarlier.get(wsId)
        )) resync = true;
        if (resync) {
          // U3：resync 换权威历史也要过代校验——等待期间工作区被逐出则不写回
          if (this.historyResyncRequests.has(wsId) || this.liveRecovery.has(wsId)) return cur;
          const gen = this.wsGen.get(wsId);
          const request = this.loadHistoryPage(wsId)
            .then((h) => {
              if (!this.genCurrent(wsId, gen)) return;
              const current = this.messages.get(wsId) ?? [];
              const merged = mergeSchedulerPage(
                current,
                preserveLiveSchedulerPage(current, h, this.liveSeq.get(wsId) ?? 0)
              );
              this.messages.set(wsId, merged.messages);
              this.recordPageMapPage(wsId, h, merged.messages);
              this.historyBefore.set(wsId, merged.before);
              this.historyHasEarlier.set(wsId, merged.hasEarlier);
              if (typeof h.eventSeq === 'number' && Number.isSafeInteger(h.eventSeq)) {
                this.liveSeq.set(wsId, Math.max(this.liveSeq.get(wsId) ?? 0, h.eventSeq));
              }
              this.notify();
            })
            .catch(() => undefined)
            .finally(() => {
              if (this.historyResyncRequests.get(wsId) === request) this.historyResyncRequests.delete(wsId);
            });
          this.historyResyncRequests.set(wsId, request);
          return cur; // 丢弃该批
        }
        return changed ? next : cur;
      });
    }
  };

  handleHistory = (payload: AgentHistoryEvent | ChatMessage[]): void => {
    // 全量替换前先落盘在途 delta，保证顺序
    batcher.flush();
    if (Array.isArray(payload)) {
      const wsId = fallbackWs;
      if (!wsId || !this.wsGen.has(wsId)) return; // 未登记/dead：不重建 key（U3）
      this.messages.set(wsId, payload);
      this.recordFullPage(wsId, payload);
      this.historyBefore.delete(wsId);
      this.historyHasEarlier.set(wsId, false);
      this.notify();
      return;
    }
    // 主进程推送是新鲜权威数据：只落到已登记（存活）工作区；已关闭工作区的迟到
    // 推送不得重建缓存键。未登记的存活工作区会在面板打开时经 ensureHistory 拉取
    if (!this.wsGen.has(payload.workspaceId)) return;
    if (!this.acceptLiveEvent(payload.workspaceId, payload.eventSeq, true)) return;
    const current = this.messages.get(payload.workspaceId) ?? [];
    const before = payload.before;
    if (before === 0 && (payload.total ?? payload.messages.length) < this.pageMapFor(payload.workspaceId).getSnapshot().total) {
      this.wsGen.set(payload.workspaceId, ++this.genCounter);
      this.pageMapFor(payload.workspaceId).reset();
      this.retainedWindows.delete(payload.workspaceId);
      this.navigationWindows.delete(payload.workspaceId);
    }
    if (typeof before === 'number' && Number.isSafeInteger(before)) {
      const merged = mergeSchedulerPage(current, {
        messages: payload.messages,
        before,
        total: payload.total ?? payload.messages.length,
        hasEarlier: payload.hasEarlier ?? before > 0,
        eventSeq: payload.eventSeq
      });
      this.messages.set(payload.workspaceId, merged.messages);
      this.recordPageMapPage(payload.workspaceId, {
        messages: payload.messages,
        before,
        total: payload.total ?? payload.messages.length,
        hasEarlier: payload.hasEarlier ?? before > 0,
        eventSeq: payload.eventSeq
      }, merged.messages);
      this.historyBefore.set(payload.workspaceId, merged.before);
      this.historyHasEarlier.set(payload.workspaceId, merged.hasEarlier);
    } else {
      this.messages.set(payload.workspaceId, payload.messages);
      this.recordFullPage(payload.workspaceId, payload.messages);
      this.historyBefore.delete(payload.workspaceId);
      this.historyHasEarlier.set(payload.workspaceId, false);
    }
    this.notify();
  };

  handleMessage = (m: ChatMessage & { workspaceId?: string; eventSeq?: number }): void => {
    // 新消息/占位替换前先落盘在途 delta，保证顺序
    batcher.flush();
    const wsId = m.workspaceId?.trim() || fallbackWs;
    if (!wsId || !this.wsGen.has(wsId)) return;
    if (!this.acceptLiveEvent(wsId, m.eventSeq)) return;
    const msg = stripWs(m);
    const map = this.pageMapFor(wsId);
    const index = map.locateMessage(msg.id)?.index ?? map.getSnapshot().total;
    map.applyWindow({ generation: map.generation, range: { start: index, end: index + 1 },
      messages: [{ messageId: msg.id, payload: msg }] });
    let isNewAssistant = msg.role === 'assistant' && !(this.messages.get(wsId) ?? []).some((x) => x.id === msg.id);
    this.patchWs(wsId, (prev) => {
      if (prev.some((x) => x.id === msg.id)) return prev.map((x) => (x.id === msg.id ? msg : x));
      if (msg.role === 'assistant') isNewAssistant = true;
      return [...prev, msg];
    });
    if (this.trimPages(wsId)) this.notify();
    // 新 assistant 占位 = 新回合开始（含排队自动续发），驱动 busy
    if (isNewAssistant) this.setBusy(wsId, true);
  };

  handleToken = (p: AgentTokenEvent): void => {
    const wsId = p.workspaceId?.trim() || fallbackWs;
    if (!wsId || !this.wsGen.has(wsId)) return;
    if (!this.acceptLiveEvent(wsId, p.eventSeq)) return;
    batcher.enqueue({
      wsId,
      messageId: p.messageId,
      kind: 'content',
      text: p.token,
      ...(p.partIndex != null ? { partIndex: p.partIndex } : {})
    });
  };

  handleThinking = (p: AgentThinkingEvent): void => {
    const wsId = p.workspaceId?.trim() || fallbackWs;
    if (!wsId || !this.wsGen.has(wsId)) return;
    if (!this.acceptLiveEvent(wsId, p.eventSeq)) return;
    batcher.enqueue({
      wsId,
      messageId: p.messageId,
      kind: 'thinking',
      text: p.token,
      ...(p.partIndex != null ? { partIndex: p.partIndex } : {})
    });
  };

  handleTool = (p: AgentToolEvent): void => {
    // 消息补丁前先落盘在途 delta，保证顺序
    batcher.flush();
    const wsId = p.workspaceId?.trim() || fallbackWs;
    if (!wsId || !this.wsGen.has(wsId)) return;
    if (!this.acceptLiveEvent(wsId, p.eventSeq)) return;
    this.patchWs(wsId, (prev) =>
      prev.map((m) => {
        if (m.id !== p.messageId) return m;
        const toolCalls = [...(m.toolCalls ?? [])];
        const idx = toolCalls.findIndex((t) => t.id === p.toolCall.id);
        if (idx >= 0) toolCalls[idx] = p.toolCall;
        else toolCalls.push(p.toolCall);
        // parts 模型：工具卡只在 parts 里渲染；已有同 id 段则回填状态，否则按到达顺序追加到尾部
        // （首个事件可能就是 agent:tool，此时负责把 parts 物化出来，避免后续按下标赋值出现空洞）
        let parts = [...(m.parts ?? [])];
        const pIdx = parts.findIndex((pt) => pt.kind === 'tool' && pt.toolCall.id === p.toolCall.id);
        if (pIdx >= 0) parts[pIdx] = { kind: 'tool', toolCall: p.toolCall };
        else parts.push({ kind: 'tool', toolCall: p.toolCall });
        return { ...m, toolCalls, parts };
      })
    );
  };

  handleDone = (p: AgentDoneEvent): void => {
    // 终态替换前先落盘在途 delta，保证顺序
    batcher.flush();
    const wsId = p.workspaceId?.trim() || fallbackWs;
    if (wsId && !this.wsGen.has(wsId)) return;
    if (wsId && !this.acceptLiveEvent(wsId, p.eventSeq)) return;
    if (wsId) {
      this.patchWs(wsId, (prev) => prev.map((m) => (m.id === p.message.id ? p.message : m)));
      // queuedNext：主进程马上续发下一条排队消息，保持 busy 不闪断
      this.setBusy(wsId, !!p.queuedNext);
    } else {
      for (const k of [...this.busy.keys()]) this.busy.set(k, false);
      this.notify();
    }
  };

  handleContext = (p: AgentContextStatus & { workspaceId?: string }): void => {
    const wsId = p.workspaceId?.trim() || fallbackWs;
    if (!wsId || !this.wsGen.has(wsId)) return; // dead key 不重建（U3）
    const { workspaceId: _w, thinking, ...status } = p;
    const previous = this.context.get(wsId);
    if (thinking || (previous && (previous.provider !== status.provider || previous.modelId !== status.modelId))) {
      this.contextSeq.set(wsId, (this.contextSeq.get(wsId) ?? 0) + 1);
    }
    this.context.set(wsId, status);
    // 用量快照可能不带 thinking：保留已装载的档，避免 chip 被回合推送抹掉
    if (thinking) this.thinking.set(wsId, thinking);
    this.notify();
  };
}

/** 空排队列表单例：快照高频重建时空队列不再每批新分配 */
const EMPTY_QUEUED: ReadonlyArray<ChatQueuedItem> = [];

const EMPTY_PAGE: ChatSurfacePageState = {
  generation: 1,
  total: 0,
  loadedRanges: [],
  cursor: { total: 0, hasEarlier: false, hasLater: false },
  loadState: {
    tail: { status: 'idle', generation: 1 },
    earlier: { status: 'idle', generation: 1 },
    later: { status: 'idle', generation: 1 }
  }
};

const EMPTY_SNAPSHOT: ChatSurfaceSnapshot = {
  messages: [],
  page: EMPTY_PAGE,
  busy: false,
  queuedCount: 0,
  queuedItems: EMPTY_QUEUED,
  status: null,
  mode: null,
  preset: null
};

/** 调度上下文 → 状态条数据面（模型按钮/用量环/思考档；模型切换动作走 surface.setModel） */
function statusOf(
  wsId: WsId,
  c: AgentContextStatus | undefined,
  thinking?: NonNullable<AgentContextStatus['thinking']>
): ChatStatusInfo | null {
  if (!c) return null;
  const modelLabel = (c.modelName || c.modelId || '').trim();
  if (!modelLabel && !c.workerRoutingScope) return null;
  return {
    modelLabel,
    ...(c.workerRoutingScope ? { workerRoutingScope: c.workerRoutingScope } : {}),
    ...(c.provider ? { providerId: c.provider } : {}),
    modelId: c.modelId,
    supportsImages: c.supportsImages,
    usage: {
      tokens: c.tokens,
      contextWindow: c.contextWindow ?? 0
    },
    usageTitle: [
      c.provider ? `${c.provider}/${modelLabel}` : modelLabel,
      c.tokens != null && c.contextWindow != null
        ? `${c.tokens} / ${c.contextWindow} tokens`
        : t('上下文用量暂不可用（新会话或 compaction 后需再跑一轮）')
    ].join(' · '),
    ...(thinking ? { thinking } : {})
  };
}

interface StreamDelta {
  wsId: WsId;
  messageId: string;
  kind: 'content' | 'thinking';
  text: string;
  partIndex?: number;
}

const store = new OrchestratorChatStore();
let tipFn: (text: string) => void = () => undefined;

/** delta 合批：rAF + 50ms 兜底（与 GUI 会话同一节奏控制，见 deltaBatcher） */
const batcher = createRafBatcher<StreamDelta>({ apply: (q) => store.applyDeltaBatch(q) });

let listenersInstalled = false;
function ensureListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  window.api.on('agent:history', store.handleHistory);
  window.api.on('agent:message', store.handleMessage);
  window.api.on('agent:token', store.handleToken);
  window.api.on('agent:thinking', store.handleThinking);
  window.api.on('agent:tool', store.handleTool);
  window.api.on('agent:done', store.handleDone);
  window.api.on('agent:context', store.handleContext);
  // A2-5-1：工作区关闭/移除后逐出对应缓存（见 store.evictDeadWorkspaces）
  window.api.on('workspaces:changed', (payload) => store.evictDeadWorkspaces(payload));
}

/** 面板实况工作区变化时更新 delta 兜底（token/thinking/tool 事件不带 workspaceId） */
export function setOrchestratorFallbackWs(wsId: string | null): void {
  fallbackWs = wsId;
}

/** 单测重挂事件监听：setup.ts 每用例重装 window.api mock，旧监听随旧 mock 失效 */
export function resetOrchestratorListenersForTest(): void {
  listenersInstalled = false;
}

/** 装载指定工作区的调度会话历史/模式/上下文（面板打开时调用） */
export function ensureOrchestratorHistory(wsId: string): void {
  ensureListeners();
  void store.ensureHistory(wsId);
  store.refreshContext(wsId);
}

const surfaceCache = new Map<WsId, ChatSurface>();

/** 调度会话表面（按工作区 memo；wsId=null 时返回 null） */
export function useOrchestratorSurface(wsId: string | null): ChatSurface | null {
  // 订阅由视图（useSyncExternalStore(surface.subscribe)）完成；这里只负责实例与装载
  const { flashTip } = useUiStore();
  useEffect(() => {
    tipFn = flashTip;
    return () => {
      if (tipFn === flashTip) tipFn = () => undefined;
    };
  }, [flashTip]);
  ensureListeners();
  return wsId ? getOrchestratorSurface(wsId) : null;
}

export function getOrchestratorSurface(wsId: WsId): ChatSurface {
  ensureListeners();
  // 首次接触登记生命周期代（隐藏面板/重开都经此保证代在）
  store.registerLive(wsId);
  const hit = surfaceCache.get(wsId);
  if (hit) return hit;
  const caps: ChatSurfaceCaps = {
    surfaceKind: 'dispatch',
    draftKey: wsId,
    images: true,
    plusMenu: true,
    bgTasks: true,
    fork: true,
    notes: true,
    presets: false,
    localCommands: true,
    manualCompact: true
  };
  const surface: ChatSurface = {
    sessionId: wsId,
    caps,
    subscribe: store.subscribe,
    getSnapshot: () => store.snapshot(wsId),
    actions: {
      send: async (text: string, images?: ChatImageAttachment[]): Promise<boolean> => {
        const trimmed = text.trim();
        if ((!trimmed && !images?.length) || !wsId) return true;
        // busy 时普通消息由主进程排队；本地清空命令不排队
        if (store.snapshot(wsId).busy && (trimmed === '/new' || trimmed === '/clear')) return true;
        // 本地会话命令：走 clear，避免 busy 卡住且不送给模型
        if (trimmed === '/new' || trimmed === '/clear') {
          void store.clear(wsId).catch(() => undefined);
          return true;
        }
        // 本地会话命令：手动压缩（busy 时主进程拒绝并以本地回显提示）
        const compactHit = parseCompactCommand(trimmed);
        if (compactHit) {
          void store.compact(wsId, compactHit.instructions);
          return true;
        }
        // 待答 askQuestion：输入框发送走既有 chat.respondUserQuestion 答问通道
        //（不再排队等回合结束）。
        // 仅单题的唯一选项精确命中；批注、自由文本、多题与带图消息走普通发送。
        if (!images?.length) {
          const pendingAsk = store.pendingAsk(wsId);
          const answers = pendingAsk ? answerFromText(pendingAsk, trimmed) : null;
          if (pendingAsk && answers) {
            try {
              const res = await window.api.chat.respondUserQuestion({
                workspaceId: wsId,
                questionId: pendingAsk.questionId,
                action: 'answer',
                answers
              });
              if (res?.ok) return true;
            } catch {
              /* 卡已被并发结算（如卡内直接作答）：回落普通发送 */
            }
          }
        }
        try {
          const res = await window.api.chat.send(
            trimmed,
            wsId,
            images?.length ? images : undefined
          );
          if (!res?.accepted) {
            if (res?.error) tipFn(res.error);
            return false;
          }
          store.setBusy(wsId, true);
          return true;
        } catch (e) {
          // chat-surface F-04：IPC 异常不再静默吞——对齐 GUI 面（agentSessionSurface send）
          // 的失败 flashTip，调度面发送失败同样可见（Composer 仍保稿）
          tipFn(t('发送失败：{{message}}', { message: (e as Error).message || String(e) }));
          return false;
        }
      },
      sendNow: async (text: string): Promise<SendNowResult> => {
        const trimmed = text.trim();
        if (!trimmed || !wsId) return 'failed';
        try {
          return await window.api.chat.sendNow(trimmed, wsId);
        } catch {
          return 'failed';
        }
      },
      editQueued: (messageId: string, text: string) => {
        void window.api.chat.editQueued(messageId, text, wsId).catch(() => undefined);
      },
      reorderQueued: (orderedIds: string[]) => {
        void window.api.chat.reorderQueued(orderedIds, wsId).catch(() => undefined);
      },
      getQueuedImages: (messageId: string) => store.getQueuedImages(wsId, messageId),
      stop: () => {
        void window.api.chat.stop(wsId).catch(() => undefined);
      },
      compact: (instructions?: string) => store.compact(wsId, instructions),
      clear: () => store.clear(wsId),
      loadEarlier: () => store.loadEarlier(wsId),
      ensureMessageLoaded: (messageId) => store.ensureMessageLoaded(wsId, messageId),
      retainPageWindow: (window) => store.retainPageWindow(wsId, window),
      messageIndex: (messageId) => store.messageIndex(wsId, messageId),
      retry: () => {
        void window.api.chat.retry(wsId).catch(() => undefined);
      },
      recallAborted: (messageId?: string) => store.recallAborted(wsId, messageId),
      cancelQueued: (messageId: string) => {
        void window.api.chat.cancelQueued(messageId, wsId).catch(() => undefined);
      },
      planAction: (action: 'execute' | 'abandon' | 'revise', feedback?: string) => {
        // 修改意见走发消息通道：模式保持 plan，修订回合结束后主进程自动出新版计划卡
        if (action === 'revise') {
          if (feedback) void surface.actions.send?.(feedback);
          return;
        }
        void window.api.chat.planAction(action, wsId).catch(() => undefined);
      },
      setMode: (m) => {
        store.setMode(wsId, m as 'default' | 'ask' | 'plan');
        void window.api.chat.setMode(m as 'default' | 'ask' | 'plan', wsId).catch(() => undefined);
      },
      setThinking: (level) => {
        // r1-6：回调捕获调用时的生命周期代——逐出/重开后旧响应不覆盖新状态
        const gen = store.currentGen(wsId);
        if (gen === undefined) {
          return Promise.resolve({ ok: false, error: t('工作区已关闭') });
        }
        const target = store.contextStatus(wsId);
        return window.api.chat.setThinking(level, wsId).then((r) => {
          if (!store.genIsCurrent(wsId, gen)) return r; // 等待期间逐出/重开：不写回
          const current = store.contextStatus(wsId);
          if (target && (target.modelId !== current?.modelId || target.provider !== current?.provider)) return r;
          if (r.ok) {
            store.setThinkingState(wsId, {
              level: r.thinkingLevel ?? level,
              available: r.available
            });
          } else if (r.error) {
            tipFn(r.error);
          }
          return r;
        });
      },
      setModelConfiguration: async ({ model, expected, parameters }) => {
        const result = await window.api.chat.switchModel(model, wsId, { expected, parameters });
        if (!result.ok || !result.applied) return { ok: false, error: result.error || t('模型切换失败') };
        store.refreshContext(wsId);
        if (result.applied === 'next-turn') tipFn(t('下一轮生效'));
        return { ok: true, applied: result.applied, warning: result.warning };
      },
      setModel: (model) => {
        if (!model) return;
        void window.api.chat.switchModel(model, wsId).then((result) => {
          if (!result.ok) return;
          if (result.thinkingReset) tipFn(result.thinkingUnknown
            ? t('新模型的思考档位未知，已恢复默认') : t('新模型不支持之前的思考档，已恢复默认'));
          store.refreshContext(wsId);
        }).catch(e => { tipFn((e as Error).message || t('模型切换失败')); });
      },
      localEcho: (content) => {
        store.localEcho(wsId, content);
      },
      fork: (messageId) => {
        void store.fork(wsId, messageId);
      }
    }
  };
  surfaceCache.set(wsId, surface);
  return surface;
}
