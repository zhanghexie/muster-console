/**
 * 折叠历史轮「真卸载」契约（2026-09-15 转录虚拟化讨论落地）：
 * 真机普查：切到重会话（单回合 277 工具卡）首开 212ms，主因是折叠态条目
 * 仍全部挂载（旧实现 display:none 视觉折叠、保卡内状态）。产品决策：折叠=
 * 真卸载（接受卡内瞬态复位），展开由 ToolCallStack 分批渐进挂载。契约：
 * 1) 折叠历史轮不挂载工具卡/思考/中间正文，只保留折叠头与最后一段正文；
 * 2) 展开后先挂首屏量、随后帧批次补齐全部卡（不丢卡）；
 * 3) 纯正文消息不折叠（无折叠头则中间正文绝不能藏——保住展开入口语义）；
 * 4) legacy 扁平字段路径（thinking/toolCalls/content）同构。
 * 2026-10-31 追加：折叠头置顶（回合内容最前，不再是首个可折叠条目位置）+
 * 展开/收起 acc 折叠体动画（0fr↔1fr+opacity 纯 transition；稳态收起 wrapper
 * 不挂载，真卸载契约不变；收起瞬态经 presence 延迟卸载播完退场）。
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import type { ChatDisplayPart, ChatMessage, ToolCallRecord } from '../../src/shared/types';

const mkTool = (i: number): ToolCallRecord => ({
  id: `t${i}`,
  name: 'sessions.list',
  arguments: '{}',
  result: '{"ok":true}',
  status: 'ok'
});

const cards = (): number => document.querySelectorAll('.tool-call-block').length;
const openToolGroups = (root: ParentNode = document): void => {
  root.querySelectorAll<HTMLDetailsElement>('.tool-call-group-details').forEach((group) => {
    if (!group.open) fireEvent.click(group.querySelector('summary')!);
  });
};

function mountMsg(msg: Partial<ChatMessage> & { id: string; role: 'user' | 'assistant' }) {
  const full: ChatMessage = {
    content: '',
    createdAt: Date.now(),
    ...msg
  } as ChatMessage;
  return render(
    <ChatMessageView message={full} streaming={false} timeLabel="" quiet collapsedTurn />
  );
}

/** 等待若干 rAF 帧让渐进挂载预算走完（jsdom rAF 由真实定时器驱动） */
const flushFrames = async (ms = 250): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

describe('折叠历史轮真卸载（性能回归）', () => {
  it('虚拟行卸载后保留本会话的展开选择，手动关闭后不再复活', async () => {
    const message: ChatMessage = { id: 'virtual-fold', role: 'assistant', createdAt: Date.now(), content: '结论', toolCalls: [mkTool(1)] };
    const view = () => <ChatMessageView message={message} collapsedTurn transcriptKey="fold-memory-test" />;
    const first = render(view());
    fireEvent.click(first.container.querySelector('.turn-fold')!);
    openToolGroups(first.container);
    await flushFrames();
    expect(cards()).toBe(1);
    first.unmount();
    const second = render(view());
    openToolGroups(second.container);
    await flushFrames();
    expect(cards()).toBe(1);
    fireEvent.click(second.container.querySelector('.turn-fold')!);
    second.unmount();
    const third = render(view());
    expect(cards()).toBe(0);
    third.rerender(<ChatMessageView message={message} collapsedTurn transcriptKey="fold-memory-test-next" />);
    fireEvent.click(third.container.querySelector('.turn-fold')!);
    openToolGroups(third.container);
    third.unmount();
    const fourth = render(<ChatMessageView message={message} collapsedTurn transcriptKey="fold-memory-test-next" />);
    openToolGroups(fourth.container);
    await flushFrames();
    expect(cards()).toBe(1);
    fourth.unmount();
  });
  it('parts 路径：折叠态不挂载工具卡与思考，保留折叠头与最后一段正文', () => {
    const parts: ChatDisplayPart[] = [
      { kind: 'thinking', text: '盘算一下' },
      ...Array.from({ length: 100 }, (_, i) => mkTool(i)).map<ChatDisplayPart>((toolCall) => ({
        kind: 'tool',
        toolCall
      })),
      { kind: 'text', text: '开头说明' },
      { kind: 'text', text: '最终结论' }
    ];
    mountMsg({ id: 'm1', role: 'assistant', parts });
    expect(cards()).toBe(0); // 卡一张都不挂
    expect(document.querySelectorAll('.tool-lite-stack').length).toBe(0);
    expect(document.querySelector('.turn-fold')).toBeTruthy(); // 折叠头在场
    expect(document.querySelector('.turn-fold-label')?.textContent).toContain('100');
    expect(screen.getByText('最终结论')).toBeTruthy(); // 最后一段正文保留
    expect(screen.queryByText('开头说明')).toBeNull(); // 中间正文卸载
  });

  it('展开：先挂首屏量，帧批次补齐全部卡（不丢卡）', async () => {
    const parts: ChatDisplayPart[] = [
      ...Array.from({ length: 100 }, (_, i) => mkTool(i)).map<ChatDisplayPart>((toolCall) => ({
        kind: 'tool',
        toolCall
      })),
      { kind: 'text', text: '完' }
    ];
    mountMsg({ id: 'm2', role: 'assistant', parts });
    fireEvent.click(document.querySelector('.turn-fold')!);
    openToolGroups();
    const first = cards();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(40); // 首屏量起挂，不一次性全挂
    await flushFrames();
    expect(cards()).toBe(100); // 帧批次补齐，一张不丢
  });

  it('纯正文消息：没有折叠头，中间正文绝不能藏', () => {
    const parts: ChatDisplayPart[] = [
      { kind: 'text', text: '段一' },
      { kind: 'text', text: '段二' }
    ];
    mountMsg({ id: 'm3', role: 'assistant', parts });
    expect(document.querySelector('.turn-fold')).toBeNull();
    expect(screen.getByText('段一')).toBeTruthy();
    expect(screen.getByText('段二')).toBeTruthy();
  });

  it('legacy 路径：thinking/toolCalls 折叠卸载，content 保留', () => {
    mountMsg({
      id: 'm4',
      role: 'assistant',
      thinking: '想了想',
      toolCalls: [mkTool(1), mkTool(2), mkTool(3)],
      content: '答案'
    });
    expect(cards()).toBe(0);
    expect(document.querySelector('.turn-fold-label')?.textContent).toContain('3');
    expect(screen.getByText('答案')).toBeTruthy();
    expect(screen.queryByText('想了想')).toBeNull();
  });
});

const motionState = vi.hoisted(() => ({ reduced: false }));
vi.mock('../../src/renderer/src/interactionPreferences', () => ({
  getInteractionPreferences: () => ({ scrollFeel: 'native', scrollDistance: 1, motion: 'system' }),
  prefersReducedMotionPreference: () => motionState.reduced,
  subscribeInteractionPreferences: () => () => {}
}));

describe('折叠头置顶与展开/收起动画（2026-10-31）', () => {
  it('折叠头在回合内容最前（不在第一段正文下面），展开后仍在最前', () => {
    const parts: ChatDisplayPart[] = [
      { kind: 'text', text: '开场白' },
      ...[mkTool(1), mkTool(2)].map((toolCall) => ({ kind: 'tool' as const, toolCall })),
      { kind: 'text', text: '结论' }
    ];
    mountMsg({ id: 'top', role: 'assistant', parts });
    const body = document.querySelector('.chat-body')!;
    expect(body.firstElementChild!.classList.contains('turn-fold')).toBe(true); // 头置顶
    expect(screen.getByText('结论')).toBeTruthy(); // 折叠态只留末段正文
    expect(screen.queryByText('开场白')).toBeNull();
    fireEvent.click(document.querySelector('.turn-fold')!);
    expect(body.firstElementChild!.classList.contains('turn-fold')).toBe(true); // 展开后仍在最前
    expect(document.querySelector('.turn-fold-body')!.querySelector('.chat-text')?.textContent).toContain('开场白');
  });

  it('展开挂 acc 折叠体（is-open），卡片在折叠体内渐进补齐', async () => {
    const parts: ChatDisplayPart[] = [
      ...Array.from({ length: 50 }, (_, i) => mkTool(i)).map((toolCall) => ({
        kind: 'tool' as const,
        toolCall
      })),
      { kind: 'text', text: '完' }
    ];
    mountMsg({ id: 'acc', role: 'assistant', parts });
    expect(document.querySelector('.turn-fold-body')).toBeNull(); // 稳态收起不挂载 wrapper
    fireEvent.click(document.querySelector('.turn-fold')!);
    openToolGroups();
    const wrap = document.querySelector('.turn-fold-body')!;
    expect(wrap.classList.contains('acc')).toBe(true); // acc 骨架在场
    expect(wrap.classList.contains('is-open')).toBe(true);
    expect(wrap.querySelector('.tool-call-block')).toBeTruthy(); // 卡在折叠体内
    await flushFrames();
    expect(wrap.querySelectorAll('.tool-call-block').length).toBe(50); // 渐进补齐不丢卡
  });

  it('收起：退场窗口内内容仍在（播完动画），退场后真卸载恢复', async () => {
    const parts: ChatDisplayPart[] = [
      ...Array.from({ length: 45 }, (_, i) => mkTool(i)).map((toolCall) => ({
        kind: 'tool' as const,
        toolCall
      })),
      { kind: 'text', text: '结论' }
    ];
    mountMsg({ id: 'exit', role: 'assistant', parts });
    fireEvent.click(document.querySelector('.turn-fold')!);
    openToolGroups();
    await flushFrames(); // 展开补齐
    expect(cards()).toBe(45);
    fireEvent.click(document.querySelector('.turn-fold')!); // 收起
    expect(cards()).toBeGreaterThan(0); // presence 延迟卸载：退场动画期间内容仍在
    expect(document.querySelector('.turn-fold-body')).toBeTruthy();
    expect(document.querySelector('.turn-fold-body')!.classList.contains('is-open')).toBe(false);
    await flushFrames(400); // exitMs(200ms)+80ms 兜底之后
    expect(cards()).toBe(0); // 真卸载恢复
    expect(document.querySelector('.turn-fold-body')).toBeNull();
    expect(screen.getByText('结论')).toBeTruthy(); // 末段正文始终在场
  });

  it('减少动态：展开/收起即时，无退场窗口', () => {
    motionState.reduced = true;
    try {
      const parts: ChatDisplayPart[] = [
        ...[mkTool(1), mkTool(2), mkTool(3)].map((toolCall) => ({ kind: 'tool' as const, toolCall })),
        { kind: 'text', text: '完' }
      ];
      mountMsg({ id: 'reduced', role: 'assistant', parts });
      fireEvent.click(document.querySelector('.turn-fold')!);
      expect(document.querySelector('.turn-fold-body')!.classList.contains('is-open')).toBe(true);
      fireEvent.click(document.querySelector('.turn-fold')!);
      expect(cards()).toBe(0); // 立即卸载，不等退场
      expect(document.querySelector('.turn-fold-body')).toBeNull();
    } finally {
      motionState.reduced = false;
    }
  });

  it('CSS 骨架在场：.turn-fold-body .acc-body 间距规则（回滚开关自检）', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    const css = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/src/styles/chat.css'),
      'utf8'
    );
    expect(css).toContain('.turn-fold-body .acc-body');
  });
});

describe('评审修复回归（2026-10-31）', () => {
  it('执行中的工具栈不参与折叠：收起态仍可见，且不计入折叠头', async () => {
    const parts: ChatDisplayPart[] = [
      { kind: 'text', text: '前导' },
      { kind: 'tool', toolCall: { ...mkTool(1), status: 'running' } },
      { kind: 'text', text: '中段' },
      { kind: 'tool', toolCall: mkTool(2) },
      { kind: 'text', text: '结论' }
    ];
    mountMsg({ id: 'running', role: 'assistant', parts });
    expect(document.querySelector('.turn-fold-label')?.textContent).toContain('1'); // 只计已完成
    expect(cards()).toBe(0); // 执行中的分组默认收起，外层摘要保持可见
    const liveGroup = document.querySelector<HTMLDetailsElement>('.tool-call-group-details')!;
    expect(liveGroup).toBeTruthy();
    fireEvent.click(liveGroup.querySelector('summary')!);
    expect(cards()).toBe(1);
    expect(document.querySelector('.tool-card.running')).toBeTruthy();
    expect(screen.queryByText('前导')).toBeNull(); // 可折叠前缀照旧隐藏
    fireEvent.click(document.querySelector('.turn-fold')!);
    openToolGroups();
    await flushFrames();
    expect(cards()).toBe(2); // 展开可见全部
  });

  it('审批卡切段：折叠头计数为整回合合计且不落在空段', () => {
    const parts: ChatDisplayPart[] = [
      { kind: 'text', text: '开场' },
      ...[mkTool(1), mkTool(2)].map((toolCall) => ({ kind: 'tool' as const, toolCall })),
      { kind: 'text', text: '结论' }
    ];
    const message = {
      id: 'seg', role: 'assistant', createdAt: Date.now(), content: '', parts
    } as unknown as ChatMessage;
    render(
      <ChatMessageView
        message={message}
        streaming={false}
        timeLabel=""
        quiet
        collapsedTurn
        inlineApproval={<div data-approval>审批卡</div>}
        approvalAnchor={1}
      />
    );
    const folds = document.querySelectorAll('.turn-fold');
    expect(folds.length).toBe(1); // 只一个折叠头
    expect(folds[0]!.querySelector('.turn-fold-label')?.textContent).toContain('2'); // 整回合合计
  });
});
