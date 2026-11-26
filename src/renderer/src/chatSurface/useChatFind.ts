/**
 * 会话查找控制器：共享开合/查询/范围，当前会话即时匹配，全部会话防抖拉历史。
 * 活动命中以身份（sessionId+messageId+indexInMessage）跨表面共享；「全部会话」
 * 范围的列表与导航走规范序（调度面最前、GUI 会话按会话列表序），任意表面一致。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatSearchGroup, ChatSearchHit, ChatSearchableMessage } from '../../../shared/chatSearch';
import {
  CHAT_SEARCH_MAX_HITS,
  assembleChatSearchHitsWithMeta,
  chatSearchHitId,
  groupChatSearchHits,
  sameChatSearchHitId,
  searchChatMessagesWithMeta
} from '../../../shared/chatSearch';
import { t } from '../../../shared/i18n';
import { jumpToSession } from '../sessionJump';
import { runtimeSurface, type SessionMeta } from '../../../shared/types';
import type { AgentRuntimeEntry } from '../../../shared/types';
import {
  dispatchFindId,
  getChatFindShared,
  isDispatchFindId,
  openDispatchChat,
  patchChatFindShared,
  registerChatFindTarget,
  subscribeChatFindShared,
  updateChatFindTarget,
  workspaceIdFromDispatchFind,
  type ChatFindScope
} from './chatFindRegistry';

const ALL_DEBOUNCE_MS = 150;
const EMPTY_HITS: ChatSearchHit[] = [];

export function chatFindIdFor(
  surfaceKind: 'dispatch' | 'gui-session',
  sessionId: string
): string {
  return surfaceKind === 'dispatch' ? dispatchFindId(sessionId) : sessionId;
}

export function useChatFind(opts: {
  enabled: boolean;
  surfaceKind: 'dispatch' | 'gui-session';
  sessionId: string;
  sessionName: string;
  workspaceId?: string;
  messages: readonly ChatSearchableMessage[];
  historyIncomplete?: boolean;
  messageSlots?: ReadonlyArray<{ index: number; messageId: string }>;
  sessions: SessionMeta[];
  runtimes: AgentRuntimeEntry[];
  surfaceEl: HTMLElement | null;
}): {
  open: boolean;
  isOwner: boolean;
  query: string;
  setQuery: (q: string) => void;
  scope: ChatFindScope;
  toggleScope: () => void;
  hits: ChatSearchHit[];
  groups: ChatSearchGroup[];
  /** 全部会话范围内拉取失败的会话数（F-01：失败不再与「无命中」不可区分） */
  failedSessions: number;
  /** 命中触达 CHAT_SEARCH_MAX_HITS 上限被截断（F-02） */
  truncated: boolean;
  activeIndex: number;
  activeHit: ChatSearchHit | null;
  go: (delta: 1 | -1) => void;
  close: () => void;
  jumpToHit: (hit: ChatSearchHit) => void;
  focusEpoch: number;
} {
  const findId = chatFindIdFor(opts.surfaceKind, opts.sessionId);
  const shared = useSyncExternalStore(subscribeChatFindShared, getChatFindShared);
  // 查找保留查询词供下次打开；保活但隐藏的会话、关闭态不消费该查询，
  // 否则每批流式消息都会重扫全文，全部会话范围还会逐实例重复拉历史。
  const searching = shared.open && opts.enabled;
  const EMPTY_REMOTE = { hits: EMPTY_HITS, failedSessions: 0, truncated: false, query: '', currentId: '' } as const;
  const [remote, setRemote] = useState<{
    hits: ChatSearchHit[];
    failedSessions: number;
    truncated: boolean;
    query: string;
    currentId: string;
  }>(EMPTY_REMOTE);
  const fetchGen = useRef(0);

  // 拉取防抖只在 query/scope/open 变化时重排：sessions/runtimes 引用随会话状态 tick
  // 高频更换，进依赖会把 150ms 防抖无限推迟——定时器触发时经 ref 读最新值。
  const sessionsRef = useRef(opts.sessions);
  sessionsRef.current = opts.sessions;
  const runtimesRef = useRef(opts.runtimes);
  runtimesRef.current = opts.runtimes;

  useEffect(() => {
    const unreg = registerChatFindTarget({
      id: findId,
      kind: opts.surfaceKind,
      enabled: opts.enabled,
      sessionId: opts.sessionId,
      el: opts.surfaceEl
    });
    return unreg;
  }, [findId, opts.surfaceKind, opts.sessionId]);

  useEffect(() => {
    updateChatFindTarget(findId, { enabled: opts.enabled, el: opts.surfaceEl, sessionId: opts.sessionId });
  }, [findId, opts.enabled, opts.surfaceEl, opts.sessionId]);

  const currentResult = useMemo(
    () =>
      searching ? searchChatMessagesWithMeta(opts.messages, shared.query, {
        id: findId,
        name: opts.sessionName
      }) : { hits: EMPTY_HITS, truncated: false },
    [searching, opts.messages, shared.query, findId, opts.sessionName]
  );
  const currentHits = useMemo(() => {
    if (!opts.historyIncomplete || remote.query !== shared.query.trim() || remote.currentId !== findId) return currentResult.hits;
    const loaded = new Set(opts.messages.map(message => message.id));
    const positions = new Map(opts.messageSlots?.map(slot => [slot.messageId, slot.index]));
    return [...remote.hits.filter(hit => hit.sessionId === findId && !loaded.has(hit.messageId)),
      ...currentResult.hits.map(hit => ({ ...hit, messageIndex: positions.get(hit.messageId) }))]
      .sort((a, b) => (a.messageIndex ?? Number.MAX_SAFE_INTEGER) - (b.messageIndex ?? Number.MAX_SAFE_INTEGER) || a.indexInMessage - b.indexInMessage);
  }, [currentResult.hits, remote, shared.query, findId, opts.historyIncomplete, opts.messages, opts.messageSlots]);

  // 「全部会话」组合列表 = 规范序（调度面最前、GUI 会话按会话列表序），每个表面
  // 算出同一个全局序：导航/计数/列表分组在跨会话跳转后仍然对得上。
  const { hits, truncated } = useMemo(() => {
    if (!searching) return { hits: currentHits, truncated: currentResult.truncated };
    if (shared.scope !== 'all') return { hits: currentHits, truncated: currentResult.truncated || (remote.currentId === findId && remote.truncated) };
    const hitsBySession = new Map<string, ChatSearchHit[]>();
    hitsBySession.set(findId, currentHits);
    for (const h of remote.hits) {
      if (h.sessionId === findId) continue;
      const bucket = hitsBySession.get(h.sessionId);
      if (bucket) bucket.push(h);
      else hitsBySession.set(h.sessionId, [h]);
    }
    const order: string[] = [];
    for (const key of hitsBySession.keys()) {
      if (isDispatchFindId(key)) order.push(key);
    }
    for (const s of opts.sessions) {
      if (hitsBySession.has(s.id)) order.push(s.id);
    }
    const assembled = assembleChatSearchHitsWithMeta(hitsBySession, order);
    return {
      hits: assembled.hits,
      truncated: assembled.truncated || currentResult.truncated || remote.truncated
    };
  }, [searching, shared.scope, currentHits, currentResult, remote, findId, opts.sessions]);

  const groups = useMemo(() => groupChatSearchHits(hits), [hits]);

  // 活动命中按身份反查本表面列表；身份为空（刚改查询/换范围）或已失效时回落到
  // 本会话第一条——保持「新查询从本会话开头看起」的既有手感。
  const activeId = shared.activeHitId;
  const rawActiveIdx = activeId ? hits.findIndex((h) => sameChatSearchHitId(h, activeId)) : -1;
  const ownFirstIdx = hits.findIndex((h) => h.sessionId === findId);
  const safeIndex =
    rawActiveIdx >= 0 ? rawActiveIdx : hits.length === 0 ? 0 : Math.max(0, ownFirstIdx);
  const activeHit = hits[safeIndex] ?? null;

  useEffect(() => {
    const gen = ++fetchGen.current;
    if ((shared.scope !== 'all' && !opts.historyIncomplete) || !shared.query.trim() || !searching) {
      setRemote(EMPTY_REMOTE);
      return;
    }
    setRemote(EMPTY_REMOTE);
    const requestId = crypto.randomUUID();
    let active = true;
    const timer = window.setTimeout(() => {
      void loadAllSessionHits({
        query: shared.query,
        workspaceId: opts.workspaceId,
        sessions: sessionsRef.current,
        runtimes: runtimesRef.current,
        skipId: findId,
        requestId,
        active: () => active,
        all: shared.scope === 'all',
        current: opts.historyIncomplete ? { id: findId, sessionId: opts.sessionId, name: opts.sessionName, kind: opts.surfaceKind } : undefined
      }).then((next) => {
        if (fetchGen.current === gen) setRemote(next);
      });
    }, ALL_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      active = false;
      void window.api.chat.searchCancel(requestId).catch(() => {});
      void window.api.agentSession.searchCancel(requestId).catch(() => {});
      // 取消已发出的请求的结果投递；关闭、隐藏或改词均不能被旧结果回写。
      fetchGen.current += 1;
    };
  }, [shared.scope, shared.query, searching, opts.workspaceId, findId, opts.historyIncomplete, opts.sessionId, opts.sessionName, opts.surfaceKind]);

  const setQuery = useCallback((q: string) => {
    patchChatFindShared({ query: q, activeHitId: null });
  }, []);

  const toggleScope = useCallback(() => {
    const next: ChatFindScope = getChatFindShared().scope === 'all' ? 'current' : 'all';
    patchChatFindShared({ scope: next, activeHitId: null });
  }, []);

  const close = useCallback(() => {
    patchChatFindShared({ open: false, ownerId: null });
  }, []);

  const jumpToHit = useCallback(
    (hit: ChatSearchHit) => {
      patchChatFindShared({
        open: true,
        ownerId: hit.sessionId,
        activeHitId: chatSearchHitId(hit)
      });
      if (hit.sessionId === findId) return;
      if (isDispatchFindId(hit.sessionId)) {
        openDispatchChat(workspaceIdFromDispatchFind(hit.sessionId));
        return;
      }
      void jumpToSession({ sessionId: hit.sessionId, workspaceId: opts.workspaceId });
    },
    [findId, opts.workspaceId]
  );

  const go = useCallback(
    (delta: 1 | -1) => {
      if (hits.length === 0) return;
      const next = (safeIndex + delta + hits.length) % hits.length;
      const hit = hits[next]!;
      patchChatFindShared({
        activeHitId: chatSearchHitId(hit),
        ownerId: hit.sessionId,
        open: true
      });
      if (hit.sessionId !== findId) {
        if (isDispatchFindId(hit.sessionId)) {
          openDispatchChat(workspaceIdFromDispatchFind(hit.sessionId));
        } else {
          void jumpToSession({ sessionId: hit.sessionId, workspaceId: opts.workspaceId });
        }
      }
    },
    [hits, safeIndex, findId, opts.workspaceId]
  );

  return {
    open: shared.open,
    isOwner: shared.open && shared.ownerId === findId,
    query: shared.query,
    setQuery,
    scope: shared.scope,
    toggleScope,
    hits,
    groups,
    failedSessions: searching ? remote.failedSessions : 0,
    truncated,
    activeIndex: safeIndex,
    activeHit,
    go,
    close,
    jumpToHit,
    focusEpoch: shared.focusEpoch
  };
}

/**
 * 拉全部会话命中：调度面在最前，GUI 会话按传入顺序各自成桶并发拉取后按桶拼接——
 * 完成顺序不影响最终顺序（规范序的输入必须稳定）。
 * 单会话拉取失败不再静默成空桶（F-01）：计入 failedSessions 供结果列表提示
 * 「N 个会话读取失败」，与「该会话确实无命中」区分开；任一会话命中触达上限时
 * truncated=true（F-02）。
 */
async function loadAllSessionHits(input: {
  query: string;
  workspaceId?: string;
  sessions: SessionMeta[];
  runtimes: AgentRuntimeEntry[];
  skipId: string;
  requestId: string;
  active: () => boolean;
  all: boolean;
  current?: { id: string; sessionId: string; name: string; kind: 'dispatch' | 'gui-session' };
}): Promise<{ hits: ChatSearchHit[]; failedSessions: number; truncated: boolean; query: string; currentId: string }> {
  const query = input.query.trim();
  const buckets: Array<{ id: string; sessionId: string; name: string; kind: 'dispatch' | 'gui-session'; hits: ChatSearchHit[] }> = [];
  if (input.current) buckets.push({ ...input.current, hits: [] });
  if (input.all) {
    const runtimes = Object.fromEntries(input.runtimes.map(runtime => [runtime.id, runtime]));
    if (!isDispatchFindId(input.skipId) && input.workspaceId) buckets.push({ id: dispatchFindId(input.workspaceId), sessionId: input.workspaceId, name: t('调度'), kind: 'dispatch', hits: [] });
    for (const session of input.sessions) {
      if (session.archived || session.id === input.skipId || (input.workspaceId && session.workspaceId && session.workspaceId !== input.workspaceId)) continue;
      if (runtimeSurface(session.runtime ? runtimes[session.runtime] : undefined) !== 'chat') continue;
      buckets.push({ id: session.id, sessionId: session.id, name: session.name || session.id.slice(0, 8), kind: 'gui-session', hits: [] });
    }
  }
  if (input.all) {
    const order = new Map(input.sessions.map((session, index) => [session.id, index]));
    buckets.sort((a, b) => (a.kind === 'dispatch' ? -1 : order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (b.kind === 'dispatch' ? -1 : order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  let failedSessions = 0, truncated = false, next = 0, collected = 0;
  const run = async (): Promise<void> => {
    while (input.active() && next < buckets.length && collected <= CHAT_SEARCH_MAX_HITS) {
      const bucket = buckets[next++];
      try {
        const api = bucket.kind === 'dispatch' ? window.api.chat : window.api.agentSession;
        const result = await api.search(bucket.sessionId, query, bucket.name, input.requestId);
        if (!input.active()) return;
        bucket.hits = result.hits;
        collected += result.hits.length;
        truncated ||= result.truncated;
      } catch { if (input.active()) failedSessions++; }
    }
  };
  // Bound simultaneous readers across many sessions; a hidden/closed query
  // cancels accepted jobs and never starts another queued session scan.
  await Promise.all([run(), run()]);
  return { hits: buckets.flatMap(bucket => bucket.hits).slice(0, CHAT_SEARCH_MAX_HITS), failedSessions, truncated: truncated || collected > CHAT_SEARCH_MAX_HITS, query, currentId: input.current?.id ?? '' };
}
