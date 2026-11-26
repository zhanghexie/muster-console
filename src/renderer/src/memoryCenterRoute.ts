/**
 * 记忆中心 hub 的跨组件路由（模块级小 store，needsReadStore 同模式）：
 * - 系统通知点击（ui:openPanel，决策 #9）→ App 订阅后 requestMemoryCenterTab(tab)
 *   打开面板并落到指定页签；面板未开时先开面板（App 侧），挂载后消费最新请求。
 * - nonce 递增：同页签重复请求也触发一次 effect（面板已开时精确跳页签）。
 */
import { useSyncExternalStore } from 'react';

/** 页签 id（八页签：总览首页 + 条目总览 + 用户画像独立页 + 其余五页） */
export type MemoryCenterTabId =
  | 'overview'
  | 'entries'
  | 'history'
  | 'profile'
  | 'review'
  | 'approvals'
  | 'intent'
  | 'index'
  | 'recycle';

export const MEMORY_CENTER_TABS: ReadonlyArray<{ id: MemoryCenterTabId; labelKey: string }> = [
  { id: 'overview', labelKey: '总览' },
  { id: 'entries', labelKey: '条目总览' },
  { id: 'profile', labelKey: '用户画像' },
  { id: 'review', labelKey: '晋升审阅' },
  { id: 'approvals', labelKey: '审批队列' },
  { id: 'intent', labelKey: '主动提醒' },
  { id: 'index', labelKey: '索引状态' },
  { id: 'recycle', labelKey: '回收站' }
];

/** Production center; the legacy tab catalog above is retained only for retired-format viewers. */
export const KNOWLEDGE_CENTER_TABS: ReadonlyArray<{ id: MemoryCenterTabId; labelKey: string }> = [
  { id: 'overview', labelKey: '总览' },
  { id: 'entries', labelKey: '长期知识' },
  { id: 'history', labelKey: '任务历史' },
  { id: 'intent', labelKey: '主动提醒' },
  { id: 'index', labelKey: '整理记录' }
];

type Listener = () => void;

const listeners = new Set<Listener>();

interface MemoryCenterRoute {
  tab: MemoryCenterTabId;
  nonce: number;
  /** 条目定位（条目 2B/9：晋升审阅/审阅展开体点击条目行 → 条目总览 scroll+highlight）。
   *  消费方：MemoryPanel 转交 EntriesTab（复用重复矛盾定位机制），消费后不清空——
   *  nonce 变化才触发，同条目重复点击也生效。 */
  entryId?: string;
}

let route: MemoryCenterRoute | null = null;

function emit(): void {
  for (const l of listeners) l();
}

/** 打开记忆中心并落到指定页签（App 的 ui:openPanel 订阅 / 面板内跳转共用）；
 *  opts.entryId：落到条目总览并定位高亮该条目。 */
export function requestMemoryCenterTab(tab: MemoryCenterTabId, opts?: { entryId?: string }): void {
  route = { tab, nonce: (route?.nonce ?? 0) + 1, entryId: opts?.entryId };
  emit();
}

/** 消费后仍保留最新值（快照引用稳定；面板按 nonce 变化生效） */
export function useMemoryCenterRoute(): MemoryCenterRoute | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => route
  );
}

/** 测试隔离：清路由 */
export function resetMemoryCenterRouteForTest(): void {
  route = null;
  emit();
}
