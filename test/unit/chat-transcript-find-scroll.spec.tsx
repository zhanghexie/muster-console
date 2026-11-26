/**
 * S1 滚动回归（B1-1 content-visibility 下放子块的安全网）：
 * 1) find 量位与 scrollIntoView-after-forceFoldOpen：find 命中落在折叠历史的中间
 *    正文（.turn-fold-item 内的 .md-body）时，forceFoldOpen（ChatTranscript.tsx:780）
 *    必须在同一次提交里展开折叠挂出条目，paintFindMarks 再在 useLayoutEffect 里
 *    包 mark 并 scrollIntoView 到 is-active 命中块本身——不许退化为消息锚点
 *    [data-mid] 兜底（那会定位到消息头而不是命中处）。
 * 2) 子块 containment 规则自检（回滚开关）：chat.css 的 .turn-fold-item /
 *    .tool-call-block 与 markdown.css 的 .md-body > * 必须带 content-visibility:auto
 *    + contain-intrinsic-size:auto 100px；文件预览豁免规则在场。
 * 还原即红：删除两行子块规则（文档化回滚）时 2) 转红；移除 forceFoldOpen 接线或
 * 「先展开后量位」顺序被破坏时 1) 转红。
 * 运行: npx vitest run test/unit/chat-transcript-find-scroll.spec.tsx
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import type { ChatMessage, ChatDisplayPart, ToolCallRecord } from '../../src/shared/types';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const here = dirname(fileURLToPath(import.meta.url));

/** Bounded navigation measures the exact expanded hit, rather than delegating
 * an uninterruptible smooth scroll to scrollIntoView. */
const measured: Element[] = [];

beforeEach(() => {
  measured.length = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    measured.push(this); return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON() {} };
  });
});
afterEach(() => vi.restoreAllMocks());

const mkTool = (i: number): ToolCallRecord => ({
  id: `t${i}`,
  name: 'sessions.list',
  arguments: '{}',
  result: '{"ok":true}',
  status: 'ok'
});

interface Src {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  parts?: ChatDisplayPart[];
}

const model: TranscriptModelBinding<Src> = {
  toDisplay: (m) => m as unknown as ChatMessage
};

describe('S1 滚动回归：find 量位与 scrollIntoView-after-forceFoldOpen', () => {
  it('折叠历史轮的 find 命中：先展开挂出 turn-fold-item，再量位滚动到 is-active 命中块', () => {
    const messages: Src[] = [
      { id: 'm0', role: 'user', content: '前情', createdAt: 1 },
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        createdAt: 2,
        parts: [
          { kind: 'tool', toolCall: mkTool(1) },
          { kind: 'text', text: '中间结论 FOLDNEEDLE 段' },
          { kind: 'tool', toolCall: mkTool(2) },
          { kind: 'text', text: '最终结论' }
        ]
      }
    ];
    const { container } = render(
      <ChatTranscript
        messages={messages}
        busy={false}
        sessionId="s-find-scroll"
        model={model}
        findQuery="FOLDNEEDLE"
        findActive={{ messageId: 'm1', indexInMessage: 0 }}
      />
    );
    // forceFoldOpen 已挂出折叠条目（中间正文在 .turn-fold-item 内）
    const foldItems = container.querySelectorAll('.turn-fold-item');
    expect(foldItems.length).toBeGreaterThan(0);
    // find 量位：is-active 命中 mark 在场，且就挂在折叠条目内部（先展开后量位）
    const active = container.querySelector('mark.chat-find-hit.is-active');
    expect(active).toBeTruthy();
    expect(active!.textContent).toContain('FOLDNEEDLE');
    expect(active!.closest('.turn-fold-item')).toBeTruthy();
    // scrollIntoView-after-forceFoldOpen：滚动目标就是命中块本身，居中平滑；
    // 若拿 [data-mid] 消息锚点兜底，说明展开先于量位的顺序被破坏
    expect(measured).toContain(active!);
    const anchor = container.querySelector('[data-mid="m1"]');
    expect(anchor).toBeTruthy();
    expect(measured).not.toContain(anchor!);
  });
});

describe('B1-1 子块 containment 规则在场（回滚开关自检）', () => {
  const css = (name: string): string =>
    readFileSync(resolve(here, '../../src/renderer/src/styles', name), 'utf8');

  /** 取 selector 首次出现处跟的声明块（本仓样式无嵌套） */
  function ruleBlock(cssText: string, selectorPattern: string): string {
    const re = new RegExp(`${selectorPattern}\\s*\\{`);
    const m = re.exec(cssText);
    if (!m) return '';
    const open = cssText.indexOf('{', m.index);
    const close = cssText.indexOf('}', open);
    return cssText.slice(open + 1, close);
  }

  it('chat.css：.turn-fold-item 与 .tool-call-block 带 content-visibility + 占位尺寸', () => {
    const chat = css('chat.css');
    const foldItem = ruleBlock(chat, '\\.turn-fold-item');
    expect(foldItem).toContain('content-visibility: auto');
    expect(foldItem).toContain('contain-intrinsic-size: auto 100px');
    const toolBlock = ruleBlock(chat, '\\.tool-call-block');
    expect(toolBlock).toContain('content-visibility: auto');
    expect(toolBlock).toContain('contain-intrinsic-size: auto 100px');
  });

  it('markdown.css：.md-body 直接子块带 containment；文件预览豁免在场', () => {
    const md = css('markdown.css');
    const child = ruleBlock(md, '\\.md-body\\s*>\\s*\\*');
    expect(child).toContain('content-visibility: auto');
    expect(child).toContain('contain-intrinsic-size: auto 100px');
    const exemption = ruleBlock(md, '\\.ma-files-detail\\s+\\.md-body\\s*>\\s*\\*');
    expect(exemption).toContain('content-visibility: visible');
  });
});
