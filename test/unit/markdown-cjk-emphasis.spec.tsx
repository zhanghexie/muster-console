/**
 * MarkdownBody CJK 强调兼容：闭合 ** 前是中文标点、后紧跟汉字时要渲 strong，
 * 代码块/行内代码里的 ** 保持字面量，表格与英文加粗不回归。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';

function body(text: string): HTMLElement {
  const { container } = render(<MarkdownBody text={text} />);
  return container;
}

describe('MarkdownBody CJK 强调兼容', () => {
  it('闭合 ** 前是中文标点、后紧跟汉字 → strong（。**汉字）', () => {
    const el = body('**已经完成。**然后继续');
    const strong = el.querySelector('strong');
    expect(strong).toBeTruthy();
    expect(strong?.textContent).toBe('已经完成。');
    expect(el.textContent).toContain('然后继续');
    expect(el.textContent).not.toContain('**');
    expect(el.textContent).not.toContain('\u200b');
  });

  it('开启侧内侧是中文标点 → strong', () => {
    const el = body('然后**。强调**继续');
    expect(el.querySelector('strong')?.textContent).toBe('。强调');
    expect(el.textContent).not.toContain('**');
  });

  it('斜体 *、删除线 ~~ 同样兼容', () => {
    const em = body('*完成。*然后');
    expect(em.querySelector('em')?.textContent).toBe('完成。');
    expect(em.textContent).not.toContain('*');

    const del = body('~~完成。~~然后');
    expect(del.querySelector('del')?.textContent).toBe('完成。');
    expect(del.textContent).not.toContain('~~');
  });

  it('代码块内 ** 不动', () => {
    const el = body('```\n**a。**b\n```');
    expect(el.querySelector('strong')).toBeNull();
    expect(el.querySelector('pre')?.textContent).toContain('**a。**b');
  });

  it('行内代码不受影响', () => {
    const el = body('见 `**a。**b` 字面量');
    expect(el.querySelector('strong')).toBeNull();
    expect(el.querySelector('code')?.textContent).toBe('**a。**b');
  });

  it('表格单元格英文加粗仍渲染，管道不被破坏', () => {
    const el = body('| x |\n| --- |\n| **ok** |');
    expect(el.querySelector('table')).toBeTruthy();
    expect(el.querySelector('strong')?.textContent).toBe('ok');
  });

  it('正常英文加粗不回归', () => {
    const el = body('This is **bold** text');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.textContent).toContain('This is');
    expect(el.textContent).toContain('text');
    expect(el.textContent).not.toContain('**');
  });

  it('标点在强调外侧的「。**汉字**」本就能解析，不回归', () => {
    const el = body('已经完成。**然后继续**做');
    expect(el.querySelector('strong')?.textContent).toBe('然后继续');
    expect(el.textContent).not.toContain('\u200b');
  });
});
