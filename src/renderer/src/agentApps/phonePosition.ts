import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

const RATIO = 806 / 1480;
type Anchor = Pick<DOMRect, 'top' | 'right' | 'left' | 'bottom'>;
/** Float only the handset over the scheduler; never create a second opaque panel. */
export function phonePosition(anchor: Anchor | undefined, viewport: { width: number; height: number }) {
  const gap = 12;
  const width = Math.min(310, viewport.width - gap * 2, (viewport.height - gap * 2) * RATIO);
  const height = width / RATIO;
  const centerX = anchor ? (anchor.left + anchor.right) / 2 : viewport.width / 2;
  const centerY = anchor ? (anchor.top + anchor.bottom) / 2 : viewport.height / 2;
  const left = centerX - width / 2, top = centerY - height / 2;
  return { left: Math.max(gap, Math.min(left, viewport.width - width - gap)), top: Math.max(gap, Math.min(top, viewport.height - height - gap)), width, height };
}

export function usePhonePosition(mounted: boolean, anchor?: RefObject<HTMLElement | null>, anchorReady = true): CSSProperties {
  const [position, setPosition] = useState(() => phonePosition(undefined, { width: window.innerWidth, height: window.innerHeight }));
  useLayoutEffect(() => {
    if (!mounted) return;
    const panel = anchor?.current;
    const measure = () => {
      const next = phonePosition(panel?.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
      setPosition(old => old.left === next.left && old.top === next.top && old.width === next.width && old.height === next.height ? old : next);
    };
    measure();
    const observer = panel ? new ResizeObserver(measure) : undefined;
    if (panel) observer?.observe(panel);
    panel?.addEventListener('transitionend', measure);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); panel?.removeEventListener('transitionend', measure); window.removeEventListener('resize', measure); };
  }, [mounted, anchor, anchorReady]);
  return { ...position, '--ap-scale': position.width / 356 } as CSSProperties;
}
