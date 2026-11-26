import { useLayoutEffect, useRef, type RefObject } from 'react';
import { MOTION } from '../components/motion';
import { getInteractionPreferences, prefersReducedMotionPreference, subscribeInteractionPreferences } from '../interactionPreferences';
import { transcriptAnchorTop, visibleTranscriptWitness, type VisibleTranscriptAnchor } from './transcriptScrollAnchor';
import { SPRING_SCROLL, Spring } from './spring';
import { registerRevealTask } from './revealTicker';

type ScrollFeel = 'native' | 'crisp' | 'soft';
type ScrollPreferences = { scrollFeel: ScrollFeel; scrollDistance: number; motion: 'system' | 'subtle' | 'reduced' };
type ScrollTarget = number | (() => number);
type ScrollJob =
  // 显式导航：固定时长 + token 曲线（长距离只动画最后一屏，见 jumpTo）
  | { kind: 'jump'; started: number; duration: number; from: number; target: ScrollTarget }
  // 流式贴底跟随：二阶阻尼弹簧（k=320/c=40），目标每帧活测 scrollHeight-clientHeight，
  // 无截止时间——同一在途跟随只更新目标不重启；收敛即收工，内容再增长由 RO 补钉重挂
  | { kind: 'follow' }
  | { kind: 'wheel'; started: number; duration: number; wheel: { distance: number; applied: number; anchor: VisibleTranscriptAnchor | null; settlement: number } };

/** A wheel has no trustworthy device identifier. Large integral detents are an
 * opt-in heuristic; fine, rapid or decaying input yields back to the browser. */
export class DiscreteWheelDetector {
  private lastAt = -Infinity;
  private lastMagnitude = 0;
  private nativeUntil = -Infinity;

  delta(event: Pick<WheelEvent, 'deltaMode' | 'deltaY'>, now: number): number | null {
    const magnitude = Math.abs(event.deltaY);
    const gap = now - this.lastAt;
    const previous = this.lastMagnitude;
    this.lastAt = now;
    this.lastMagnitude = magnitude;
    if (event.deltaMode === 1) {
      return Number.isInteger(magnitude) && magnitude >= 1 && magnitude <= 6 ? event.deltaY * 40 : null;
    }
    if (event.deltaMode !== 0) return null;
    const detent = Number.isInteger(magnitude) && magnitude >= 80 && magnitude <= 240 && (magnitude % 40 === 0 || magnitude === 100);
    if (!detent || gap < 32 || (gap < 100 && previous !== magnitude)) {
      this.nativeUntil = now + MOTION.panelMs;
      return null;
    }
    return now < this.nativeUntil ? null : event.deltaY;
  }
}

/** Respect the existing nested scroller/overscroll chain in both directions. */
export function wheelReachesTranscript(root: HTMLElement, target: EventTarget | null, delta: number): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== root) {
    const css = getComputedStyle(node);
    if (/^(auto|scroll|overlay)$/.test(css.overflowY) && node.scrollHeight > node.clientHeight) {
      if (delta < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) return false;
      if (/^(contain|none)$/.test(css.overscrollBehaviorY)) return false;
    }
    node = node.parentElement;
  }
  return node === root;
}

/** Evaluate the app's existing easing token; no separate scroll curve is added. */
function motionEase(element: HTMLElement): (progress: number) => number {
  const token = getComputedStyle(element).getPropertyValue('--ease-standard');
  const match = /cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(token);
  // The fallback is the same --ease-standard for unstyled/SSR test surfaces.
  const [x1, y1, x2, y2] = match ? match.slice(1).map(Number) : [0.16, 1, 0.3, 1];
  const sample = (t: number, a: number, b: number): number => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  return progress => {
    let low = 0, high = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (low + high) / 2;
      if (sample(mid, x1!, x2!) < progress) low = mid; else high = mid;
    }
    return sample((low + high) / 2, y1!, y2!);
  };
}

export class TranscriptScrollController {
  private job: ScrollJob | null = null;
  private frame: number | null = null;
  private ease: ((progress: number) => number) | null = null;
  private detector = new DiscreteWheelDetector();
  /** 在途跟随弹簧（kind:'follow' 任务驱动；null=无在途跟随） */
  private spring: Spring | null = null;
  private springUnregister: (() => void) | null = null;
  /** 本帧 measure 相读到的 max(0, scrollHeight-clientHeight)（写相位统一钳制用） */
  private springMax = 0;

  constructor(private element: () => HTMLElement | null, private options: {
    preferences: () => ScrollPreferences;
    reducedMotion: () => boolean;
    active: () => boolean;
    onWrite?: (top: number, wheelDirection?: number) => void;
    onUserScroll?: (delta: number) => void;
  }) {}

  isAnimating(): boolean { return this.job !== null; }

  /** 停掉在途跟随弹簧；finish=true 时先落到语义目标（当前最新底部）再停 */
  private stopSpring(finish = false): void {
    const spring = this.spring;
    this.spring = null;
    if (this.springUnregister) {
      this.springUnregister();
      this.springUnregister = null;
    }
    if (this.job?.kind === 'follow') this.job = null;
    if (spring && finish) this.write(spring.target);
  }

  cancel(finish = false): void {
    const job = this.job;
    this.stopSpring(finish && job?.kind === 'follow');
    this.job = null;
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (finish && job) {
      if (job.kind === 'wheel') { this.moveWheel(job, job.wheel.distance - job.wheel.applied); this.moveWheel(job, 0); }
      else if (job.kind === 'jump') this.write(this.target(job.target));
      // follow 的终值已由 stopSpring(true) 写入
    }
  }

  preferencesChanged(): void {
    // Reducing motion finishes at the current semantic target, never midway.
    this.cancel(true);
  }

  private target(target: ScrollTarget): number {
    const el = this.element();
    if (!el) return 0;
    return Math.max(0, Math.min(typeof target === 'function' ? target() : target, Math.max(0, el.scrollHeight - el.clientHeight)));
  }

  private write(top: number, wheelDirection?: number): void {
    const el = this.element();
    if (!el) return;
    el.scrollTop = top;
    this.options.onWrite?.(el.scrollTop, wheelDirection);
  }

  private canAnimate(): boolean {
    return this.options.active() && !this.options.reducedMotion() && !document.hidden;
  }

  private animate(target: ScrollTarget, duration: number): void {
    const el = this.element();
    if (!el) return;
    this.cancel();
    const top = this.target(target);
    if (!this.canAnimate() || Math.abs(top - el.scrollTop) < 1) { this.write(top); return; }
    this.ease ??= motionEase(el);
    this.job = { kind: 'jump', from: el.scrollTop, target, started: performance.now(), duration };
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.frame = null;
    const job = this.job;
    if (!job) return;
    if (!this.options.active() || document.hidden) { this.cancel(); return; }
    if (this.options.reducedMotion()) { this.cancel(true); return; }
    if (job.kind === 'follow') return; // 弹簧任务自驱（revealTicker），不走本 rAF
    const progress = Math.min(1, Math.max(0, (now - job.started) / job.duration));
    if (job.kind === 'wheel') {
      this.moveWheel(job, job.wheel.distance * (progress >= 1 ? 1 : this.ease!(progress)) - job.wheel.applied);
      // Motion has a fixed deadline. At most two following frames repair the one
      // local witness if newly exposed content-visibility blocks settle late.
      if (progress >= 1 && (!job.wheel.anchor || job.wheel.settlement++ >= 2)) this.job = null;
      else this.frame = requestAnimationFrame(this.tick);
      return;
    }
    const target = this.target(job.target);
    this.write(progress >= 1 ? target : job.from + (target - job.from) * this.ease!(progress));
    if (progress >= 1) this.job = null;
    else this.frame = requestAnimationFrame(this.tick);
  };

  private wheelBase(job: Extract<ScrollJob, { kind: 'wheel' }>): number {
    const el = this.element(), wheel = job.wheel;
    if (!el) return 0;
    if (!wheel?.anchor) return el.scrollTop;
    if (!wheel.anchor.node.isConnected || !el.contains(wheel.anchor.node)) { wheel.anchor = null; return el.scrollTop; }
    // Layout movement is not wheel debt. Browser anchoring may already have
    // compensated it; then this reads the current top and performs no write.
    return transcriptAnchorTop(el, wheel.anchor);
  }

  private moveWheel(job: Extract<ScrollJob, { kind: 'wheel' }>, delta: number): void {
    const el = this.element(), wheel = job.wheel;
    if (!el || !wheel) return;
    // Clamp only the combined destination. Clamping layout repair first can
    // double-apply movement when content below the witness disappears.
    const top = this.wheelBase(job) + delta;
    if (Math.abs(top - el.scrollTop) >= 0.001) this.write(top, Math.sign(wheel.distance));
    wheel.applied += delta;
    // Use intended travel: a simultaneous CV clamp is layout displacement and
    // must be repaired independently, rather than silently paying wheel debt.
    if (wheel.anchor) wheel.anchor.offset += delta;
  }

  jumpTo(target: ScrollTarget): void {
    const el = this.element();
    if (!el || !this.options.active()) return;
    const top = this.target(target), distance = top - el.scrollTop;
    // Very long navigation shows only the final viewport of travel. There is no
    // multi-second flight through offscreen history or accumulated jump queue.
    const travel = Math.max(1, el.clientHeight);
    if (Math.abs(distance) > travel && this.canAnimate()) this.write(top - Math.sign(distance) * travel);
    this.animate(target, this.options.preferences().motion === 'subtle' ? MOTION.microMs : MOTION.exitMs);
  }

  /** 流式贴底跟随（2026-10-30 起弹簧化，native/crisp/soft 一致）：
   *  首次定位/新回合/恢复对齐传 instant=true（即时贴底，不播动画）；流式内容
   *  增长的补钉走弹簧（k=320/c=40 稍过阻尼）——目标由 ticker 的 measure 相
   *  每帧活测、无截止时间，突发大块/工具插行不再硬跳。减少动态/隐藏时即时写
   *  终值（canAnimate 门）。在途 jump（显式导航）优先；在途弹簧无需重启。 */
  followBottom(instant = false): void {
    const el = this.element();
    if (!el || !this.options.active()) return;
    if (instant || !this.canAnimate()) {
      this.cancel();
      // Assigning scrollHeight preserves the browser's immediate clamp behavior.
      this.write(el.scrollHeight);
      return;
    }
    if (this.job?.kind === 'jump') return; // a deliberate navigation owns the view
    if (this.spring) return; // 在途弹簧：measure 相每帧活测目标，无需重启
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(target - el.scrollTop) < 1) {
      this.cancel(); // 距离可忽略：直接落位，并停掉在途 wheel 等残余任务（旧 animate 路径行为）
      this.write(target);
      return;
    }
    this.cancel(); // 取代在途 wheel / 残余任务（jump 已在上方让路）
    const spring = new Spring(SPRING_SCROLL, el.scrollTop);
    spring.target = target;
    this.spring = spring;
    this.springMax = target;
    this.job = { kind: 'follow' };
    // 三相帧任务：measure 只读几何 → update 弹簧积分 → write 单一入口写 scrollTop
    this.springUnregister = registerRevealTask({
      measure: () => {
        const el = this.element();
        if (!el || !this.spring) return;
        this.springMax = Math.max(0, el.scrollHeight - el.clientHeight);
        this.spring.target = this.springMax;
      },
      update: (dt) => {
        this.spring?.update(dt);
      },
      write: () => {
        const spring = this.spring;
        const el = this.element();
        if (!spring || !el) return;
        // spring.pos 是纯 JS 状态（非 DOM 读），write 相直读不破坏三相纪律
        this.write(Math.max(0, Math.min(spring.pos, this.springMax)));
        // 收敛即收工（滚动条静止）；内容再增长由 RO/补钉触发 followBottom 重挂
        if (spring.settled) this.stopSpring(false);
      }
    });
  }

  wheel(event: WheelEvent): boolean {
    const el = this.element(), prefs = this.options.preferences();
    if (!el || !this.options.active()) return false;
    const vertical = !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey &&
      event.deltaY !== 0 && Math.abs(event.deltaX) < Math.abs(event.deltaY);
    let reaches: boolean | undefined;
    const reachesRoot = (): boolean => reaches ??= wheelReachesTranscript(el, event.target, event.deltaY);
    // Fine/downward outer scrolling also owns a jump, but zoom, horizontal input
    // and a nested scroller must not change the transcript's follow permission.
    if (this.job?.kind === 'jump' && vertical && reachesRoot()) this.options.onUserScroll?.(-1);
    const eligible = prefs.scrollFeel !== 'native' && !this.options.reducedMotion() && event.cancelable && vertical;
    const delta = eligible ? this.detector.delta(event, performance.now()) : null;
    if (delta == null || !reachesRoot()) { this.cancel(); return false; }
    if (this.job?.kind === 'wheel') this.moveWheel(this.job, 0);
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    if (delta < 0 ? el.scrollTop <= 0 : el.scrollTop >= max - 1) { this.cancel(); return false; }
    const distance = Math.max(0.5, Math.min(2, prefs.scrollDistance));
    const remaining = this.job?.kind === 'wheel' ? this.job.wheel.distance - this.job.wheel.applied : 0;
    const debt = Math.sign(remaining) === Math.sign(delta) ? remaining : 0;
    // Limit unpresented travel to a viewport, even under a burst of detents.
    const travel = Math.max(-el.scrollTop, Math.min(max - el.scrollTop,
      Math.max(-el.clientHeight, Math.min(el.clientHeight, debt + delta * distance))));
    event.preventDefault();
    this.options.onUserScroll?.(delta);
    this.cancel();
    this.ease ??= motionEase(el);
    this.job = { kind: 'wheel',
      started: performance.now(), duration: prefs.scrollFeel === 'crisp' || prefs.motion === 'subtle' ? MOTION.microMs : MOTION.exitMs,
      wheel: { distance: travel, applied: 0, anchor: visibleTranscriptWitness(el), settlement: 0 } };
    this.frame = requestAnimationFrame(this.tick);
    return true;
  }
}

/** Only the visible transcript owns input listeners. No hidden polling or RAF. */
export function useTranscriptScrollController(ref: RefObject<HTMLElement | null>, active: boolean, callbacks: {
  onWrite: (top: number, wheelDirection?: number) => void;
  onUserScroll: (delta: number) => void;
  onUserInput: () => void;
}): TranscriptScrollController {
  const current = useRef({ active, callbacks });
  current.current = { active, callbacks };
  const manualScroll = useRef<{ baseline: number } | null>(null);
  const controllerRef = useRef<TranscriptScrollController | null>(null);
  controllerRef.current ??= new TranscriptScrollController(() => ref.current, {
    preferences: getInteractionPreferences, reducedMotion: prefersReducedMotionPreference,
    active: () => current.current.active,
    onWrite: (top, wheelDirection) => {
      if (manualScroll.current) manualScroll.current.baseline = top;
      current.current.callbacks.onWrite(top, wheelDirection);
    },
    onUserScroll: delta => current.current.callbacks.onUserScroll(delta)
  });
  const controller = controllerRef.current;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) { controller.cancel(); return; }
    const wheel = (event: WheelEvent): void => {
      current.current.callbacks.onUserInput();
      controller.wheel(event);
    };
    const interrupt = (scrollIntent = false): void => {
      current.current.callbacks.onUserInput();
      if (scrollIntent) current.current.callbacks.onUserScroll(-1);
      controller.cancel();
    };
    const pointer = (): void => { manualScroll.current = { baseline: el.scrollTop }; interrupt(); };
    const pointerEnd = (): void => { manualScroll.current = null; };
    const scroll = (): void => {
      if (manualScroll.current && Math.abs(el.scrollTop - manualScroll.current.baseline) >= 1) {
        manualScroll.current = null;
        current.current.callbacks.onUserScroll(-1);
        controller.cancel();
      }
    };
    const key = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || event.isComposing || !target || !el.contains(target) ||
        target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      if (target.closest('button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="combobox"], [role="listbox"], [role="option"], [role="slider"], [role="spinbutton"]')) {
        if (event.key === ' ' || event.key === 'Enter') interrupt();
        return;
      }
      // Cancellation never prevents keyboard scrolling, selection, editing or IME.
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interrupt(true);
      else if (event.key === 'Escape') interrupt();
    };
    const visibility = (): void => {
      if (document.hidden) { current.current.callbacks.onUserInput(); controller.cancel(); }
    };
    let enhanced = getInteractionPreferences().scrollFeel !== 'native';
    const bindWheel = (): void => el.addEventListener('wheel', wheel, { passive: !enhanced });
    bindWheel();
    const unsubscribe = subscribeInteractionPreferences(() => {
      controller.preferencesChanged();
      const next = getInteractionPreferences().scrollFeel !== 'native';
      if (next !== enhanced) { el.removeEventListener('wheel', wheel); enhanced = next; bindWheel(); }
    });
    el.addEventListener('pointerdown', pointer, true);
    el.addEventListener('touchstart', pointer, { passive: true });
    el.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerup', pointerEnd, true);
    document.addEventListener('pointercancel', pointerEnd, true);
    document.addEventListener('touchend', pointerEnd, true);
    document.addEventListener('touchcancel', pointerEnd, true);
    // Bubble after component handlers so their handled arrows/Space win.
    document.addEventListener('keydown', key);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.cancel(); unsubscribe();
      el.removeEventListener('wheel', wheel);
      manualScroll.current = null;
      el.removeEventListener('pointerdown', pointer, true);
      el.removeEventListener('touchstart', pointer);
      el.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerup', pointerEnd, true);
      document.removeEventListener('pointercancel', pointerEnd, true);
      document.removeEventListener('touchend', pointerEnd, true);
      document.removeEventListener('touchcancel', pointerEnd, true);
      document.removeEventListener('keydown', key);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [active, controller, ref]);
  return controller;
}
