/** CSS clip owns the normal path. Only repair a real ancestor scroll event;
 * probing scroll offsets after every dock/layout update forces style/layout. */
export function guardVirtualScreenScroll(elements: readonly (HTMLElement | null)[]): () => void {
  const nodes = [...new Set(elements.filter((node): node is HTMLElement => node !== null))];
  const onScroll = (event: Event): void => {
    const node = event.currentTarget as HTMLElement;
    if (node.scrollLeft !== 0) node.scrollLeft = 0;
  };
  for (const node of nodes) node.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    for (const node of nodes) node.removeEventListener('scroll', onScroll);
  };
}
