import { useEffect, type RefObject } from 'react';

/** Portal 详情卡与速览左栏共用原生指针保活，避免 React fiber 路径误判。 */
export function useSessionsPeekHover(ref: RefObject<HTMLElement | null>, active: boolean,
  onEnter: () => void, onLeave: () => void): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const preview = (target: EventTarget | null): Element | null => target instanceof Element
      ? target.closest('.session-details-card[data-session-peek-owner="true"]') : null;
    const over = (event: PointerEvent): void => {
      const card = preview(event.target);
      if (card && !(event.relatedTarget instanceof Node && card.contains(event.relatedTarget))) onEnter();
    };
    const out = (event: PointerEvent): void => {
      const card = preview(event.target);
      if (card && !(event.relatedTarget instanceof Node && (card.contains(event.relatedTarget) || root.contains(event.relatedTarget)))) onLeave();
    };
    root.addEventListener('pointerenter', onEnter);
    root.addEventListener('pointerleave', onLeave);
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    return () => {
      root.removeEventListener('pointerenter', onEnter);
      root.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
    };
  }, [ref, active, onEnter, onLeave]);
}
