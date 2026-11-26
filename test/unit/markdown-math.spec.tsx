/**
 * MarkdownBody 数学公式：remark-math + rehype-katex 接线的行为合同。
 * 行内 $…$ / 块级 $$…$$ 渲出 .katex 节点；CJK 紧贴公式不破坏渲染（与
 * soften/ZWSP 预处理层的交互）；货币「$5 和 $10」（闭侧 $ 前是空格）按
 * micromark 定界规则不误判；代码块内保持字面量。
 * 还原即红：删掉 MarkdownBody 的 remark-math/rehype-katex 接线 → 全部用例转红。
 * 运行: npx vitest run test/unit/markdown-math.spec.tsx
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';

function body(text: string): HTMLElement {
  const { container } = render(<MarkdownBody text={text} />);
  return container;
}

describe('MarkdownBody 数学公式', () => {
  it('行内 $…$ 渲出 .katex，源码定界符不残留在文本里', () => {
    const el = body('环量满足 $x^2 + y^2 = r^2$ 这一约束');
    const katex = el.querySelector('.katex');
    expect(katex).toBeTruthy();
    expect(el.textContent).not.toContain('$x^2');
    expect(el.textContent).toContain('环量满足');
    expect(el.textContent).toContain('这一约束');
  });

  it('块级 $$…$$（闭围栏独立成行）渲出居中公式（.katex-display 内含 .katex）', () => {
    const el = body('$$\n\\int_0^1 f(x)\\,dx = F(1) - F(0)\n$$');
    expect(el.querySelector('.katex-display .katex')).toBeTruthy();
  });

  it('单行 $$…$$ 按行内公式渲染（remark-math：flow 数学要求闭围栏独立成行）', () => {
    const el = body('总量 $$E = mc^2$$ 守恒');
    expect(el.querySelector('.katex')).toBeTruthy();
    expect(el.querySelector('.katex-display')).toBeNull();
  });

  it('CJK 紧贴公式（两侧都无空格）仍渲染；正文不残留 ZWSP（KaTeX vlist 内部除外）', () => {
    const el = body('场强中文$x_{ij}$继续');
    expect(el.querySelector('.katex')).toBeTruthy();
    expect(el.textContent).toContain('中文');
    expect(el.textContent).toContain('继续');
    // ZWSP 契约针对预处理层：只查公式子树之外的正文（KaTeX 自己会在 vlist 里放 ZWSP）
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.katex').forEach((node) => node.remove());
    expect(clone.textContent).not.toContain('\u200b');
  });

  it('货币「$5 和 $10」不误判为公式（闭侧 $ 前是空格被定界规则挡下）', () => {
    const el = body('价格是 $5 和总价 $10 合计');
    expect(el.querySelector('.katex')).toBeNull();
    expect(el.textContent).toContain('$5');
    expect(el.textContent).toContain('$10');
  });

  it('代码块内 $…$ 保持字面量（与 CJK 兼容层的代码保护语义一致）', () => {
    const el = body('```\n$x^2$ 不是公式\n```');
    expect(el.querySelector('.katex')).toBeNull();
    expect(el.querySelector('pre')?.textContent).toContain('$x^2$');
  });

  it('公式与加粗混排：** 强调内的公式照常渲染，互不吞食', () => {
    const el = body('**结论**：$a^2 + b^2 = c^2$成立');
    expect(el.querySelector('strong')?.textContent).toBe('结论');
    expect(el.querySelector('.katex')).toBeTruthy();
  });
});
