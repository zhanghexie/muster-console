/** Lightweight Markdown blocks; the editor always sends the original source. */
export type ComposerLineFormat = { kind: 'heading' | 'ordered' | 'bullet'; prefix: string; marker: string; level?: number };

export function composerLineFormat(line: string): ComposerLineFormat | null {
  const heading = /^( {0,3})(#{1,6})[\t ]+/.exec(line);
  if (heading) return { kind: 'heading', prefix: heading[0], marker: '', level: heading[2].length };
  const ordered = /^([\t ]*)(\d{1,9})([.)])[\t ]+/.exec(line);
  if (ordered) return { kind: 'ordered', prefix: ordered[0], marker: ordered[2] + ordered[3] };
  const bullet = /^([\t ]*)([-+*])[\t ]+/.exec(line);
  if (bullet) return { kind: 'bullet', prefix: bullet[0], marker: '•' };
  return null;
}

/** Fence contents stay literal, including a heading/list-looking first line. */
export function composerLineFormats(text: string): (ComposerLineFormat | null)[] {
  let fence: { char: string; length: number } | null = null;
  return text.split('\n').map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match && !fence) { fence = { char: match[1][0], length: match[1].length }; return null; }
    if (match && fence && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) {
      fence = null; return null;
    }
    return fence ? null : composerLineFormat(line);
  });
}

export function composerNewlineEdit(text: string, start: number, end = start): { start: number; end: number; text: string } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', start);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const format = composerLineFormats(text)[text.slice(0, lineStart).split('\n').length - 1];
  if (!format || format.kind === 'heading' || start < lineStart + format.prefix.length) return { start, end, text: '\n' };
  // An empty item becomes a plain empty line, without creating another item.
  if (!line.slice(format.prefix.length).trim() && start === end) return { start: lineStart, end: lineStart + line.length, text: '' };
  const next = format.kind === 'ordered'
    ? format.prefix.replace(/\d{1,9}/, value => String(Number(value) + 1))
    : format.prefix;
  return { start, end, text: '\n' + next };
}
