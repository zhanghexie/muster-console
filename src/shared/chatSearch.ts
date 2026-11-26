/**
 * 会话消息文本搜索：只扫 user/assistant 的 text part（无 parts 时回落 content），
 * 忽略 thinking / 工具卡 / 宿主通栏 / 本地回显。大小写不敏感、非重叠。
 * 纯函数，渲染层与 node 自测共用。
 */

export const CHAT_SEARCH_MAX_HITS = 2000;
export const CHAT_SEARCH_SNIPPET_PAD = 36;

export type ChatSearchableMessage = {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  host?: boolean;
  local?: boolean;
  parts?: ReadonlyArray<{ kind: string; text?: string }>;
};

export type ChatSearchMatch = { start: number; end: number };

export type ChatSearchHit = {
  sessionId: string;
  sessionName: string;
  messageId: string;
  /** Absolute transcript position when returned by a paged history search. */
  messageIndex?: number;
  role: 'user' | 'assistant';
  start: number;
  end: number;
  /** 该消息内第几个命中（0-based） */
  indexInMessage: number;
  snippet: string;
};

export type ChatSearchGroup = {
  sessionId: string;
  sessionName: string;
  hits: ChatSearchHit[];
};

/** 搜索结果 + 截断元信息：truncated = 有命中因 CHAT_SEARCH_MAX_HITS 上限被丢弃 */
export type ChatSearchOutcome<T> = { hits: T; truncated: boolean };

/** 命中身份：跨表面共享活动命中时用它而不是数字下标——各表面的组合列表顺序不同，
 *  下标落到别的表面会指向另一条命中；身份在任何表面的列表里都指同一条。 */
export type ChatSearchHitId = Pick<ChatSearchHit, 'sessionId' | 'messageId' | 'indexInMessage'>;

export function chatSearchHitId(hit: ChatSearchHit): ChatSearchHitId {
  return { sessionId: hit.sessionId, messageId: hit.messageId, indexInMessage: hit.indexInMessage };
}

export function sameChatSearchHitId(
  a: ChatSearchHit | ChatSearchHitId,
  b: ChatSearchHit | ChatSearchHitId
): boolean {
  return a.sessionId === b.sessionId && a.messageId === b.messageId && a.indexInMessage === b.indexInMessage;
}

/**
 * 全部会话范围的规范命中序：按 sessionOrder 拼接各会话的命中（会话内保持文档序）。
 * 每个表面用同一份 (会话→命中) 输入得到同一个全局序，跨会话导航/计数以此为准。
 * sessionOrder 未列到的会话（理论上不该有）追加尾部，保证不丢命中。
 */
export function assembleChatSearchHits(
  hitsBySession: ReadonlyMap<string, ChatSearchHit[]>,
  sessionOrder: readonly string[]
): ChatSearchHit[] {
  return assembleChatSearchHitsWithMeta(hitsBySession, sessionOrder).hits;
}

/** 组装规范序并报告是否触达上限截断（F-02：截断必须对用户可见，不再静默 slice）。 */
export function assembleChatSearchHitsWithMeta(
  hitsBySession: ReadonlyMap<string, ChatSearchHit[]>,
  sessionOrder: readonly string[]
): ChatSearchOutcome<ChatSearchHit[]> {
  const out: ChatSearchHit[] = [];
  for (const id of sessionOrder) {
    const hits = hitsBySession.get(id);
    if (hits) out.push(...hits);
  }
  for (const [id, hits] of hitsBySession) {
    if (!sessionOrder.includes(id)) out.push(...hits);
  }
  const truncated = out.length > CHAT_SEARCH_MAX_HITS;
  return { hits: out.slice(0, CHAT_SEARCH_MAX_HITS), truncated };
}


/** 可检索正文：仅 text part；无 parts 时用 content。host/local 不进检索。 */
export function searchableChatText(m: ChatSearchableMessage): string {
  if (m.host || m.local) return '';
  if (m.role !== 'user' && m.role !== 'assistant') return '';
  if (m.parts?.length) {
    return m.parts
      .filter((p) => p.kind === 'text' && p.text)
      .map((p) => p.text as string)
      .join('\n');
  }
  return m.content ?? '';
}

export function findTextMatches(text: string, query: string): ChatSearchMatch[] {
  return findTextMatchesWithMeta(text, query).matches;
}

/** 单条正文内匹配 + 是否还有被上限丢弃的更多匹配（长粘贴日志场景单条即可超限）。 */
export function findTextMatchesWithMeta(
  text: string,
  query: string
): { matches: ChatSearchMatch[]; truncated: boolean } {
  const q = query.trim();
  if (!q || !text) return { matches: [], truncated: false };
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: ChatSearchMatch[] = [];
  let from = 0;
  while (out.length < CHAT_SEARCH_MAX_HITS) {
    const hit = hay.indexOf(needle, from);
    if (hit < 0) break;
    out.push({ start: hit, end: hit + needle.length });
    from = hit + needle.length;
  }
  const truncated = from < hay.length && hay.indexOf(needle, from) >= 0;
  return { matches: out, truncated };
}

export function makeSearchSnippet(text: string, start: number, end: number): string {
  const lo = Math.max(0, start - CHAT_SEARCH_SNIPPET_PAD);
  const hi = Math.min(text.length, end + CHAT_SEARCH_SNIPPET_PAD);
  const prefix = lo > 0 ? '…' : '';
  const suffix = hi < text.length ? '…' : '';
  return `${prefix}${text.slice(lo, hi).replace(/\s+/g, ' ')}${suffix}`;
}

export function searchChatMessages(
  messages: readonly ChatSearchableMessage[],
  query: string,
  session: { id: string; name: string }
): ChatSearchHit[] {
  return searchChatMessagesWithMeta(messages, query, session).hits;
}

/** 单会话搜索 + 截断元信息：触达上限提前返回或单条正文还有剩余匹配时 truncated=true。 */
export function searchChatMessagesWithMeta(
  messages: readonly ChatSearchableMessage[],
  query: string,
  session: { id: string; name: string }
): ChatSearchOutcome<ChatSearchHit[]> {
  const q = query.trim();
  if (!q) return { hits: [], truncated: false };
  const hits: ChatSearchHit[] = [];
  let truncated = false;
  for (const m of messages) {
    const text = searchableChatText(m);
    if (!text) continue;
    const { matches, truncated: messageTruncated } = findTextMatchesWithMeta(text, q);
    if (messageTruncated) truncated = true;
    for (let i = 0; i < matches.length; i++) {
      if (hits.length >= CHAT_SEARCH_MAX_HITS) return { hits, truncated: true };
      const { start, end } = matches[i]!;
      hits.push({
        sessionId: session.id,
        sessionName: session.name,
        messageId: m.id,
        role: m.role,
        start,
        end,
        indexInMessage: i,
        snippet: makeSearchSnippet(text, start, end)
      });
    }
  }
  return { hits, truncated };
}

export function groupChatSearchHits(hits: readonly ChatSearchHit[]): ChatSearchGroup[] {
  const order: string[] = [];
  const by = new Map<string, ChatSearchGroup>();
  for (const hit of hits) {
    let g = by.get(hit.sessionId);
    if (!g) {
      g = { sessionId: hit.sessionId, sessionName: hit.sessionName, hits: [] };
      by.set(hit.sessionId, g);
      order.push(hit.sessionId);
    }
    g.hits.push(hit);
  }
  return order.map((id) => by.get(id)!);
}
