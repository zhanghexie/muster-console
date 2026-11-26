import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { H_PAGE_ATTR } from '../browserPointer';

const PAGE = `[${H_PAGE_ATTR}]`;

export type PageOverlayAnchor = Element | RefObject<Element | null> | null;

export function pageForOverlay(anchor: Element | null): Element | null {
  // Docked content can live on the opposite page from its React parent.
  const page = anchor?.closest(PAGE);
  if (page) return page;
  // The scheduler chat runs beside the two page roots and moves with the left page.
  return anchor?.closest('.agent-float-panel')?.closest('.h-strip')
    ?.querySelector(`:scope > [${H_PAGE_ATTR}="terminal"]`) ?? null;
}

function anchorElement(anchor: PageOverlayAnchor): Element | null {
  return anchor && 'current' in anchor ? anchor.current : anchor;
}

export function stripOverlayHost(anchor: PageOverlayAnchor): HTMLElement {
  return pageForOverlay(anchorElement(anchor))?.closest<HTMLElement>('.h-strip') ?? document.body;
}

/** Measure when placing, then let the strip carry the viewport-clamped overlay. */
export function overlayViewportOrigin(host: HTMLElement): { left: number; top: number } {
  return host === document.body ? { left: 0, top: 0 } : host.getBoundingClientRect();
}

export function isOverlayPageSwitch(anchor: PageOverlayAnchor, target: EventTarget | null): boolean {
  const source = pageForOverlay(anchorElement(anchor));
  const destination = target instanceof Element ? pageForOverlay(target) : null;
  return !!source && source !== destination && !!destination?.hasAttribute('data-h-peek');
}

function useObservePagePeek(active: boolean, anchor: PageOverlayAnchor, onChange: (peek: boolean) => void): void {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useLayoutEffect(() => {
    if (!active) return;
    const page = pageForOverlay(anchorElement(anchor));
    changeRef.current(page?.hasAttribute('data-h-peek') ?? false);
    if (!page) return;
    const observer = new MutationObserver(() => changeRef.current(page.hasAttribute('data-h-peek')));
    observer.observe(page, { attributes: true, attributeFilter: ['data-h-peek'] });
    return () => observer.disconnect();
  }, [active, anchor]);
}

/** Only an open overlay watches its own page. Focus stays with the new surface. */
export function useDismissOnPagePeek(open: boolean, anchor: PageOverlayAnchor, dismiss: () => void): void {
  useObservePagePeek(open, anchor, peek => { if (peek) dismiss(); });
}

/** Keep the editor mounted so temporary page switches preserve its draft. */
export function usePagePeek(anchor: PageOverlayAnchor): boolean {
  const [peek, setPeek] = useState(false);
  useObservePagePeek(true, anchor, setPeek);
  return peek;
}
