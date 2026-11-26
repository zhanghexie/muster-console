import { matchUiArtifactLink, type UiArtifactLinkMatch } from './uiArtifactLink';
import { uiWidgetIdentity } from './uiWidgetProtocol';

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, string> };
  [key: string]: unknown;
}

function label(node: Node): string { return node.value ?? node.children?.map(label).join('') ?? ''; }
const referenceId = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

/** Only rendered links claim a tool output's position; quoted code and bare paths do not. */
export function renderedUiArtifactLinks(markdown: string): UiArtifactLinkMatch[] {
  let fence = '', length = 0;
  const visible = markdown.split(/\r?\n/).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1]![0] === fence && marker[1]!.length >= length && !marker[2]!.trim()) fence = '';
      return '';
    }
    if (marker) { fence = marker[1]![0]!; length = marker[1]!.length; return ''; }
    return /^(?: {4}|\t)/.test(line) ? '' : line;
  }).join('\n').replace(/(`+)[\s\S]*?\1(?!`)/g, '');
  const definitions = new Map<string, string>();
  for (const match of visible.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|([^\s\n]+))/gm)) {
    const id = referenceId(match[1]!); if (!definitions.has(id)) definitions.set(id, match[2] ?? match[3]!);
  }
  const found = new Map<string, UiArtifactLinkMatch>();
  const add = (url: string): void => { const hit = matchUiArtifactLink(url); if (hit) found.set(uiWidgetIdentity(hit.path), hit); };
  for (const match of visible.matchAll(/(?<!!)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) add(match[1] ?? match[2]!);
  for (const match of visible.matchAll(/<([a-z][a-z0-9+.-]*:\/\/[^>\n]+)>/gi)) add(match[1]!);
  for (const match of visible.matchAll(/(?<!!)\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g)) {
    if (/^\s*[:(]/.test(visible.slice(match.index! + match[0].length))) continue;
    const url = definitions.get(referenceId(match[2] || match[1]!)); if (url) add(url);
  }
  return [...found.values()];
}

/** Block artifacts split paragraphs; no iframe/button/div is buried inside a Markdown <p>. */
export function transformUiArtifactMarkdown(root: Node, suppressedPaths: readonly string[] = []): void {
  const seen = new Set(suppressedPaths.map(uiWidgetIdentity));
  const definitions = new Map<string, string>();
  let hasArtifacts = false;
  function collect(node: Node): void {
    // 普通 Markdown 占绝大多数：一次收集时辨明没有部件后，不再遍历并重建整棵树。
    // 引用式链接在 definition 上识别，不能只看 type=link。
    if (node.type === 'maUiArtifact' ||
        ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string' && matchUiArtifactLink(node.url))) {
      hasArtifacts = true;
    }
    if (node.type === 'definition' && typeof node.identifier === 'string' && typeof node.url === 'string') {
      const id = referenceId(node.identifier); if (!definitions.has(id)) definitions.set(id, node.url);
    }
    node.children?.forEach(collect);
  }
  collect(root);
  if (!hasArtifacts) return;
  function transform(node: Node): void {
    if (node.type === 'linkReference' && typeof node.identifier === 'string') {
      const url = definitions.get(referenceId(node.identifier));
      if (url && matchUiArtifactLink(url)) {
        node.type = 'link'; node.url = url; delete node.identifier; delete node.referenceType;
      }
    }
    if (node.type === 'link' && typeof node.url === 'string') {
      const match = matchUiArtifactLink(node.url);
      if (match) {
        const key = uiWidgetIdentity(match.path);
        const title = label(node);
        if (seen.has(key)) {
          node.type = 'text'; node.value = title; delete node.children; delete node.url;
        } else {
          seen.add(key);
          node.type = 'maUiArtifact'; node.children = [];
          node.data = { hName: 'span', hProperties: { 'data-ma-ui-path': match.path, 'data-ma-ui-title': title } };
          delete node.url;
        }
      }
    }
    node.children?.forEach(transform);
    if (!node.children) return;
    const next: Node[] = [];
    for (const child of node.children) {
      if (child.type !== 'paragraph') { next.push(child); continue; }
      let text: Node[] = [];
      const flush = (): void => { if (text.length) next.push({ ...child, children: text }); text = []; };
      for (const segment of splitInline(child.children ?? [])) {
        if (segment.type === 'maUiArtifact') { flush(); next.push(segment); }
        else text.push(segment);
      }
      flush();
    }
    node.children = next;
  }
  function splitInline(children: Node[]): Node[] {
    const result: Node[] = [];
    for (const child of children) {
      if (child.type === 'maUiArtifact' || !child.children) { result.push(child); continue; }
      const segments = splitInline(child.children);
      let normal: Node[] = [];
      const flush = (): void => { if (normal.length) result.push({ ...child, children: normal }); normal = []; };
      for (const segment of segments) {
        if (segment.type === 'maUiArtifact') { flush(); result.push(segment); }
        else normal.push(segment);
      }
      flush();
    }
    return result;
  }
  transform(root);
}

export function remarkUiArtifacts(options?: { suppressedPaths?: readonly string[] }): (tree: unknown) => void {
  return (tree): void => transformUiArtifactMarkdown(tree as Node, options?.suppressedPaths);
}
