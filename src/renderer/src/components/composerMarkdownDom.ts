import { composerLineFormats } from './composerMarkdown';
import { serializeComposerDom, composerOffsetOfPosition, resolveComposerPosition } from './composerDomText';

export type ComposerSelection = { anchor: number; focus: number };

export function readComposerSelection(root: HTMLElement): ComposerSelection {
  const sel = window.getSelection();
  const fallback = serializeComposerDom(root).length;
  if (!sel?.anchorNode || !sel.focusNode || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) {
    return { anchor: fallback, focus: fallback };
  }
  return { anchor: composerOffsetOfPosition(root, sel.anchorNode, sel.anchorOffset), focus: composerOffsetOfPosition(root, sel.focusNode, sel.focusOffset) };
}

export function restoreComposerSelection(root: HTMLElement, selection: ComposerSelection): void {
  if (document.activeElement !== root) return;
  const anchor = resolveComposerPosition(root, selection.anchor);
  const focus = resolveComposerPosition(root, selection.focus);
  window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

/** Replace serialized ranges without leaving Chromium's emptied line wrappers behind. */
export function replaceComposerSourceRange(root: HTMLElement, start: number, end: number, replacement: string): void {
  const source = serializeComposerDom(root);
  const text = source.slice(0, start) + replacement + source.slice(end);
  const tokens = [...root.querySelectorAll<HTMLElement>('[data-token]')].flatMap(node => {
    const at = composerOffsetOfPosition(root, node.parentNode!, [...node.parentNode!.childNodes].indexOf(node));
    const size = (node.dataset.token ?? '').length;
    if (at + size <= start) return [{ node, at, size }];
    if (at >= end) return [{ node, at: at + replacement.length - (end - start), size }];
    return [];
  });
  root.replaceChildren();
  let cursor = 0;
  for (const token of tokens) {
    if (token.at > cursor) root.append(document.createTextNode(text.slice(cursor, token.at)));
    root.append(token.node); cursor = token.at + token.size;
  }
  if (cursor < text.length) root.append(document.createTextNode(text.slice(cursor)));
  const caret = start + replacement.length;
  restoreComposerSelection(root, { anchor: caret, focus: caret });
}

/** Format the editable itself. Hidden source prefixes stay in the text model via the
 *  line's data-prefix attribute (measure() synthesizes their offsets); they are NOT
 *  rendered as real inline content anymore——a font-size:0 span adjacent to the caret
 *  poisons Chromium's caret metrics (0-height caret, invisible on empty list items:
 *  2026-10-07 报单②，Electron 实测元素边界一律不可见、真实文本内/首子为 br 的 (line,0) 可见）。
 *  Atomic reference nodes are moved intact, never expanded into their decorative labels. */
export function formatComposerMarkdown(root: HTMLElement): void {
  const text = serializeComposerDom(root);
  const selection = readComposerSelection(root);
  const tokens = [...root.querySelectorAll<HTMLElement>('[data-token]')].map(node => ({
    node, start: composerOffsetOfPosition(root, node.parentNode!, [...node.parentNode!.childNodes].indexOf(node)),
    text: node.dataset.token ?? ''
  }));
  root.replaceChildren();
  if (!text) return;
  const formats = composerLineFormats(text);
  let start = 0;
  text.split('\n').forEach((line, index) => {
    const block = document.createElement('div');
    block.className = 'composer-md-line';
    const format = formats[index];
    if (format) {
      block.dataset.md = format.kind;
      block.dataset.marker = format.marker;
      if (format.level) block.dataset.level = String(format.level);
      // 源前缀入行属性：序列化/偏移由 measure() 的虚拟 span 承担，不再进内联流
      block.dataset.prefix = format.prefix;
    }
    let cursor = format?.prefix.length ?? 0;
    for (const token of tokens) {
      const offset = token.start - start;
      if (offset < cursor || offset + token.text.length > line.length) continue;
      if (offset > cursor) block.append(document.createTextNode(line.slice(cursor, offset)));
      block.append(token.node);
      cursor = offset + token.text.length;
    }
    // A text node after a marker/token provides an editable caret location.
    if (cursor < line.length) block.append(document.createTextNode(line.slice(cursor)));
    else {
      const placeholder = document.createElement('br');
      placeholder.setAttribute('data-composer-placeholder', '');
      block.append(placeholder);
    }
    root.append(block);
    start += line.length + 1;
  });
  restoreComposerSelection(root, selection);
}
