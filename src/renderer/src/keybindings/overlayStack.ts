/** 弹出层 LIFO：Esc（overlay.close）只关最顶一层。
 *  同时是 portal 浮层的点外判定合同：浮层根挂 `data-overlay-root`，
 *  面板点外关闭用 `isInsideOverlay` 认「在浮层内」，禁止按类名特判某一浮条。 */

export type OverlayClose = () => void;

/** portal 浮层根标记。划词条 / 爆炸遮罩 / 确认框等挂上后，点外判定一律走 isInsideOverlay。 */
export const OVERLAY_ROOT_ATTR = 'data-overlay-root';

type OverlayEntry = { id: number; close: OverlayClose };

let nextId = 1;
const stack: OverlayEntry[] = [];

export function pushOverlay(close: OverlayClose): number {
  const id = nextId++;
  stack.push({ id, close });
  return id;
}

export function popOverlay(id: number): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i >= 0) stack.splice(i, 1);
}

/** 关最顶一层。无层时返回 false（让 Esc 继续走查找条等控件内处理）。 */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function overlayDepth(): number {
  return stack.length;
}

export function getSetupInteractionLock(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-setup-lock="true"]');
}

/** 单测隔离：卸掉残留层，避免用例之间串栈。 */
export function resetOverlayStackForTest(): void {
  stack.length = 0;
}

/** 点落在任一已标记的 portal 浮层内 → 不算「点外面」。 */
export function isInsideOverlay(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  return target instanceof Element && !!target.closest(`[${OVERLAY_ROOT_ATTR}]`);
}
