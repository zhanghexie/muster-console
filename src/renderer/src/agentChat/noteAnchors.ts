/**
 * 批注高亮锚点的 DOM 操作（消息正文/文件预览里包住被批注选区的 span）。
 * 消息子树被 ChatMessageView memo 保护、回合结束后内容不变，手工 span 可稳定存活；
 * React 若重清了它，用户重新批注即可（不做后台重建，避免每渲染全文扫描）。
 *
 * 包裹铁律：**绝不移动块级元素**。跨块选区若用 extractContents 把 React 渲染的
 * 段落搬进 span，之后的任何重渲 React 会按 vdom 重排/回收这些「失踪」的节点，
 * 表现为原文被删——只能逐文本节点包裹相交片段，块结构零变动。
 */

export const PENDING_NOTE_ID = '__note_pending__';

function makeAnchorSpan(id: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'msg-note-anchor is-pending';
  span.setAttribute('data-note-id', id);
  return span;
}

/**
 * 用 span 包住选区；返回文档序第一个锚点 span（定位气泡用）。
 * - 单块内选区：一次 surroundContents 包住，返回该 span；
 * - 跨块/跨行内元素选区：逐文本节点包裹相交片段（可能产生多个同 id 的 span，
 *   转正/摘除按 id 全量处理）；一个文本节点都没包上时返回 null。
 * 所有产物都带 is-pending 态，转正用 promoteNoteAnchor 回填真实 id。
 */
export function wrapNoteAnchor(range: Range, id: string): HTMLElement | null {
  const first = (() => {
    try {
      const span = makeAnchorSpan(id);
      range.surroundContents(span);
      return span;
    } catch {
      // 跨块/部分包含：surroundContents 不支持，走逐文本节点包裹
      return null;
    }
  })();
  if (first) return first;

  const root = range.commonAncestorContainer;
  const walkRoot =
    root.nodeType === Node.TEXT_NODE ? root.parentNode : (root as Element | null);
  if (!walkRoot) return null;

  const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const tn = n as Text;
    if (!tn.length) continue;
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(tn);
    // 节点整体在选区前（node 末 ≤ 选区起）/选区后（node 首 ≥ 选区末）→ 跳过；
    // 边界相触也算在外，避免过度包裹。注意 compareBoundaryPoints 的符号是
    // sourceRange 的点相对 Range 的点（实测 Chromium 如此，MDN 表述有歧义）：
    // START_TO_END 的值 = node 末相对选区起、END_TO_START 的值 = node 首相对选区末
    if (range.compareBoundaryPoints(Range.START_TO_END, nodeRange) <= 0) continue;
    if (range.compareBoundaryPoints(Range.END_TO_START, nodeRange) >= 0) continue;
    targets.push(tn);
  }

  let firstSpan: HTMLElement | null = null;
  for (const tn of targets) {
    const s = range.startContainer === tn ? range.startOffset : 0;
    const e = range.endContainer === tn ? range.endOffset : tn.length;
    if (e <= s) continue;
    const span = makeAnchorSpan(id);
    const seg = document.createRange();
    seg.setStart(tn, s);
    seg.setEnd(tn, e);
    try {
      seg.surroundContents(span); // 纯文本节点片段，恒可用
    } catch {
      continue;
    }
    firstSpan = firstSpan ?? span;
  }
  return firstSpan;
}

/** 待定锚点转正（批注确认后回填真实 id；同 id 的全部片段一并转正） */
export function promoteNoteAnchor(pendingKey: string, id: string): void {
  const nodes = document.querySelectorAll<HTMLElement>(
    `.msg-note-anchor[data-note-id="${pendingKey}"]`
  );
  for (const el of Array.from(nodes)) {
    el.setAttribute('data-note-id', id);
    el.classList.remove('is-pending');
  }
}

/** 摘掉某条批注（或待定锚点）的包裹，还原原文并合并相邻文本节点 */
export function unwrapNoteAnchor(id: string): void {
  const nodes = document.querySelectorAll<HTMLElement>(
    `.msg-note-anchor[data-note-id="${id}"]`
  );
  for (const el of Array.from(nodes)) {
    const parent = el.parentNode;
    if (!parent) continue;
    // 文件批注（预览态）的计数角标是 anchor 的子元素：先摘掉，别跟着还原回正文
    el.querySelectorAll('.msg-note-badge').forEach((b) => b.remove());
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    el.remove();
    parent.normalize();
  }
}
