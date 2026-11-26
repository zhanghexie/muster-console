/**
 * 露条态手势信号（模块级单 handler；模式同 browserNav）。
 *
 * iframe / webview 会吞掉宿主指针事件：露条态（可见但不聚焦）由覆盖层截获指针，
 * move=驻留 dwell 切屏、down=点击切页，转入 App 的 usePageActivation 同一切屏入口。
 * 目标屏按覆盖层自身所在的 DOM 解析，覆盖层不需要知道自己位于哪一屏。
 */
export type PeekPage = 'terminal' | 'git';
/** 虚拟屏页根标记：切屏一律按 DOM 归属判定（内容可能经 portal 渲染在另一屏） */
export const H_PAGE_ATTR = 'data-h-page';

export function hPageOf(node: EventTarget | null): PeekPage | null {
  const page = node instanceof Element ? node.closest(`[${H_PAGE_ATTR}]`)?.getAttribute(H_PAGE_ATTR) : null;
  return page === 'terminal' || page === 'git' ? page : null;
}
export type PeekPointerFn = (type: 'move' | 'down', page: PeekPage) => void;

let handler: PeekPointerFn | null = null;

export function setPeekPointerHandler(fn: PeekPointerFn | null): void {
  handler = fn;
}

export function dispatchPeekPointer(type: 'move' | 'down', from: Element): void {
  const page = hPageOf(from);
  if (page) handler?.(type, page);
}
