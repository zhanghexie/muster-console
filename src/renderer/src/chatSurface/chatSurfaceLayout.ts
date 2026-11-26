/** Layout-space measurements, unaffected by the float panel's entry scale.
 * Both the first transcript pin and the composer's ResizeObserver use this so
 * the first pin never uses the CSS fallback height before the real overlay. */
export function syncChatSurfaceLayout(root: HTMLElement | null): void {
  const wrap = root?.querySelector<HTMLElement>('.agent-chat-composer-wrap');
  if (!root || !wrap) return;
  const height = `${wrap.offsetHeight}px`;
  if (root.style.getPropertyValue('--composer-overlay-h') !== height) {
    root.style.setProperty('--composer-overlay-h', height);
  }
  const list = root.querySelector<HTMLElement>('.chat-list');
  if (list && list.offsetWidth > 0) {
    const scrollbar = `${list.offsetWidth - list.clientWidth}px`;
    if (root.style.getPropertyValue('--chat-sb') !== scrollbar) {
      root.style.setProperty('--chat-sb', scrollbar);
    }
  }
}
