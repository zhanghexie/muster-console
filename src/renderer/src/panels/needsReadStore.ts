/**
 * 工作会话已读记录（沿用「需要你」存储键与 API，兼容既有落盘数据）。
 * 语义：跳转到会话页即视为已读——渲染层一律走 `jumpToSession`（先标已读再 select）；
 * 主进程来源（系统 toast / sessions.select）发 `sessions:reveal`，
 * 由 StoreProvider 的 `subscribeRevealNeedsRead` 兜底，不挂在 App 其它回调的 effect 上。
 * 已读影响提醒面（探出条 / 底栏轮播只展示未读）以及看板卡片/画布节点的未读强调。
 * 左栏工作会话胶囊在已读后隐藏，标记未读后恢复；不改看板列归属。
 * 新状态或（重新）进入需要你区会清掉已读，重新展示胶囊与相应提醒。
 *
 * 已读集合落 localStorage（`muster.needs-read.v1`），跨重启保留；变更时同步写。
 * 启动探出仍靠 GlobalBoard 的 `suppressed` 门闩（启动存量不探出），与已读是否落盘无关。
 */
import { useSyncExternalStore } from 'react';

type Listener = () => void;

/** 已读会话 id 集合（JSON 数组）。惯例同 quick-phrases.v1 / tosend 桶。 */
export const NEEDS_READ_STORAGE_KEY = 'muster.needs-read.v1';

const listeners = new Set<Listener>();

function parseReadIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return new Set();
    const next = new Set<string>();
    for (const id of v) {
      if (typeof id === 'string' && id.length > 0) next.add(id);
    }
    return next;
  } catch {
    return new Set();
  }
}

function loadReadIds(): Set<string> {
  try {
    return parseReadIds(localStorage.getItem(NEEDS_READ_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

function persistReadIds(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(NEEDS_READ_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* 配额满 / 隐私模式：已读是锦上添花，静默放弃本次写盘 */
  }
}

/** 已读工作会话 id；由全局看板修剪已删除会话，保留非需要你状态的阅读记录。 */
let readIds: ReadonlySet<string> = loadReadIds();

function emit(): void {
  for (const l of listeners) l();
}

function commit(next: ReadonlySet<string>): void {
  readIds = next;
  persistReadIds(next);
  emit();
}

/** 标记已读（跳转会话页时调用）；无新 id 不触发通知 */
export function markNeedsRead(ids: Iterable<string> | string): void {
  const next = new Set(readIds);
  let changed = false;
  for (const id of typeof ids === 'string' ? [ids] : ids) {
    if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  commit(next);
}

/** 新边沿：会话（重新）进入需要你 → 清掉已读，重新提醒 */
export function markNeedsUnread(ids: Iterable<string>): void {
  const next = new Set(readIds);
  let changed = false;
  for (const id of ids) {
    if (next.delete(id)) changed = true;
  }
  if (!changed) return;
  commit(next);
}

/** 修剪：只保留仍在传入会话集合里的已读项。 */
export function retainNeedsRead(needsIds: Iterable<string>): void {
  const keep = needsIds instanceof Set ? needsIds : new Set(needsIds);
  const next = new Set<string>();
  let changed = false;
  for (const id of readIds) {
    if (keep.has(id)) next.add(id);
    else changed = true;
  }
  if (!changed) return;
  commit(next);
}

export function isNeedsRead(id: string): boolean {
  return readIds.has(id);
}

/**
 * 模拟进程重启：丢内存、从 localStorage 再读入。
 * 仅测试用——生产路径只在模块加载时读一次。
 */
export function hydrateNeedsReadFromStorage(): void {
  readIds = loadReadIds();
  emit();
}

/** 测试隔离：清盘 + 清内存 */
export function resetNeedsReadForTest(): void {
  try {
    localStorage.removeItem(NEEDS_READ_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  readIds = new Set();
  emit();
}

/** 订阅已读集合（快照按引用比较，仅在集合变化时重渲） */
export function useNeedsRead(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => readIds
  );
}
