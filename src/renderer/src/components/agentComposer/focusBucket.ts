/** 最近聚焦过的会话输入框（草稿桶 key）：定向插入（如网页元素备注）投给它，
 *  只由目标 composer 消费，不广播、不拉起调度聊天视图。
 *  模块单例：写入点只有 AgentComposer 的 onFocus，读取点在 BrowserPage 等外部模块。 */
let lastFocusedDraftBucket: string | null = null;

export function getLastFocusedDraftBucket(): string | null {
  return lastFocusedDraftBucket;
}

export function setLastFocusedDraftBucket(bucket: string | null): void {
  lastFocusedDraftBucket = bucket;
}
