/**
 * 调度对话浮窗面板几何常量（2026-10-06 报单④）。
 *
 * 面板自左下锚点（bottom: 12px）向上展开；此前高度上限只按视口顶留 12px
 * 放行，拖大后面板顶缘会伸进顶栏（.chrome-bar，36px）——而 .agent-float 的
 * containing block .main-view 是 overflow-y:hidden，超出部分被裁掉，
 * 用户看到「面板被顶栏遮挡」。与其抬 z-index（顶栏是窗口 chrome：拖拽区、
 * 工作区菜单、全局入口都在上面，浮窗盖顶栏会吃掉这些交互；且遮挡根源是
 * 祖先裁剪而非层级，抬 z 也无效），不如直接限制面板高度不与顶栏重合
 * （全局看板同款取舍：展开态也让开 --chrome-h 顶栏）。
 */

/** 顶栏高度：与 .chrome-bar / 看板 --chrome-h 同源，改动须三处同步。 */
export const CHROME_BAR_H = 36;
/** 面板底边距视口底缘（.agent-float bottom 锚点）：展开态与左栏列底缘重合
 *  （= --frame-gap 默认值，2026-10-10 用户定稿）。改默认框距时两处同步。 */
export const PANEL_BOTTOM_INSET = 4;
/** 面板顶缘与顶栏下沿的最小间隙。 */
export const PANEL_TOP_GAP = 8;

/** 面板高度上限：视口高 − 底缘 − 顶栏 − 顶隙。持久尺寸套用与拖拽上限共用。 */
export function maxPanelHeight(viewportHeight: number): number {
  return viewportHeight - PANEL_BOTTOM_INSET - CHROME_BAR_H - PANEL_TOP_GAP;
}

/** 将缩放原点对准工作区入口，同时留在面板边缘以内。 */
export function panelOriginY(
  panel: Pick<DOMRect, 'top' | 'height'>,
  anchor?: Pick<DOMRect, 'top' | 'height'>
): string {
  if (!anchor || panel.height < 1) return '85%';
  const y = ((anchor.top + anchor.height / 2 - panel.top) / panel.height) * 100;
  return `${Math.min(96, Math.max(4, y))}%`;
}
