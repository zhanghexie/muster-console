/**
 * sessions.search：按路径 / 提交 / 关键词检索历史会话（纯函数）。
 * 第一期无向量库——子串 + 规范化路径 + 短 SHA。只读：不改入参数组。
 */
import type { GuiChatMessage } from './guiWorker';

export const SESSION_SEARCH_DEFAULT_LIMIT = 20;
export const SESSION_SEARCH_MAX_LIMIT = 50;
export const SESSION_SEARCH_SNIPPET = 160;
export const SESSION_SEARCH_HAYSTACK_MAX = 200_000;
export const SESSION_SEARCH_COMMIT_MIN = 7;
/**
 * session-search F-02 全区扫描预算（宽松：正常库不触发）：
 * - 会话数上限：按 lastUsedAt 新→旧排序后最多扫描这么多会话；
 * - 语料字节上限：本轮扫描累积的 haystack 字符总量（含落盘转写读取）。
 * 超出任一预算即停止扫描并在结果带「已截断」信号，防大库主进程同步 IO 卡顿。
 */
export const SESSION_SEARCH_SCAN_MAX_SESSIONS = 300;
export const SESSION_SEARCH_SCAN_MAX_CHARS = 4_000_000;

export type SessionSearchClue = 'path' | 'commit' | 'keyword';

export interface SessionSearchQuery {
  path?: string;
  commit?: string;
  q?: string;
  limit: number;
}

export interface SessionSearchDoc {
  sessionId: string;
  name: string;
  workspaceId?: string;
  workspaceName?: string;
  createdAt: number;
  lastUsedAt?: number;
  archived?: boolean;
  runtime?: string;
  /** 调用方已拼好的检索语料；本模块只读 */
  haystack: string;
}

export interface SessionSearchHit {
  sessionId: string;
  name: string;
  workspaceId?: string;
  workspaceName?: string;
  createdAt: number;
  lastUsedAt: number;
  archived?: boolean;
  runtime?: string;
  summary: string;
  matchedBy: SessionSearchClue[];
}

export function clampSessionSearchLimit(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return SESSION_SEARCH_DEFAULT_LIMIT;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > SESSION_SEARCH_MAX_LIMIT) return SESSION_SEARCH_MAX_LIMIT;
  return i;
}

/** 缺 path/commit/q 时 error='empty'；commit 1–6 位时 error='short-commit'（handler 再抛本地化错） */
export function parseSessionSearchQuery(args?: {
  path?: unknown;
  commit?: unknown;
  q?: unknown;
  limit?: unknown;
}): SessionSearchQuery | { error: 'empty' } | { error: 'short-commit'; commit: string } {
  const path = typeof args?.path === 'string' ? args.path.trim() : '';
  const commit = typeof args?.commit === 'string' ? args.commit.trim() : '';
  const q = typeof args?.q === 'string' ? args.q.trim() : '';
  if (!path && !commit && !q) return { error: 'empty' };
  // session-search F-01：短哈希静默零命中无从区分「没有会话」与「输入太短」——
  // <7 位 commit 在入口显式报错（haystackMatchesCommit 对 <7 位恒 false）。
  if (commit && commit.length < SESSION_SEARCH_COMMIT_MIN) {
    return { error: 'short-commit', commit };
  }
  return {
    ...(path ? { path } : {}),
    ...(commit ? { commit } : {}),
    ...(q ? { q } : {}),
    limit: clampSessionSearchLimit(args?.limit)
  };
}

/** 省略 / 空 = 当前工作区；`*` 或 `all` = 本机全部工作区 */
export function parseSessionSearchScope(raw: unknown, currentWorkspaceId: string): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return currentWorkspaceId;
  if (s === '*' || s.toLowerCase() === 'all') return '*';
  return s;
}

export function sessionBelongsToSearchScope(
  sessionWorkspaceId: string | undefined,
  scope: string,
  currentWorkspaceId: string
): boolean {
  if (scope === '*') return true;
  const ws = sessionWorkspaceId?.trim() || currentWorkspaceId;
  return ws === scope;
}

/**
 * session-search F-02 扫描计划：范围内候选按 lastUsedAt（缺省 createdAt）新→旧排序，
 * 超出会话数预算截掉最旧并标记 truncated（旧会话被截优先于新会话）；正常库不触发。
 * 字节预算（SESSION_SEARCH_SCAN_MAX_CHARS）由调用方在逐会话读盘累积语料时执行。
 */
export function planSessionSearchScan<T extends { lastUsedAt?: number; createdAt?: number }>(
  rows: readonly T[],
  maxSessions: number = SESSION_SEARCH_SCAN_MAX_SESSIONS
): { ordered: T[]; truncated: boolean } {
  const ordered = [...rows].sort(
    (a, b) => (b.lastUsedAt ?? b.createdAt ?? 0) - (a.lastUsedAt ?? a.createdAt ?? 0)
  );
  if (ordered.length <= maxSessions) return { ordered, truncated: false };
  return { ordered: ordered.slice(0, maxSessions), truncated: true };
}

/** 检索用语料：正文 + 工具名/入参/输出/patch（路径常在工具卡里） */
export function guiMessageSearchText(m: Pick<GuiChatMessage, 'parts'>): string {
  const chunks: string[] = [];
  for (const p of m.parts ?? []) {
    if (p.kind === 'text' || p.kind === 'thinking') {
      if (p.text) chunks.push(p.text);
    } else if (p.kind === 'tool') {
      chunks.push(p.tool.name);
      try {
        chunks.push(JSON.stringify(p.tool.input));
      } catch {
        /* 循环引用等：跳过该入参 */
      }
      if (p.tool.output) chunks.push(p.tool.output);
      if (p.tool.patch) chunks.push(p.tool.patch);
    }
  }
  return chunks.join('\n');
}

export function buildSessionHaystack(input: {
  name?: string;
  cwd?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  messages?: Iterable<Pick<GuiChatMessage, 'parts'>>;
}, maxChars = SESSION_SEARCH_HAYSTACK_MAX): string {
  // 增量裁剪：累积超预算即停，不先 join 全量再裁（大会话先拼出几 MB 再丢弃纯浪费）。
  // 顺序累积 + 末尾 clip，产出与「join 全量后 slice(0, MAX)」逐字节一致
  const parts: string[] = [];
  let total = 0;
  const budget = Math.max(0, Math.min(SESSION_SEARCH_HAYSTACK_MAX, maxChars));
  const push = (s: string): void => {
    if (!s || total >= budget) return;
    if (parts.length) total++;
    const clipped = s.slice(0, Math.max(0, budget - total));
    parts.push(clipped);
    total += clipped.length;
  };
  push(input.name ?? '');
  push(input.cwd ?? '');
  push(input.worktreePath ?? '');
  push(input.worktreeBranch ?? '');
  if (input.messages && total < budget) {
    for (const m of input.messages) {
      push(guiMessageSearchText(m));
      if (total >= budget) break;
    }
  }
  return parts.join('\n').slice(0, budget);
}

export function normalizeSearchPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function haystackMatchesPath(haystack: string, filePath: string): boolean {
  const needle = normalizeSearchPath(filePath);
  if (!needle) return false;
  const hay = normalizeSearchPath(haystack);
  if (hay.includes(needle)) return true;
  const base = needle.split('/').pop() ?? '';
  return base.length > 0 && hay.includes(base);
}

export function haystackMatchesCommit(haystack: string, commit: string): boolean {
  const needle = commit.trim().toLowerCase();
  if (needle.length < SESSION_SEARCH_COMMIT_MIN) return false;
  return haystack.toLowerCase().includes(needle);
}

export function haystackMatchesKeyword(haystack: string, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  return haystack.toLowerCase().includes(needle);
}

export function extractSearchSnippet(haystack: string, needle: string, max = SESSION_SEARCH_SNIPPET): string {
  const hay = haystack.replace(/\s+/g, ' ').trim();
  if (!hay) return '';
  const n = needle.trim();
  if (!n) return hay.length <= max ? hay : `${hay.slice(0, max)}…`;
  const idx = hay.toLowerCase().indexOf(n.toLowerCase());
  if (idx < 0) return hay.length <= max ? hay : `${hay.slice(0, max)}…`;
  const pad = Math.max(0, Math.floor((max - n.length) / 2));
  const start = Math.max(0, idx - pad);
  const end = Math.min(hay.length, start + max);
  const slice = hay.slice(start, end);
  return `${start > 0 ? '…' : ''}${slice}${end < hay.length ? '…' : ''}`;
}

function firstNeedle(query: SessionSearchQuery): string {
  return query.path || query.commit || query.q || '';
}

function docMatches(doc: SessionSearchDoc, query: SessionSearchQuery): SessionSearchClue[] {
  const matched: SessionSearchClue[] = [];
  const named = `${doc.haystack}\n${doc.name}`;
  if (query.path) {
    if (haystackMatchesPath(named, query.path)) matched.push('path');
    else return [];
  }
  if (query.commit) {
    if (haystackMatchesCommit(named, query.commit)) matched.push('commit');
    else return [];
  }
  if (query.q) {
    if (haystackMatchesKeyword(named, query.q)) matched.push('keyword');
    else return [];
  }
  return matched;
}

/** 按 lastUsedAt 新→旧；返回新数组，不改 docs */
export function searchSessionDocs(
  docs: readonly SessionSearchDoc[],
  query: SessionSearchQuery
): SessionSearchHit[] {
  const hits: SessionSearchHit[] = [];
  for (const doc of docs) {
    const matchedBy = docMatches(doc, query);
    if (!matchedBy.length) continue;
    hits.push({
      sessionId: doc.sessionId,
      name: doc.name,
      ...(doc.workspaceId ? { workspaceId: doc.workspaceId } : {}),
      ...(doc.workspaceName ? { workspaceName: doc.workspaceName } : {}),
      createdAt: doc.createdAt,
      lastUsedAt: doc.lastUsedAt ?? doc.createdAt,
      ...(doc.archived ? { archived: true } : {}),
      ...(doc.runtime ? { runtime: doc.runtime } : {}),
      summary: extractSearchSnippet(doc.haystack || doc.name, firstNeedle(query)),
      matchedBy
    });
  }
  hits.sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt);
  return hits.slice(0, query.limit);
}
