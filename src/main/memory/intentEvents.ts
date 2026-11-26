/**
 * 意图事件缝（memory-refactor §9 事件面，B7）：事件源（会话相位翻转/
 * 合入受阻/PR 合并）→ 本缝 → 意图事件扫描消费者（runtime 装配注册）。
 *
 * 照 taskEvents/settleNotify 的缝先例：生产方（index.ts 事件装配段 / prMergedWatch）
 * 不 import memory/runtime（其依赖链含 config/electron，会拖环），只 fire-and-forget
 * 发结构化事件；消费方在 index.ts boot 装配段 setMemoryIntentListener 注册（内部全兜
 * 底——意图扫描绝不影响业务事件流）。
 *
 * 零依赖（任何模块可安全 import）。
 */

/** 意图事件（字段与 shared/memoryCenterIpc.IntentEventPredicate 匹配面对应） */
export interface MemoryIntentEvent {
  kind: 'notify_flip' | 'merge_blocked' | 'pr_merged';
  /** 工作区根（也可由消费方按 workspaceId 反查） */
  root?: string;
  workspaceId?: string;
  /** notify_flip */
  trigger?: string;
  sessionId?: string;
  /** merge_blocked / pr_merged */
  branch?: string;
  repo?: string;
}

type Listener = (e: MemoryIntentEvent) => void;

let listener: Listener | null = null;

export function setMemoryIntentListener(fn: Listener | null): void {
  listener = fn;
}

/** 发一条意图事件（消费方未注册=丢弃；监听异常吞掉——绝不影响业务事件流） */
export function emitMemoryIntentEvent(e: MemoryIntentEvent): void {
  if (!listener) return;
  try {
    listener(e);
  } catch (err) {
    console.error('[memory-intents] 事件扫描失败（忽略）', err);
  }
}
