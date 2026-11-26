/**
 * 时间衰减（R-23 一期）组件契约：
 * 超过阈值（24h，shared/chatStaleTurn）的旧回合在渲染层只保留最后输出——
 * 折叠头转只读归档态（aria-disabled + title），点击不展开，中间工具/思考/正文维持
 * 真卸载；近期回合维持现状（可展开）；缺时间戳回落「近期可展开」（保守）。
 * 还原即红：移除 stale 门（staleTurn 恒 false / 忽略 prop）时，
 * 「超期点击不展开」「title 说明」两条断言转红。
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { toDisplayMessage } from '../../src/renderer/src/chatSurface/guiMessageView';
import { ChatTranscript } from '../../src/renderer/src/chatSurface/ChatTranscript';
import { STALE_TURN_MS } from '../../src/shared/chatStaleTurn';
import type { ChatMessage, ChatDisplayPart, ToolCallRecord } from '../../src/shared/types';
import type { TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';

vi.mock('../../src/renderer/src/thinkingDisplayPreference', () => ({ useLiveThinkingOnly: () => false }));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const mkTool = (i: number): ToolCallRecord => ({
  id: `t${i}`,
  name: 'sessions.list',
  arguments: '{}',
  result: '{"ok":true}',
  status: 'ok'
});

const OLD_TS = Date.now() - STALE_TURN_MS - 60 * 60_000; // 25h 前（超期）
const FRESH_TS = Date.now() - 60_000; // 1min 前（近期）

const cards = (): number => document.querySelectorAll('.tool-call-block').length;
const openToolGroup = (root: ParentNode = document): void => {
  const summary = root.querySelector<HTMLDetailsElement>('.tool-call-group-details > summary');
  if (summary) fireEvent.click(summary);
};

function mountMsg(
  msg: Partial<ChatMessage> & { id: string; role: 'user' | 'assistant' },
  staleTurn: boolean
) {
  const full: ChatMessage = {
    content: '',
    createdAt: FRESH_TS,
    ...msg
  } as ChatMessage;
  return render(
    <ChatMessageView
      message={full}
      streaming={false}
      timeLabel=""
      quiet
      collapsedTurn
      staleTurn={staleTurn}
    />
  );
}

it('shows the final call outcome after reopening even when earlier calls produced text', () => {
  const source = { id: 'limit', role: 'assistant' as const, ts: FRESH_TS, finishedAt: FRESH_TS,
    parts: [{ kind: 'text' as const, text: 'Earlier step' }, { kind: 'thinking' as const, text: 'last call' }],
    harness: { calls: [{ usage: { inputTokens: 10, outputTokens: 8192, reasoningTokens: 8192 } }] } };
  expect(toDisplayMessage(source).finishedAt).toBe(FRESH_TS);
  const view = mountMsg(toDisplayMessage(source), false);
  expect(screen.getByRole('note').textContent).toContain('全部用于推理');
  view.unmount();
  const recorded = toDisplayMessage({ ...source, harness: { calls: [{ stopReason: 'length' }] } });
  mountMsg(recorded, false);
  expect(screen.getByRole('note').textContent).toContain('达到输出上限');
  expect(toDisplayMessage({ ...source, finishedAt: undefined }).outputNotice).toBeUndefined();
  expect(toDisplayMessage({ ...source, parts: [{ kind: 'text', text: 'answer' }] }).outputNotice).toBeUndefined();
});

describe('时间衰减：超期回合只读归档（parts 路径）', () => {
  it('折叠头 disabled + title 说明；点击不展开；只留最后一段正文', () => {
    const parts: ChatDisplayPart[] = [
      { kind: 'thinking', text: '盘算一下' },
      ...Array.from({ length: 20 }, (_, i) => mkTool(i)).map<ChatDisplayPart>((toolCall) => ({
        kind: 'tool',
        toolCall
      })),
      { kind: 'text', text: '开头说明' },
      { kind: 'text', text: '最终结论' }
    ];
    mountMsg({ id: 'm1', role: 'assistant', parts, createdAt: OLD_TS }, true);
    const fold = document.querySelector('.turn-fold') as HTMLButtonElement;
    expect(fold).toBeTruthy();
    expect(fold.classList.contains('is-stale')).toBe(true);
    expect(fold.getAttribute('aria-disabled')).toBe('true');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.getAttribute('title')).toContain('较早的回合已折叠归档');
    expect(cards()).toBe(0); // 工具/思考真卸载
    expect(screen.getByText('最终结论')).toBeTruthy(); // 最后输出保留
    expect(screen.queryByText('开头说明')).toBeNull(); // 中间正文卸载
    // 点击不展开（还原即红：移除 stale 门后这里会挂出工具卡）
    fireEvent.click(fold);
    expect(cards()).toBe(0);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
  });

  it('近期回合：折叠头可点开，工具卡挂载', () => {
    const parts: ChatDisplayPart[] = [
      ...Array.from({ length: 5 }, (_, i) => mkTool(i)).map<ChatDisplayPart>((toolCall) => ({
        kind: 'tool',
        toolCall
      })),
      { kind: 'text', text: '结论' }
    ];
    mountMsg({ id: 'm2', role: 'assistant', parts, createdAt: FRESH_TS }, false);
    const fold = document.querySelector('.turn-fold') as HTMLButtonElement;
    expect(fold.classList.contains('is-stale')).toBe(false);
    expect(fold.getAttribute('aria-disabled')).toBe(null);
    fireEvent.click(fold);
    openToolGroup();
    expect(cards()).toBeGreaterThan(0); // 可展开
  });

  it('缺时间戳（createdAt=0，老数据迁移回落）：视为近期可展开', () => {
    const parts: ChatDisplayPart[] = [
      { kind: 'thinking', text: '想一想' },
      { kind: 'text', text: '答案' }
    ];
    mountMsg({ id: 'm3', role: 'assistant', parts, createdAt: 0 }, false);
    const fold = document.querySelector('.turn-fold') as HTMLButtonElement;
    expect(fold.classList.contains('is-stale')).toBe(false);
    fireEvent.click(fold);
    fireEvent.click(document.querySelector('.thinking-card summary')!);
    expect(screen.getByText('想一想')).toBeTruthy(); // 展开挂出思考块
  });

  it('legacy 路径：thinking/toolCalls 恒折叠卸载，content 保留，折叠头 disabled', () => {
    mountMsg(
      {
        id: 'm4',
        role: 'assistant',
        thinking: '想了想',
        toolCalls: [mkTool(1), mkTool(2)],
        content: '答案',
        createdAt: OLD_TS
      },
      true
    );
    const fold = document.querySelector('.turn-fold') as HTMLButtonElement;
    expect(fold.getAttribute('aria-disabled')).toBe('true');
    expect(cards()).toBe(0);
    expect(screen.getByText('答案')).toBeTruthy();
    expect(screen.queryByText('想了想')).toBeNull();
    fireEvent.click(fold);
    expect(cards()).toBe(0); // 点击不展开
  });

  it('SQLite 归档消息即使时间戳近期也保持不可展开，并只显示归档正文', () => {
    mountMsg({
      id: 'archived',
      role: 'assistant',
      archived: true,
      archivedTools: [{ id: 'archived-tool', name: 'sessions.list', status: 'ok' }],
      thinking: '已清理的思考',
      toolCalls: [mkTool(1)],
      content: '归档后的最终结论',
      createdAt: FRESH_TS
    }, false);
    const fold = document.querySelector('.turn-fold') as HTMLButtonElement;
    expect(fold.getAttribute('aria-disabled')).toBe('true');
    expect(fold.getAttribute('title')).toContain('归档');
    expect(cards()).toBe(0);
    expect(screen.getByText('归档后的最终结论')).toBeTruthy();
    fireEvent.click(fold);
    expect(cards()).toBe(0);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
  });

  it('归档消息携带旧 parts 时也不会重新挂载工具和思考卡', () => {
    mountMsg({
      id: 'archived-parts',
      role: 'assistant',
      archived: true,
      archivedTools: [{ id: 'archived-tool', name: 'sessions.list', status: 'ok' }],
      parts: [
        { kind: 'thinking', text: '已归档思考' },
        { kind: 'tool', toolCall: mkTool(9) },
        { kind: 'text', text: '归档正文' }
      ],
      content: '归档正文',
      createdAt: FRESH_TS
    }, false);
    const fold = document.querySelector('.turn-fold') as HTMLButtonElement;
    expect(fold.getAttribute('aria-disabled')).toBe('true');
    expect(cards()).toBe(0);
    expect(screen.getByText('归档正文')).toBeTruthy();
    fireEvent.click(fold);
    expect(cards()).toBe(0);
  });
});

/** ChatTranscript 按 createdAt 自动判定衰减并下发 staleTurn（接线守卫） */
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

function transcriptMsg(id: string, createdAt: number, role: 'user' | 'assistant' = 'assistant'): Src {
  const base: Src = { id, role, content: id, createdAt };
  if (role === 'assistant') {
    base.parts = [{ kind: 'tool', toolCall: mkTool(1) }, { kind: 'text', text: `${id} 结论` }];
  }
  return base;
}

describe('时间衰减：ChatTranscript 接线（按 createdAt 判定）', () => {
  it('超期 assistant 自动转归档态；近期 assistant 可展开', () => {
    render(
      <ChatTranscript
        messages={[transcriptMsg('old', OLD_TS), transcriptMsg('fresh', FRESH_TS), transcriptMsg('next', FRESH_TS, 'user')]}
        busy={false}
        sessionId="s-stale"
        model={model}
      />
    );
    const folds = document.querySelectorAll('.turn-fold');
    expect(folds.length).toBe(2);
    const [oldFold, freshFold] = [...folds] as HTMLButtonElement[];
    expect(oldFold.closest('[data-mid]')?.getAttribute('data-mid')).toBe('old');
    expect(oldFold.classList.contains('is-stale')).toBe(true);
    expect(freshFold.classList.contains('is-stale')).toBe(false);
    // 超期的两张形态都不给开：点击后工具卡仍为 0
    fireEvent.click(oldFold);
    expect(document.querySelectorAll('.tool-call-block').length).toBe(0);
    fireEvent.click(freshFold);
    openToolGroup(freshFold.closest('[data-mid]') ?? document);
    expect(document.querySelectorAll('.tool-call-block').length).toBeGreaterThan(0);
  });

  it('缺 ts（createdAt=0）回落近期：不转归档态', () => {
    render(
      <ChatTranscript
        messages={[transcriptMsg('m0', 0), transcriptMsg('next', FRESH_TS, 'user')]}
        busy={false}
        sessionId="s-stale2"
        model={model}
      />
    );
    const fold = document.querySelector('.turn-fold') as HTMLButtonElement;
    expect(fold).toBeTruthy();
    expect(fold.classList.contains('is-stale')).toBe(false);
  });
});
