import { useLayoutEffect, useRef } from 'react';

export function useScrollEdges() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.dataset.fadeTop = String(el.scrollTop > 1);
      el.dataset.fadeBottom = String(el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    };
    const resize = new ResizeObserver(update);
    const observe = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of el.children) resize.observe(child);
      update();
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(el, { childList: true, subtree: true });
    el.addEventListener('scroll', update, { passive: true });
    observe();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, []);
  return ref;
}
