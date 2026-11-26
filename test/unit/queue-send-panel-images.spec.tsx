/**
 * 统一排队面板·带图条目：角标展示 + 「立即」禁用（steer 不带图，带图消息只能排队自动发）。
 * 回归：去掉 imageCount 角标或恢复「立即」对带图行可点，本文件转红。
 * 运行: npx vitest run test/unit/queue-send-panel-images.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { QUEUE_PANEL_MINIMIZED_KEY, QueueSendPanel } from '../../src/renderer/src/components/QueueSendPanel';

function freshProps(overrides: Partial<React.ComponentProps<typeof QueueSendPanel>> = {}) {
  return {
    autoItems: [] as Array<{
      id: string;
      text: string;
      imageCount?: number;
      imagePreviews?: Array<{ id: string; url: string; name?: string }>;
    }>,
    manualItems: [] as Array<{
      id: string;
      text: string;
      imageCount?: number;
      imagePreviews?: Array<{ id: string; url: string; name?: string }>;
    }>,
    onSendNow: vi.fn(),
    onEditToDraft: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
    onMoveLane: vi.fn(),
    ...overrides
  };
}

describe('QueueSendPanel 带图条目', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(QUEUE_PANEL_MINIMIZED_KEY);
  });

  it('带图排队条目显示张数角标，纯文本条目不显示', () => {
    const props = freshProps({
      autoItems: [
        { id: 'q1', text: '带图消息', imageCount: 2 },
        { id: 'q2', text: '纯文本消息' }
      ]
    });
    render(<QueueSendPanel {...props} />);
    expect(screen.getByTitle('含 2 张图片')).toBeTruthy();
    expect(screen.getByText('🖼 2')).toBeTruthy();
    expect(screen.queryByText(/🖼/)).toBeTruthy();
    // 纯文本行没有角标
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBe(2);
    expect(rows[1]!.querySelector('.agent-composer-qsrow-img')).toBeNull();
  });

  it('带图行「立即」禁用且不触发 onSendNow', () => {
    const props = freshProps({
      autoItems: [{ id: 'q1', text: '带图消息', imageCount: 1 }]
    });
    render(<QueueSendPanel {...props} />);
    const btn = screen.getByRole('button', { name: '立即发送' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(props.onSendNow).not.toHaveBeenCalled();
  });

  it('纯文本行「立即」仍可点', () => {
    const props = freshProps({
      autoItems: [{ id: 'q1', text: '纯文本' }]
    });
    render(<QueueSendPanel {...props} />);
    const btn = screen.getByRole('button', { name: '立即发送' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(props.onSendNow).toHaveBeenCalledTimes(1);
  });

  it('缩略图可点开灯箱；「取回编辑」触发 onEditToDraft', () => {
    const props = freshProps({
      autoItems: [
        {
          id: 'q1',
          text: '看图',
          imageCount: 1,
          imagePreviews: [{ id: 'im1', url: 'data:image/png;base64,AAAA', name: 'a.png' }]
        }
      ]
    });
    render(<QueueSendPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '点击查看大图' }));
    // 灯箱挂载（portal）；关闭按钮存在即认为预览打开
    expect(screen.getByRole('button', { name: /关闭|Close/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取回输入框编辑' }));
    expect(props.onEditToDraft).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onEditToDraft).mock.calls[0]![0].id).toBe('q1');
    expect(vi.mocked(props.onEditToDraft).mock.calls[0]![1]).toBe('auto');
  });
});
