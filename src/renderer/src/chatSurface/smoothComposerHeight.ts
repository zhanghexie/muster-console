/**
 * 输入条高度弹簧（2026-10-31）：composer 是盖在转写上的悬浮层（bottom:0、绝对定位），
 * 高度变化（多行输入/附件条/排队面板/建议胶囊）此前瞬时生效——输入条与
 * --composer-overlay-h 驱动的转写让位（padding/跳底按钮）一起硬切。
 * 现改为二阶阻尼弹簧（k=320/c=40，同滚动跟随档）：
 * - 内容子元素高度在 ticker 的 measure 相读取（只读），弹簧 update 相推进，
 *   write 相写 wrap 显式 height；wrap 为 flex-end 底锚 + 溢出可见（不裁剪：
 *   qip/菜单等向上弹的绝对定位浮层不受影响），增长瞬间的溢出落在转写让位
 *   同弹簧释放的区域上。
 * - 既有 wrap RO → syncChatSurfaceLayout 把弹簧高度逐帧写进 --composer-overlay-h
 *   （转写 padding 与跳底按钮让位同弹簧联动）——会话内容平滑移动。
 * - 首次测量、重显与建议回复轮次变化时 snap（开屏不播动画）；减少动态不接管（height 保持 auto）；
 *   弹簧收敛即注销 ticker 任务（rAF 不空转）；隐藏/卸载即停并还原 height。
 * - 输入壳内容变化时在 measure 相重新装定锚点。
 */
import { useLayoutEffect, useSyncExternalStore, type RefObject } from 'react';
import { prefersReducedMotionPreference, subscribeInteractionPreferences } from '../interactionPreferences';
import { SPRING_SCROLL, Spring } from './spring';
import { registerRevealTask, type RevealTickerTask } from './revealTicker';

type Checkable = Element & { checkVisibility?: () => boolean };

export function useSmoothComposerHeight(wrapRef: RefObject<HTMLElement | null>, active = true, suggestionId?: string): void {
  const reduced = useSyncExternalStore(
    subscribeInteractionPreferences,
    prefersReducedMotionPreference
  );
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || reduced || !active) return;
    /** 底 padding（--composer-dock-inset / 移动端 safe-area）经计算样式装定 */
    const readPadBottom = (): number =>
      Math.max(0, Number.parseFloat(getComputedStyle(wrap).paddingBottom) || 0);
    let content = wrap.firstElementChild instanceof HTMLElement ? wrap.firstElementChild : null;
    let padBottom = readPadBottom();
    if (!content) return;
    const spring = new Spring(SPRING_SCROLL, content.offsetHeight + padBottom);
    let natural = spring.pos;
    let applied: number | null = null;
    const apply = (v: number): void => {
      const h = Math.max(0, Math.round(v));
      if (applied === h) return;
      applied = h;
      wrap.style.height = `${h}px`;
    };
    apply(spring.pos);
    const ro = new ResizeObserver(() => {
      if (!unsub) unsub = registerRevealTask(task); // 内容尺寸变化→起弹簧任务（收敛即停）
    });
    ro.observe(content);
    let visibleNow = true;
    let unsub: (() => void) | null = null;
    const task: RevealTickerTask = {
      measure: () => {
        if (!wrap.isConnected) return;
        // 输入壳内容变化：换锚重装定
        const next = wrap.firstElementChild;
        if (next instanceof HTMLElement && next !== content) {
          ro.disconnect();
          content = next;
          padBottom = readPadBottom();
          ro.observe(content);
        }
        visibleNow = !document.hidden && !!content &&
          (typeof (content as Checkable).checkVisibility === 'function'
            ? (content as Checkable).checkVisibility!()
            : true);
        if (content) natural = content.offsetHeight + padBottom;
      },
      update: (dt) => {
        if (!visibleNow || !wrap.isConnected) return; // 隐藏期暂停（重显由 RO 唤醒继续）
        spring.target = natural;
        spring.update(dt);
        apply(spring.pos);
        if (spring.settled && unsub) {
          unsub();
          unsub = null; // 收敛即收工：rAF 不空转；内容再变由 RO 重新起任务
        }
      }
    };
    return () => {
      ro.disconnect();
      unsub?.();
      wrap.style.removeProperty('height');
    };
  }, [reduced, wrapRef, active, suggestionId]);
}
