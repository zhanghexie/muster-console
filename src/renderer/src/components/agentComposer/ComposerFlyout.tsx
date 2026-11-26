import React, { useLayoutEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export interface ComposerFlyoutAnchor { ref: RefObject<HTMLElement>; name: string }

/** Float editor suggestions and toolbar panels above their individual anchors. */
export function ComposerFlyout({ anchor: { ref, name }, variant = 'suggestions', popupRef, children }: {
  anchor: ComposerFlyoutAnchor;
  popupRef?: RefObject<HTMLDivElement>;
  variant?: 'suggestions' | 'actions' | 'permissions' | 'harness';
  children: React.ReactNode;
}): React.JSX.Element {
  const ownRef = useRef<HTMLDivElement>(null);
  const panel = popupRef ?? ownRef;
  useLayoutEffect(() => {
    const el = panel.current;
    const trigger = ref.current;
    if (!el || !trigger) return;
    // The model picker shares the chat model menu's document layer so validation tips can appear above it.
    if (variant !== 'harness' && typeof el.showPopover === 'function') {
      el.setAttribute('popover', 'manual');
      if (!el.matches(':popover-open')) el.showPopover();
    }
    if (typeof CSS !== 'undefined' && CSS.supports('position-area: block-start span-inline-end') && CSS.supports('width: anchor-size(width)')) {
      el.style.setProperty('position-anchor', name);
      return;
    }
    const place = (): void => {
      const box = trigger.getBoundingClientRect();
      const sizes = { suggestions: [Math.min(480, box.width), 260], actions: [260, 260], permissions: [240, 420], harness: [520, 440] };
      const [preferredWidth, preferredHeight] = sizes[variant];
      const width = Math.max(0, Math.min(preferredWidth, window.innerWidth - 16));
      const above = Math.max(0, box.top - 12);
      const alignedLeft = variant === 'harness' ? box.right - width : box.left;
      const left = Math.max(8, Math.min(alignedLeft, window.innerWidth - width - 8));
      Object.assign(el.style, {
        width: `${width}px`,
        left: `${left}px`,
        bottom: `${window.innerHeight - box.top + 4}px`,
        maxHeight: `${Math.min(preferredHeight, above)}px`
      });
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(trigger);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [ref, variant, name, panel]);
  return createPortal(<div ref={panel} data-overlay-root="" data-select-portal="" data-flyout={variant} className="task-composer-flyout">
    {children}
  </div>, document.body);
}
