import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MOTION, usePresenceValue } from './motion';

const SHOW_DELAY_HOVER = 350;
const SHOW_DELAY_FOCUS = 80;
/** 热身窗口：提示刚因移出而隐藏后，这段时间内悬停到新目标 0 延迟、无入场过渡直接出现 */
const WARM_WINDOW_MS = 300;
const GAP = 6;
const MARGIN = 8;

type TipState = {
  text: string;
  left: number;
  top: number;
  stage: 'pending' | 'shown';
  /** 热身命中：跳过入场过渡（is-instant） */
  instant: boolean;
  /** Native customizable select options live above ordinary document portals. */
  topLayer?: boolean;
};

/**
 * 全局 Tooltip 宿主：全应用挂载一次，接管所有 [title] 属性——
 * 悬停时摘掉 title（原生浏览器气泡不再触发）改由主题化浮层展示，移出后归还属性。
 * 文本支持 \n 多行（pre-line）；hover 350ms / 键盘聚焦 80ms 延迟；点击/滚动/右键/Esc 即隐。
 * 移出后退场淡出（退场期保留最后一份内容）；热身窗口内扫过相邻按钮免延迟、免入场。
 * 扩展面板 iframe 是 guest 侧，内部提示不受宿主管控（保持原生行为）。
 */
export function TooltipHost(): React.JSX.Element | null {
  const [tip, setTip] = useState<TipState | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const targetRef = useRef<Element | null>(null);
  /** 悬停期间被摘掉的 title，归还用 */
  const stolenTitles = useRef(new WeakMap<Element, string>());
  const { presence, value: shownTip } = usePresenceValue(tip, MOTION.microMs);
  const liveTipRef = useRef<TipState | null>(null);
  liveTipRef.current = tip;
  const warmUntilRef = useRef(0);

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const restoreTitle = (el: Element): void => {
    const t = stolenTitles.current.get(el);
    if (t !== undefined) {
      stolenTitles.current.delete(el);
      // React 可能在悬停期间重灌了新值；只还空缺，不覆盖新值
      if (!el.hasAttribute('title')) el.setAttribute('title', t);
    }
  };

  /** warm：因指针移出而隐藏（扫按钮）才开热身窗口；点击/滚动/拖拽等打断不开 */
  const hide = (warm = false, keepTitleSuppressed = false): void => {
    clearTimer();
    if (!keepTitleSuppressed && targetRef.current) {
      restoreTitle(targetRef.current);
      targetRef.current = null;
    }
    if (warm && liveTipRef.current?.stage === 'shown') {
      warmUntilRef.current = Date.now() + WARM_WINDOW_MS;
    } else if (!warm) {
      warmUntilRef.current = 0;
    }
    setTip(null);
  };

  /** 摘 title 并返回文本；已摘过则返回记录值 */
  const suppress = (el: Element): string => {
    const existing = stolenTitles.current.get(el);
    if (existing !== undefined) return existing;
    const t = el.getAttribute('title') ?? '';
    if (t) {
      stolenTitles.current.set(el, t);
      el.removeAttribute('title');
    }
    return t;
  };

  const schedule = (el: Element, text: string, delay: number): void => {
    targetRef.current = el;
    const topLayer = !!el.closest('select.c-select-native, [popover]') && typeof HTMLElement.prototype.showPopover === 'function';
    if (Date.now() < warmUntilRef.current) {
      setTip({ text, left: 0, top: 0, stage: 'pending', instant: true, topLayer });
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setTip({ text, left: 0, top: 0, stage: 'pending', instant: false, topLayer });
    }, delay);
  };

  const track = (el: Element, text: string, delay: number): void => {
    clearTimer();
    const prev = targetRef.current;
    // 切到嵌套在旧宿主内的内层目标（看板卡 → 快捷按钮）时不要归还外层 title：
    // 指针仍在外层内，归还会让原生提示沿祖先链找到外层 title，与主题化内层提示同屏
    if (prev && prev !== el && !prev.contains(el)) restoreTitle(prev);
    schedule(el, text, delay);
  };

  useEffect(() => {
    const onOver = (e: MouseEvent): void => {
      const t = e.target as Element | null;
      if (!t || typeof t.closest !== 'function') return;
      // 按住拖拽中不出提示
      if (e.buttons) {
        hide();
        return;
      }
      const cur = targetRef.current;
      // 同一宿主内部移动：先看落点是否在内层带 title 的子元素上（如轨迹泳道
      // 行提示嵌段提示）——内层优先接管；否则 React 可能重灌了宿主 title，压回去保活
      if (cur && cur !== t && cur.contains(t)) {
        const inner = t.closest('[title]');
        if (inner && inner !== cur) {
          const innerText = suppress(inner);
          if (innerText.trim()) {
            track(inner, innerText, SHOW_DELAY_HOVER);
            return;
          }
        }
        if (cur.hasAttribute('title')) suppress(cur);
        return;
      }
      const el = t.closest('[title]');
      if (!el || el === cur) return;
      const text = suppress(el);
      if (!text.trim()) {
        hide();
        return;
      }
      track(el, text, SHOW_DELAY_HOVER);
    };

    const onOut = (e: MouseEvent): void => {
      const cur = targetRef.current;
      if (!cur) return;
      const rel = e.relatedTarget as Element | null;
      if (rel && typeof rel.contains === 'function' && cur.contains(rel)) return;
      const t = e.target as Element | null;
      if (t && (t === cur || cur.contains(t))) hide(true);
    };

    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target as Element | null;
      if (!t || typeof t.closest !== 'function') return;
      if (targetRef.current) return; // 鼠标已在同一目标上时不重复调度
      const el = t.closest('[title]');
      if (!el) return;
      const text = suppress(el);
      if (!text.trim()) return;
      track(el, text, SHOW_DELAY_FOCUS);
    };

    const onFocusOut = (): void => {
      if (targetRef.current) hide();
    };

    const onBlock = (): void => hide();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229 && targetRef.current) {
        // 保留当前 title 接管直到移出，避免原生气泡在指针不动时补弹。
        hide(false, true);
      }
    };

    window.addEventListener('mouseover', onOver, true);
    window.addEventListener('mouseout', onOut, true);
    window.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('mousedown', onBlock, true);
    window.addEventListener('wheel', onBlock, { capture: true, passive: true });
    window.addEventListener('scroll', onBlock, true);
    window.addEventListener('contextmenu', onBlock, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mouseover', onOver, true);
      window.removeEventListener('mouseout', onOut, true);
      window.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('focusout', onFocusOut, true);
      window.removeEventListener('mousedown', onBlock, true);
      window.removeEventListener('wheel', onBlock, true);
      window.removeEventListener('scroll', onBlock, true);
      window.removeEventListener('contextmenu', onBlock, true);
      window.removeEventListener('keydown', onKeyDown, true);
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const element = tipRef.current;
    if (shownTip?.topLayer && element && !element.matches(':popover-open')) element.showPopover();
  }, [shownTip?.topLayer, presence.mounted]);

  // 统一优先上下，避免提示覆盖工具栏同排按钮：上方能放就放上方，否则尝试下方；
  // 上下都放不下才贴左右两侧（左半弹右、右半弹左，首选侧放不下翻另一侧）；
  // 四周都放不下时下方兜底；最后整体夹回视口；pending 阶段先量尺寸
  useLayoutEffect(() => {
    if (!tip || tip.stage !== 'pending') return;
    const el = targetRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // mp-pop 入场/退场反转期间带 scale；定位必须用未变换的布局尺寸，
    // 否则动画结束后提示变大，会吞掉间距与视口安全边距。
    const w = tipRef.current?.offsetWidth ?? 0;
    const h = tipRef.current?.offsetHeight ?? 0;
    const fitsRight = rect.right + GAP + w <= window.innerWidth - MARGIN;
    const fitsLeft = rect.left - GAP - w >= MARGIN;
    const fitsBelow = rect.bottom + GAP + h <= window.innerHeight - MARGIN;
    const fitsAbove = rect.top - GAP - h >= MARGIN;
    const centerX = rect.left + rect.width / 2;
    let left: number;
    let top: number;
    if (fitsAbove) {
      left = centerX - w / 2;
      top = rect.top - GAP - h;
    } else if (fitsBelow) {
      left = centerX - w / 2;
      top = rect.bottom + GAP;
    } else if (fitsLeft || fitsRight) {
      const preferRight = centerX <= window.innerWidth / 2;
      const right = preferRight ? fitsRight || !fitsLeft : !fitsLeft && fitsRight;
      left = right ? rect.right + GAP : rect.left - GAP - w;
      top = rect.top + rect.height / 2 - h / 2;
    } else {
      left = centerX - w / 2;
      top = rect.bottom + GAP;
    }
    if (left < MARGIN) left = MARGIN;
    if (left + w > window.innerWidth - MARGIN) left = window.innerWidth - w - MARGIN;
    if (top < MARGIN) top = MARGIN;
    if (top + h > window.innerHeight - MARGIN) top = window.innerHeight - h - MARGIN;
    setTip({ ...tip, left: Math.round(left), top: Math.round(top), stage: 'shown' });
  }, [tip]);

  if (!shownTip) return null;

  return createPortal(
    <div
      ref={tipRef}
      {...(shownTip.topLayer ? { popover: 'manual' as const } : {})}
      className={`app-tooltip mp-pop${tip?.instant ? ' is-instant' : ''}`}
      data-mp-stage={presence.stage}
      role="tooltip"
      aria-hidden={tip ? undefined : true}
      style={{
        margin: shownTip.topLayer ? 0 : undefined,
        inset: shownTip.topLayer ? 'auto' : undefined,
        left: shownTip.left,
        top: shownTip.top,
        visibility: shownTip.stage === 'pending' ? 'hidden' : undefined
      }}
    >
      {shownTip.text}
    </div>,
    document.body
  );
}
