export interface VisibleTranscriptAnchor {
  node: HTMLElement;
  offset: number;
}

/** Hit-test at most three visible points. Walking every message forces skipped
 * content-visibility rows to lay out, defeating both scrolling and anchoring. */
export function visibleTranscriptAnchor(root: HTMLElement): VisibleTranscriptAnchor | null {
  return visibleAnchor(root, false);
}

/** The wheel tracks the visible content block, rather than its potentially very
 * tall message wrapper: skipped Markdown siblings can settle inside that row. */
export function visibleTranscriptWitness(root: HTMLElement): VisibleTranscriptAnchor | null {
  return visibleAnchor(root, true);
}

function visibleAnchor(root: HTMLElement, content: boolean): VisibleTranscriptAnchor | null {
  const rect = root.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || typeof root.ownerDocument.elementFromPoint !== 'function') return null;
  // The reading column is centered and capped at 760px on wide transcripts.
  // A point near the scroller's left edge would hit only its empty gutter.
  const x = rect.left + rect.width / 2;
  for (const inset of [8, 24, 48]) {
    const hit = root.ownerDocument.elementFromPoint(x, rect.top + Math.min(inset, rect.height - 1));
    const message = hit?.closest<HTMLElement>('[data-mid]');
    const node = content ? hit instanceof HTMLElement ? hit : hit?.parentElement : message;
    if (message && node && root.contains(node)) return { node, offset: rect.top - node.getBoundingClientRect().top };
  }
  return null;
}

export function transcriptAnchorTop(root: HTMLElement, anchor: VisibleTranscriptAnchor): number {
  // Read the realized node first: that layout read can itself settle CV and
  // change/clamp scrollTop. Combine its rect with the resulting current top.
  const nodeTop = anchor.node.getBoundingClientRect().top, rootTop = root.getBoundingClientRect().top;
  return root.scrollTop + nodeTop - rootTop + anchor.offset;
}
