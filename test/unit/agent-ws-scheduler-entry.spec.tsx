/** 调度回复未读标记与悬浮正文卡：回合收口后提醒，悬浮不清已读，点击才打开。 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SchedulerReplyPreviewCard, schedulerReplyUnreadIds, type SchedulerReplySnapshot } from '../../src/renderer/src/panels/SchedulerReplyBubble';

const snapshots: Record<string, SchedulerReplySnapshot> = {
  alpha: { messageId: 'm-alpha', text: 'Alpha 的最后一段回复正文', busy: false },
  beta: { messageId: 'm-beta', text: 'Beta 的最后一段回复正文', busy: false }
};

const anchor = { left: 20, right: 240, top: 100, bottom: 132, width: 220, height: 32 } as DOMRect;

describe('调度回复悬浮预览', () => {
  it('回合进行中不进入未读提醒，agent:done 后才进入', () => {
    const isUnread = () => true;
    expect(schedulerReplyUnreadIds(['alpha'], { alpha: { ...snapshots.alpha, busy: true } }, isUnread)).toEqual([]);
    expect(schedulerReplyUnreadIds(['alpha'], { alpha: { ...snapshots.alpha, busy: false } }, isUnread)).toEqual(['alpha']);
  });

  it('悬浮卡只显示正文并带入场动画，悬浮本身不清除未读', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<SchedulerReplyPreviewCard open text={snapshots.alpha.text} anchor={anchor}
      onOpen={onOpen} onKeep={vi.fn()} onClose={onClose} />);
    const card = screen.getByRole('dialog', { name: '未读调度回复' });
    expect(card.textContent).toBe('Alpha 的最后一段回复正文');
    expect(card.className).toContain('mp-pop');
    fireEvent.mouseEnter(card);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('离开悬浮卡才请求关闭预览', () => {
    const onClose = vi.fn();
    render(<SchedulerReplyPreviewCard open text="回复" anchor={anchor}
      onOpen={vi.fn()} onKeep={vi.fn()} onClose={onClose} />);
    fireEvent.mouseLeave(screen.getByRole('dialog', { name: '未读调度回复' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('工作区靠近窗口底部时，卡片内容自然撑高且底边对齐胶囊底部', () => {
    const bottomAnchor = { ...anchor, top: 700, bottom: 732 } as DOMRect;
    render(<SchedulerReplyPreviewCard open text="回复" anchor={bottomAnchor}
      onOpen={vi.fn()} onKeep={vi.fn()} onClose={vi.fn()} />);
    const card = screen.getByRole('dialog', { name: '未读调度回复' });
    const style = card.getAttribute('style') ?? '';
    expect(style).toContain('bottom: 36px');
    expect(style).not.toMatch(/(?:^|;)\s*top:/);
    expect(style).toContain('max-height:');
  });
});
