/**
 * CommonMark / GFM 强调定界符的 CJK flanking 兼容。
 *
 * 严格 CommonMark 的 right-flanking 要求：定界符前是标点时，后面必须是空白或标点。
 * 「**已经完成。**然后」里闭合 ** 前是 。、后是汉字 → 不能闭合 → 按字面显示 **。
 * 斜体 *、GFM 删除线 ~~ 同一套规则。CommonMark #650 仍未定案。
 *
 * 选型：解析前在「内侧标点 ↔ 定界符」之间插入 U+200B（零宽空格），
 * 让 flanking 成立；围栏/行内代码整段跳过。解析后再从 AST 文本节点剥掉 ZWSP，
 * 渲染 DOM / 划选复制不带不可见字符。评估与否决项见
 * docs/features/markdown-cjk-emphasis.md。
 */

/** 插入用的零宽空格；解析后由 remarkStripCjkEmphasisZwsp 从 text 节点剥掉 */
export const CJK_EMPHASIS_ZWSP = '\u200b';

/** CommonMark Unicode whitespace：Zs + TAB/LF/FF/CR（不含 U+200B，它是 Cf） */
const WS_RE = /[\t\n\f\r\p{Zs}]/u;
/**
 * CommonMark punctuation：ASCII 标点（含 $ + < = > ^ ` | ~ 等符号位）
 * + Unicode Pc/Pd/Pe/Pf/Pi/Po/Ps。
 */
const PUNCT_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\p{P}]/u;

function isWs(ch: string): boolean {
  return WS_RE.test(ch);
}

function isPunct(ch: string): boolean {
  return PUNCT_RE.test(ch);
}

interface Span {
  start: number;
  end: number;
}

function isLineStart(text: string, i: number): boolean {
  return i === 0 || text[i - 1] === '\n';
}

/**
 * 围栏（行首 0–3 空格 + 3 个以上 ` 或 ~）与行内代码。
 * 未闭合围栏保护到文末；未闭合行内 ` 当字面量（不保护）。
 */
export function collectMarkdownCodeSpans(text: string): Span[] {
  const spans: Span[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (isLineStart(text, i)) {
      let j = i;
      let spaces = 0;
      while (j < n && text[j] === ' ' && spaces < 3) {
        j++;
        spaces++;
      }
      const fenceChar = text[j];
      if (fenceChar === '`' || fenceChar === '~') {
        let k = j;
        while (k < n && text[k] === fenceChar) k++;
        const fenceLen = k - j;
        if (fenceLen >= 3) {
          let p = k;
          while (p < n && text[p] !== '\n') p++;
          if (p < n) p++;
          let closed = n;
          while (p < n) {
            const line = p;
            let q = p;
            let sp = 0;
            while (q < n && text[q] === ' ' && sp < 3) {
              q++;
              sp++;
            }
            if (text[q] === fenceChar) {
              let r = q;
              while (r < n && text[r] === fenceChar) r++;
              if (r - q >= fenceLen) {
                let s = r;
                while (s < n && (text[s] === ' ' || text[s] === '\t')) s++;
                if (s >= n || text[s] === '\n') {
                  closed = s >= n ? n : s + 1;
                  break;
                }
              }
            }
            const nl = text.indexOf('\n', line);
            if (nl === -1) {
              closed = n;
              break;
            }
            p = nl + 1;
          }
          spans.push({ start: i, end: closed });
          i = closed;
          continue;
        }
      }
    }

    if (text[i] === '`') {
      let k = i;
      while (k < n && text[k] === '`') k++;
      const ticks = k - i;
      let p = k;
      let found = -1;
      while (p < n) {
        if (text[p] === '`') {
          let q = p;
          while (q < n && text[q] === '`') q++;
          if (q - p === ticks) {
            found = q;
            break;
          }
          p = q;
        } else {
          p++;
        }
      }
      if (found !== -1) {
        spans.push({ start: i, end: found });
        i = found;
        continue;
      }
    }

    i++;
  }
  return spans;
}

function spanCovering(spans: Span[], index: number): Span | undefined {
  for (const s of spans) {
    if (index >= s.start && index < s.end) return s;
  }
  return undefined;
}

interface DelimRun {
  start: number;
  end: number;
  ch: '*' | '~';
  len: number;
}

function collectDelimRuns(text: string, protectedSpans: Span[]): DelimRun[] {
  const runs: DelimRun[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const cover = spanCovering(protectedSpans, i);
    if (cover) {
      i = cover.end;
      continue;
    }
    const ch = text[i];
    if (ch === '*' || ch === '~') {
      let j = i;
      while (j < n && text[j] === ch) j++;
      const len = j - i;
      if (ch === '~' && len < 2) {
        i++;
        continue;
      }
      runs.push({ start: i, end: j, ch, len });
      i = j;
      continue;
    }
    i++;
  }
  return runs;
}

/** 忽略当前 flanking，按「能开/能闭」就近配对，才能改写 flanking 失败的那一侧 */
function pairDelimRuns(text: string, runs: DelimRun[]): Array<{ open: DelimRun; close: DelimRun }> {
  const pairs: Array<{ open: DelimRun; close: DelimRun }> = [];
  const stacks: Record<'*' | '~', DelimRun[]> = { '*': [], '~': [] };
  for (const run of runs) {
    const prev = run.start > 0 ? text[run.start - 1] : '';
    const next = run.end < text.length ? text[run.end] : '';
    const canClose = Boolean(prev && !isWs(prev));
    const canOpen = Boolean(next && !isWs(next));
    const stack = stacks[run.ch];
    if (canClose && stack.length > 0) {
      let idx = stack.length - 1;
      while (idx >= 0 && stack[idx].len !== run.len) idx--;
      if (idx < 0) idx = stack.length - 1;
      const open = stack.splice(idx, 1)[0];
      pairs.push({ open, close: run });
    } else if (canOpen) {
      stack.push(run);
    }
  }
  return pairs;
}

/**
 * 在需要帮助 flanking 的定界符内侧插入 ZWSP。
 * `*` / `**` / `***`… 与 `~~`（≥2 个 ~）都处理；单 ~ 与 `_` 不动。
 * 先配对再插：避免把「。**汉字**」（标点在强调外侧、本就能解析）误判成闭合失败。
 */
export function softenCjkMarkdownEmphasis(text: string): string {
  if (!text) return text;
  const protectedSpans = collectMarkdownCodeSpans(text);
  const runs = collectDelimRuns(text, protectedSpans);
  if (!runs.length) return text;
  const pairs = pairDelimRuns(text, runs);
  const insertBefore = new Set<number>();
  const insertAfter = new Set<number>();
  for (const { open, close } of pairs) {
    const closePrev = text[close.start - 1] ?? '';
    const closeNext = text[close.end] ?? '';
    if (closePrev && closeNext && isPunct(closePrev) && !isWs(closeNext) && !isPunct(closeNext)) {
      insertBefore.add(close.start);
    }
    const openPrev = text[open.start - 1] ?? '';
    const openNext = text[open.end] ?? '';
    if (openPrev && openNext && isPunct(openNext) && !isWs(openPrev) && !isPunct(openPrev)) {
      insertAfter.add(open.end);
    }
  }
  if (!insertBefore.size && !insertAfter.size) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (insertBefore.has(i)) out += CJK_EMPHASIS_ZWSP;
    out += text[i];
    if (insertAfter.has(i + 1)) out += CJK_EMPHASIS_ZWSP;
  }
  return out;
}

type MdastLike = {
  type?: string;
  value?: string;
  children?: MdastLike[];
};

/** 只剥 text 节点里的 ZWSP（code / inlineCode 的 value 不动） */
export function stripCjkEmphasisZwspFromTree(tree: MdastLike): void {
  if (!tree) return;
  if (tree.type === 'text' && typeof tree.value === 'string' && tree.value.includes(CJK_EMPHASIS_ZWSP)) {
    tree.value = tree.value.replaceAll(CJK_EMPHASIS_ZWSP, '');
  }
  if (Array.isArray(tree.children)) {
    for (const child of tree.children) stripCjkEmphasisZwspFromTree(child);
  }
}

/** remark 插件：解析后从正文 text 节点去掉预处理插入的 ZWSP */
export function remarkStripCjkEmphasisZwsp(): (tree: MdastLike) => void {
  return (tree) => {
    stripCjkEmphasisZwspFromTree(tree);
  };
}
