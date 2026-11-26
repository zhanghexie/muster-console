/**
 * 会话流里的上下文压缩分割线：标记模型 + 事件归并（乐观 pending 与
 * 引擎 compaction 事件对账）+ 按时间插入消息流。
 *
 * 生命周期：running = 一次性活跃态（贴消息流末尾）；complete = 归档后的
 * 历史标记（锚定压缩发生时最后一条消息，不是常驻底部的持久活跃态）。
 * 纯函数、零依赖，渲染层与离线自测共用。
 */

export type ChatCompactionStatus = 'running' | 'complete';

/** 消息流分割线的一条压缩记录（进行中或已完成；失败不留线） */
export interface ChatCompactionMarker {
  id: string;
  status: ChatCompactionStatus;
  createdAt: number;
  /** 压缩前后规模（Host 从压缩结果补写；未知缺省——透明分隔线不显示数字） */
  tokensBefore?: number | null;
  tokensAfter?: number | null;
}

export const EMPTY_COMPACTION_MARKERS: readonly ChatCompactionMarker[] = [];

const PENDING_PREFIX = 'pending-';

export function isPendingCompactionId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

export function newPendingCompactionId(now = Date.now()): string {
  return `${PENDING_PREFIX}${now}`;
}

/** 是否还有进行中的活跃压缩（complete 不算活跃） */
export function hasActiveCompaction(markers: readonly ChatCompactionMarker[]): boolean {
  return markers.some((m) => m.status === 'running');
}

/**
 * 归档锚点：压缩发生时最后一条非排队消息的时间。
 * complete 必须归位到这里，不能用 compact() 返回时刻（那会永远大于已有消息、贴底）。
 */
export function compactionAnchorAt(
  messages: readonly { createdAt?: number; ts?: number; queued?: boolean }[],
  fallback = 0
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.queued) continue;
    const t = m.createdAt ?? m.ts;
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) return t;
  }
  return fallback;
}

function archiveComplete(
  marker: Pick<ChatCompactionMarker, 'id' | 'createdAt'>,
  evId: string,
  anchorAt?: number,
  tokens?: { tokensBefore?: number | null; tokensAfter?: number | null }
): ChatCompactionMarker {
  const at = anchorAt ?? marker.createdAt;
  return { id: evId, status: 'complete', createdAt: at, ...(tokens ?? {}) };
}

/** 乐观开始：已有进行中则复用，避免 /compact 与事件双线 */
export function beginCompaction(
  markers: readonly ChatCompactionMarker[],
  id: string,
  createdAt: number
): ChatCompactionMarker[] {
  if (hasActiveCompaction(markers)) return markers.slice();
  return [...markers, { id, status: 'running', createdAt }];
}

/** 把乐观 pending 收成完成（事件未到时的兜底）；已被事件改写则不动 */
export function completePendingCompaction(
  markers: readonly ChatCompactionMarker[],
  pendingId: string,
  anchorAt?: number
): ChatCompactionMarker[] {
  let changed = false;
  const next = markers.map((m) => {
    if (m.id === pendingId && m.status === 'running') {
      changed = true;
      return archiveComplete(m, m.id, anchorAt);
    }
    return m;
  });
  return changed ? next : markers.slice();
}

/**
 * 失败或中止：只摘与传入 id 关联的线——传入的 id 本身（pendingId 或引擎 id），
 * 及已归并/认领到该 id 的线（认领会把 pending 的 id 改写成引擎 id，按 id 即可命中）。
 * 其它 running pending（别的表面/压缩流并发插入的乐观线）不动：
 * 双表面共用单例 store 时，B 失败不得摘掉 A 的乐观线，各自由自己的收口路径处理。
 */
export function dropCompaction(
  markers: readonly ChatCompactionMarker[],
  id: string
): ChatCompactionMarker[] {
  return markers.filter((m) => m.id !== id);
}

/**
 * 归并一条引擎 compaction 事件。
 * 进行中的 pending 会被同一条真实 id 认领，避免乐观插入与事件各画一条。
 * complete 是结算事件：回落 running，并把标记归位到 anchorAt（最后一条消息）。
 * error 不留分割线（失败走 Composer hint）。
 */
export function applyCompactionEvent(
  markers: readonly ChatCompactionMarker[],
  ev: {
    id: string;
    status: 'running' | 'complete' | 'error';
    error?: string;
    tokensBefore?: number | null;
    tokensAfter?: number | null;
  },
  time: number,
  anchorAt?: number
): ChatCompactionMarker[] {
  if (ev.status === 'error') return dropCompaction(markers, ev.id);

  const pending = markers.find((m) => isPendingCompactionId(m.id));
  const byId = markers.find((m) => m.id === ev.id);

  if (ev.status === 'running') {
    if (byId) return markers.slice();
    if (pending) {
      return markers.map((m) => (m.id === pending.id ? { ...m, id: ev.id } : m));
    }
    return [...markers, { id: ev.id, status: 'running', createdAt: time }];
  }

  const tokens =
    ev.tokensBefore !== undefined || ev.tokensAfter !== undefined
      ? { tokensBefore: ev.tokensBefore, tokensAfter: ev.tokensAfter }
      : undefined;
  if (byId) {
    return markers.map((m) =>
      m.id === ev.id ? archiveComplete(m, ev.id, anchorAt, tokens) : m
    );
  }
  if (pending) {
    return markers.map((m) =>
      m.id === pending.id ? archiveComplete(m, ev.id, anchorAt, tokens) : m
    );
  }
  return [
    ...markers,
    {
      id: ev.id,
      status: 'complete',
      createdAt: anchorAt ?? time,
      ...(tokens ?? {})
    }
  ];
}

/** 从会话信封重建历史标记（只留已完成；id 取信封下标——跨重启只需 React key 稳定） */
export function markersFromCompactions(
  records: ReadonlyArray<{ at: number; tokensBefore?: number | null; tokensAfter?: number | null }>
): ChatCompactionMarker[] {
  return records
    .filter((r) => typeof r.at === 'number' && Number.isFinite(r.at))
    .map((r, i) => ({
      id: `hc-e${i}`,
      status: 'complete' as const,
      createdAt: r.at,
      ...(r.tokensBefore !== undefined ? { tokensBefore: r.tokensBefore } : {}),
      ...(r.tokensAfter !== undefined ? { tokensAfter: r.tokensAfter } : {})
    }));
}

export type TranscriptStreamItem<T> =
  | { kind: 'message'; message: T; srcIndex: number }
  | { kind: 'compaction'; marker: ChatCompactionMarker };

/**
 * 按 createdAt 把压缩分割线插进消息流。
 * complete = 历史标记，按时间插入（同刻：消息在前，压缩发生在该条之后）。
 * running = 活跃态，始终贴在流末尾，不按时间插到中间。
 */
export function interleaveCompactionMarkers<T extends { createdAt: number }>(
  messages: readonly T[],
  markers: readonly ChatCompactionMarker[]
): Array<TranscriptStreamItem<T>> {
  if (markers.length === 0) {
    return messages.map((message, srcIndex) => ({ kind: 'message', message, srcIndex }));
  }
  const historical = markers
    .filter((m) => m.status === 'complete')
    .slice()
    .sort((a, b) => {
      const dt = a.createdAt - b.createdAt;
      return dt !== 0 ? dt : a.id.localeCompare(b.id);
    });
  const active = markers.filter((m) => m.status === 'running');
  const out: Array<TranscriptStreamItem<T>> = [];
  let mi = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    while (mi < historical.length && historical[mi]!.createdAt < m.createdAt) {
      out.push({ kind: 'compaction', marker: historical[mi]! });
      mi += 1;
    }
    out.push({ kind: 'message', message: m, srcIndex: i });
  }
  while (mi < historical.length) {
    out.push({ kind: 'compaction', marker: historical[mi]! });
    mi += 1;
  }
  for (const marker of active) {
    out.push({ kind: 'compaction', marker });
  }
  return out;
}
