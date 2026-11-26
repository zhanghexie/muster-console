/**
 * Markdown 围栏是否为 mermaid 图（```mermaid / class="language-mermaid"）。
 * 纯函数，渲染层与离线单测共用。
 */
export function isMermaidFenceClass(className: string | undefined | null): boolean {
  if (!className) return false;
  return className.split(/\s+/).some((token) => /^language-mermaid$/i.test(token) || /^mermaid$/i.test(token));
}

export function mermaidSourceFromCodeChildren(children: unknown): string {
  if (typeof children === 'string') return stripTrailingNewline(children);
  if (Array.isArray(children)) {
    return stripTrailingNewline(children.map((c) => (typeof c === 'string' ? c : '')).join(''));
  }
  if (children == null) return '';
  return stripTrailingNewline(String(children));
}

function stripTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}
