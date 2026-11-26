import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { MOTION } from './motion';

type HoldPhase = 'opening' | 'charging' | 'committed';
export type CliHoldVisual = { sourceOpen: boolean; phase: HoldPhase; chargeStep?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 } | null;
type BlankPointerDown = (event: React.PointerEvent<HTMLDivElement>, remainsBlank: () => boolean) => void;

interface ActiveHold {
  pointerId: number;
  x: number;
  y: number;
  sourceOpen: boolean;
  phase: 'pending' | HoldPhase;
  timers: number[];
  remainsBlank: () => boolean;
  detach: () => void;
}

const HOLD_MOVE_TOLERANCE = 6;

/** 终端原生鼠标事件照常投递；仅在空白位置持续按住时提供可取消的预览。 */
export function useCliTerminalHold({ open, openRef, visible, onCommit, onOpenRelease, onError }: {
  open: boolean;
  openRef: React.MutableRefObject<boolean>;
  visible: boolean;
  onCommit: (next: boolean) => void;
  onOpenRelease: () => void;
  onError: (error: unknown) => void;
}): { visual: CliHoldVisual; onBlankPointerDown: BlankPointerDown } {
  const [visual, setVisual] = useState<CliHoldVisual>(null);
  const activeRef = useRef<ActiveHold | null>(null);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const commitRef = useRef(onCommit); commitRef.current = onCommit;
  const releaseRef = useRef(onOpenRelease); releaseRef.current = onOpenRelease;
  const errorRef = useRef(onError); errorRef.current = onError;

  const finish = useCallback((released: boolean, updateVisual = true): void => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    for (const timer of active.timers) window.clearTimeout(timer);
    active.detach();
    if (updateVisual) setVisual(null);
    if (released && visibleRef.current && active.phase === 'committed' && !active.sourceOpen) releaseRef.current();
  }, []);

  useEffect(() => { if (!visible) finish(false); }, [visible, finish]);
  useEffect(() => {
    const active = activeRef.current;
    if (active && active.phase !== 'committed' && open !== active.sourceOpen) finish(false);
  }, [open, finish]);
  useEffect(() => () => finish(false, false), [finish]);

  const onBlankPointerDown = useCallback<BlankPointerDown>((event, remainsBlank) => {
    if (!visibleRef.current || activeRef.current || event.pointerType !== 'mouse' || event.button !== 0 ||
        event.isPrimary === false || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const active: ActiveHold = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      sourceOpen: openRef.current, phase: 'pending', timers: [], remainsBlank, detach: () => {} };
    activeRef.current = active;
    const onMove = (next: PointerEvent): void => {
      if (next.pointerId !== active.pointerId) return;
      if ((next.buttons & 1) === 0) { finish(active.phase === 'committed'); return; }
      if (active.phase !== 'committed' && Math.hypot(next.clientX - active.x, next.clientY - active.y) > HOLD_MOVE_TOLERANCE) finish(false);
    };
    const onUp = (next: PointerEvent): void => { if (next.pointerId === active.pointerId) finish(true); };
    const onCancel = (next: PointerEvent): void => { if (next.pointerId === active.pointerId) finish(false); };
    const onOtherDown = (next: PointerEvent): void => { if (next.pointerId !== active.pointerId || next.button !== 0) finish(false); };
    const onInterrupt = (): void => finish(false);
    const onKey = (next: KeyboardEvent): void => { if (next.key === 'Escape') finish(false); };
    const onVisibility = (): void => { if (document.hidden) finish(false); };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('pointerdown', onOtherDown, true);
    window.addEventListener('wheel', onInterrupt, { capture: true, passive: true });
    window.addEventListener('blur', onInterrupt);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVisibility);
    active.detach = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('pointerdown', onOtherDown, true);
      window.removeEventListener('wheel', onInterrupt, true);
      window.removeEventListener('blur', onInterrupt);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    const valid = (): boolean => {
      if (activeRef.current !== active || !visibleRef.current || openRef.current !== active.sourceOpen) return false;
      try { return active.remainsBlank(); }
      catch (error) { errorRef.current(error); return false; }
    };
    const schedule = (fn: () => void, delay: number): void => {
      active.timers.push(window.setTimeout(fn, delay));
    };
    schedule(() => {
      if (!valid()) { finish(false); return; }
      active.phase = 'opening';
      setVisual({ sourceOpen: active.sourceOpen, phase: 'opening' });
      schedule(() => {
        if (!valid()) { finish(false); return; }
        active.phase = 'charging';
        setVisual({ sourceOpen: active.sourceOpen, phase: 'charging', chargeStep: 0 });
        // 颤动的各段依次计时，避免渲染卡顿后多个阶段一起跳过；总时长与 CSS 同步。
        const steps = [1, 2, 3, 4, 5, 6, 7] as const;
        const advanceCharge = (index: number): void => {
          schedule(() => {
            if (!valid()) { finish(false); return; }
            const step = steps[index];
            if (step === undefined) {
              active.phase = 'committed';
              commitRef.current(!active.sourceOpen);
              setVisual({ sourceOpen: active.sourceOpen, phase: 'committed' });
              return;
            }
            setVisual({ sourceOpen: active.sourceOpen, phase: 'charging', chargeStep: step });
            advanceCharge(index + 1);
          }, MOTION.breathMs / 3 / 8);
        };
        advanceCharge(0);
      }, MOTION.panelMs);
    }, MOTION.panelMs);
  }, [finish, openRef]);

  return { visual, onBlankPointerDown };
}
