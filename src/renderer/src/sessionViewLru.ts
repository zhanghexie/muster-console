/**
 * 会话视图保活 LRU（2026-10-14 性能专项，performance.md §19.4 授权落地）。
 *
 * 背景：CenterPanel 曾为 store 内每个会话常驻挂载 AgentChatView/TerminalView
 * （boot 即 ~71 个视图壳，开过重会话后 DOM 13-15k 且永不回落）。隐藏子树虽
 * 免 layout/paint，但仍参与样式失效扫描、React 调和与内存——负载态下所有
 * 挂载型操作（设置冷开/归档展开/抽屉折叠实测 60-96ms）随之单调变贵。
 *
 * 现在只保活最近访问的 SESSION_VIEW_LRU_CAP 个会话视图；「访问」= 成为中栏
 * 选中（displayActiveId）或分屏引用（显示中的会话另有渲染兜底，永不因 LRU
 * 消失）。被逐出的会话切回时重付一次首开（渐进挂载已把重会话首开摊薄到
 * 60-90ms），聊天转写的阅读位置与「加载更早」回填窗口由 ChatTranscript 的
 * 滚动记忆恢复（见 chat-transcript.md）。终端视图一期不做滚动记忆：重挂由
 * 主进程 pty buffer 重建 scrollback，视口回底。
 */

/** 保活容量：覆盖日常并发使用；池满再访问新会话才逐出最旧的一个 */
export const SESSION_VIEW_LRU_CAP = 16;

/** 尾部 = 最近访问 */
const order: string[] = [];
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const fn of listeners) fn();
}

/** 记一次访问：新面孔入池（超容量逐出最旧）；池内老面孔只移位（存活集合
 *  未变，不通知订阅方——避免每次切会话的无谓重渲） */
export function touchSessionView(id: string): void {
  const at = order.indexOf(id);
  if (at >= 0) {
    if (at === order.length - 1) return;
    order.splice(at, 1);
    order.push(id);
    return;
  }
  order.push(id);
  while (order.length > SESSION_VIEW_LRU_CAP) order.shift();
  changed();
}

/** 会话列表变化时清出已删除会话的池位（防死 id 占坑挤掉活会话容量） */
export function retainSessionViews(aliveIds: ReadonlySet<string>): void {
  const next = order.filter((id) => aliveIds.has(id));
  if (next.length === order.length) return;
  order.length = 0;
  order.push(...next);
  changed();
}

export function isSessionViewAlive(id: string): boolean {
  return order.includes(id);
}

/** CenterPanel 会话视图渲染过滤（纯函数，便于单测）：显示中的会话（中栏选中
 *  或分屏 pane 引用）恒保——LRU 永不让正在显示的视图消失；其余按池存活过滤 */
export function keptSessionViews<T extends { id: string }>(
  views: readonly T[],
  activeId: string | null,
  shownIds: ReadonlySet<string>
): T[] {
  return views.filter((v) => v.id === activeId || shownIds.has(v.id) || isSessionViewAlive(v.id));
}

/** useSyncExternalStore 接线：version 只在存活集合变化时前进 */
export function subscribeSessionViews(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getSessionViewsVersion(): number {
  return version;
}

/** 测试与诊断用 */
export function getSessionViewsDebug(): readonly string[] {
  return order;
}

/** 测试用：清空池 */
export function resetSessionViewsForTest(): void {
  order.length = 0;
  changed();
}
