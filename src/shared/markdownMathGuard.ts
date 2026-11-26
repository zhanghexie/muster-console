/**
 * 行内数学公式的货币误报守卫（remark-math 前置预处理）。
 *
 * micromark-extension-math 的单 `$` 配对没有空格侧规则：正文里
 * 「价格是 $5 和总价 $10 合计」会把 `$5 和总价 $` 当成公式渲染成乱码。
 * 这里按 Pandoc 的行内公式规则补守卫：**内容首尾是空白（空格/制表/换行）
 * 的单 `$` 配对不是公式**——转义开定界符让它按字面量渲染。真公式
 * （$x^2$、场强中文$x_{ij}$继续）首尾不落空白，不受影响。
 *
 * 跳过项：``` 围栏与行内代码（复用 collectMarkdownCodeSpans）、`$$` 及以上
 * 连跑（块级/显示公式，内容常含换行不该被判定）、已转义的 `\$`。
 * 已知边界：`$5和$10`（CJK 无空格贴排）仍会误判——首尾无空白，守卫判不出，
 * 与 Pandoc 行为一致；出现频率远低于带空格的行文，接受。
 */
import { collectMarkdownCodeSpans } from './cjkMarkdownEmphasis';

interface Span {
  start: number;
  end: number;
}

function coveringSpan(spans: Span[], index: number): Span | undefined {
  for (const s of spans) {
    if (index >= s.start && index < s.end) return s;
  }
  return undefined;
}

/** 单 `$` 配对内容首尾空白 → 非公式（Pandoc 行内公式规则） */
const EDGE_WHITESPACE = /^\s|\s$/;

export function guardInlineMathCurrency(text: string): string {
  if (!text || !text.includes('$')) return text;
  const spans = collectMarkdownCodeSpans(text);
  const n = text.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const cover = coveringSpan(spans, i);
    if (cover) {
      out += text.slice(i, cover.end);
      i = cover.end;
      continue;
    }
    if (text[i] !== '$') {
      out += text[i];
      i++;
      continue;
    }
    // 已转义的 \$ 原样过（反斜杠已随上一轮输出）
    if (i > 0 && text[i - 1] === '\\') {
      out += text[i];
      i++;
      continue;
    }
    // `$$` 及以上连跑：块级/行内显示公式，交 remark-math 原样解析，整跑跳过
    let runEnd = i;
    while (runEnd < n && text[runEnd] === '$') runEnd++;
    if (runEnd - i >= 2) {
      out += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    // 单 $：向后找配对的单 $（跳过代码保护段、$ 连跑与已转义 $）
    let close = -1;
    let j = i + 1;
    while (j < n) {
      const inner = coveringSpan(spans, j);
      if (inner) {
        j = inner.end;
        continue;
      }
      if (text[j] !== '$') {
        j++;
        continue;
      }
      let r = j;
      while (r < n && text[r] === '$') r++;
      if (r - j >= 2) {
        j = r;
        continue;
      }
      if (text[j - 1] === '\\') {
        j++;
        continue;
      }
      close = j;
      break;
    }
    if (close !== -1 && EDGE_WHITESPACE.test(text.slice(i + 1, close))) {
      // 非公式形态：只转义开定界符，i 前进一位让原闭 $ 之后重新参与配对
      //（「$5 和 $x$」里的 $x$ 仍能成公式）
      out += '\\$';
      i++;
    } else if (close !== -1) {
      // 有效配对：整段原样保留（含内容与闭定界符），跳到闭符之后
      //（逐字符续走会把闭 $ 误当下一对的 opener）
      out += text.slice(i, close + 1);
      i = close + 1;
    } else {
      out += '$';
      i++;
    }
  }
  return out;
}
