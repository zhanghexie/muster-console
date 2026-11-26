/**
 * Composer 富文本输入的纯文本 → token 分段（共享纯函数，test/composer-tokens.mjs 锁行为）。
 * contenteditable 输入框从纯文本（草稿/外部写入）重建 DOM 时用它把 批注N 切成药丸段；
 * 反方向（DOM → 纯文本序列化）在渲染层做 DOM walk，不在这里。
 * 发送契约不变：序列化产物仍是「批注N / @path / /skill:name」纯文本。
 */

import { composerReferenceRanges, makeNoteTokenMatcher } from './noteAnnotations';

export interface NoteTokenRef {
  id: string;
  token: string;
}

export type ComposerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'note'; id: string; token: string };

/**
 * 把输入框纯文本切段：出现的 批注N 若能对上 noteTokens 的 token 文本则给 note 段
 * （\d+ 贪婪使「批注1」不会咬进「批注10」），对不上的当纯文本保留。
 */
export function tokenizeComposerText(
  text: string,
  noteTokens: readonly NoteTokenRef[]
): ComposerSegment[] {
  const idByToken = new Map(noteTokens.map((n) => [n.token, n.id]));
  const out: ComposerSegment[] = [];
  let last = 0;
  const tokenRe = makeNoteTokenMatcher();
  const references = composerReferenceRanges(text);
  for (let m = tokenRe.exec(text); m; m = tokenRe.exec(text)) {
    const offset = m.index;
    if (references.some(([start, end]) => offset >= start && offset < end)) continue;
    const id = idByToken.get(m[0]);
    if (!id) continue;
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({ kind: 'note', id, token: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** 草稿里按当前表应切出的批注 id 序（与 DOM data-note-id 对账） */
export function expectedNoteTokenIds(
  text: string,
  noteTokens: readonly NoteTokenRef[]
): string[] {
  return tokenizeComposerText(text, noteTokens)
    .filter((s): s is Extract<ComposerSegment, { kind: 'note' }> => s.kind === 'note')
    .map((s) => s.id);
}

/** DOM 已切出的批注 id 是否与表一致；不一致就要按新表 rebuild（否则最后一颗会停在纯文本） */
export function noteTokenDomMatches(
  text: string,
  noteTokens: readonly NoteTokenRef[],
  liveNoteIds: readonly string[]
): boolean {
  const expected = expectedNoteTokenIds(text, noteTokens);
  if (expected.length !== liveNoteIds.length) return false;
  return expected.every((id, i) => id === liveNoteIds[i]);
}
