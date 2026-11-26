/**
 * 自由视图画布 · 卡片实测高度读取。
 * 从 FreeCanvas.tsx 拆出的 DOM 测高纯函数（零依赖，jsdom 可直接单测）。
 */

/** 读画布上会话卡的内容高度（便签跳过）。隐藏侧 scrollHeight=0 的不写入。 */
export function readCanvasCardHeights(world: Element | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!world) return out;
  for (const el of world.querySelectorAll<HTMLElement>('[data-cnode]')) {
    if (el.getAttribute('data-fc-kind') === 'sticky') continue;
    const id = el.getAttribute('data-cnode');
    if (!id) continue;
    const card = el.querySelector<HTMLElement>('.board-card');
    const h = card?.scrollHeight || el.offsetHeight;
    if (h > 0) out[id] = h;
  }
  return out;
}
