/**
 * delta 合批器（两表面共用配方）：增量先入队，rAF（50ms 定时器兜底）合成一次 apply——
 * 同一消息的多个 token 拼一轮落地，流式输出不再每 token 触发全量消息重渲。
 * 聚合逻辑（队列 → 单次写入）由适配器提供：协议不同（扁平 content vs parts 下标），
 * 但节奏控制只此一份。
 */
export interface RafBatcherOptions<T> {
  /** 同步清空队列并应用（必须在收到会整体替换消息的事件前调用，避免旧 token 覆盖新状态） */
  apply: (queue: T[]) => void;
}

export interface RafBatcher<T> {
  enqueue(item: T): void;
  /** 同步排干队列（sync/历史整体替换、切会话、清空前调用） */
  flush(): void;
  /** 丢弃未 flush 的增量并清定时器（卸载时调用） */
  dispose(): void;
}

export function createRafBatcher<T>(opts: RafBatcherOptions<T>): RafBatcher<T> {
  let queue: T[] = [];
  let rafId: number | null = null;
  let timerId: number | null = null;

  const flush = (): void => {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (timerId != null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    opts.apply(batch);
  };

  return {
    enqueue(item: T): void {
      queue.push(item);
      if (rafId != null || timerId != null) return;
      // rAF 对齐渲染帧；50ms 定时器兜底上限，rAF 被节流时也不积压
      rafId = requestAnimationFrame(() => {
        rafId = null;
        flush();
      });
      timerId = window.setTimeout(() => {
        timerId = null;
        flush();
      }, 50);
    },
    flush,
    dispose(): void {
      queue = [];
      if (rafId != null) cancelAnimationFrame(rafId);
      if (timerId != null) window.clearTimeout(timerId);
      rafId = null;
      timerId = null;
    }
  };
}
