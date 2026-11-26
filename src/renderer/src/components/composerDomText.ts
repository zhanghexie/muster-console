/** 输入核的纯文本视图：原生编辑生成的 div/p 行块也计入换行，光标与序列化同源。
 *  md 行的源前缀（"2. " / "- " / "# "）不在内联流里（零宽 span 会毒化 caret 度量），
 *  由行元素的 data-prefix 属性承担：measure() 在行内容前合成等长虚拟 span，
 *  序列化/偏移/复制语义与真实文本完全一致。 */
type Position = { node: Node; offset: number };
type Span = { start: number; text: string; before: Position; after: Position; textNode?: Node; mdPrefix?: boolean };
const BLOCKS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE']);

function measure(root: HTMLElement): {
  text: string; spans: Span[]; positions: Map<Node, { start: number; children?: number[] }>;
} {
  let text = '';
  const spans: Span[] = [];
  const positions = new Map<Node, { start: number; children?: number[] }>();
  const append = (value: string, before: Position, after: Position, textNode?: Node, mdPrefix = false): void => {
    if (!value) return;
    spans.push({ start: text.length, text: value, before, after, textNode, mdPrefix });
    text += value;
  };
  const walk = (parent: HTMLElement): void => {
    const offsets = [text.length];
    positions.set(parent, { start: text.length, children: offsets });
    let previousBlock = false;
    let previousEmptyBlock = false;
    Array.from(parent.childNodes).forEach((node, i) => {
      const el = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : null;
      const token = !!el?.hasAttribute('data-token');
      const block = !!el && !token && BLOCKS.has(el.tagName);
      offsets[i] = text.length;
      if (i > 0 && (block || previousBlock) && (!text.endsWith('\n') || previousEmptyBlock)) {
        append('\n', { node: parent, offset: i }, { node: block ? node : parent, offset: block ? 0 : i });
      }
      const start = text.length;
      positions.set(node, { start });
      if (node.nodeType === Node.TEXT_NODE) {
        append(node.nodeValue ?? '', { node, offset: 0 }, { node, offset: node.nodeValue?.length ?? 0 }, node);
      } else if (el) {
        if (token) {
          append(el.dataset.token ?? '', { node: parent, offset: i }, { node: parent, offset: i + 1 });
        } else if (el.tagName === 'BR') {
          // Chromium can leave a lone caret filler when IME composition is erased,
          // including directly under the editor root. Real empty lines use block boundaries.
          const emptyLineFiller = BLOCKS.has(parent.tagName) && parent.childElementCount === 1 && !parent.textContent;
          // Chromium inserts an unmarked caret filler after a trailing non-editable
          // token when the following space is deleted. It is not a line break.
          const tokenFiller = parent.classList.contains('composer-md-line') && !node.nextSibling &&
            (node.previousSibling as HTMLElement | null)?.hasAttribute?.('data-token');
          if (!el.hasAttribute('data-composer-placeholder') && !tokenFiller && !emptyLineFiller) {
            append('\n', { node: parent, offset: i }, { node: parent, offset: i + 1 });
          }
        } else {
          // md 行的隐藏源前缀：等长虚拟 span（无 DOM 文本，caret 解析走 before/after）
          const mdPrefix = el.getAttribute('data-prefix');
          if (mdPrefix) append(mdPrefix, { node: el, offset: 0 }, { node: el, offset: 0 }, undefined, true);
          walk(el);
        }
      }
      offsets[i + 1] = text.length;
      previousBlock = block;
      previousEmptyBlock = block && text.length === start;
    });
  };
  walk(root);
  return { text, spans, positions };
}

export function serializeComposerDom(root: HTMLElement | null): string {
  return root ? measure(root).text : '';
}

export function composerOffsetOfPosition(root: HTMLElement, container: Node, offset: number): number {
  const view = measure(root);
  const info = view.positions.get(container);
  if (!info) {
    // 非编辑 token 内的装饰文字不计入偏移。
    const token = container.parentElement?.closest('[data-token]');
    return token ? view.positions.get(token)?.start ?? view.text.length : view.text.length;
  }
  if (container.nodeType === Node.TEXT_NODE) return info.start + Math.max(0, Math.min(offset, container.nodeValue?.length ?? 0));
  return info.children?.[Math.max(0, Math.min(offset, info.children.length - 1))] ?? info.start;
}

export function resolveComposerPosition(root: HTMLElement, offset: number): Position {
  const view = measure(root);
  const target = Math.max(0, Math.min(Math.floor(offset), view.text.length));
  for (const span of view.spans) {
    const end = span.start + span.text.length;
    if (target < end) return span.textNode ? { node: span.textNode, offset: target - span.start } : span.before;
    if (target === end) {
      // 隐藏的 Markdown 源前缀（data-prefix 虚拟 span）不可作为光标位：
      // 前缀内部/紧后都归到行首内容位——空项行首子为 br、内容行首子为文本，
      // 两种 (line,0) 均有真实 caret 度量（零宽内联 span 相邻的 caret 不可见）。
      return span.after;
    }
  }
  return { node: root, offset: root.childNodes.length };
}
