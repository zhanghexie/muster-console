/**
 * 统一排队面板·最小化：右上角「收起」缩成胶囊（分段计数），点胶囊展开；
 * 收起偏好记 localStorage（重新挂载仍是胶囊）；队列清空时胶囊也退场。
 * 运行: npx vitest run test/unit/queue-send-panel-minimize.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { QUEUE_PANEL_MINIMIZED_KEY, QueueSendPanel } from '../../src/renderer/src/components/QueueSendPanel';

function props(overrides: Partial<React.ComponentProps<typeof QueueSendPanel>> = {}) {
  return {
    autoItems: [
      { id: 'a1', text: '排队一' },
      { id: 'a2', text: '排队二' }
    ],
    manualItems: [{ id: 'm1', text: '手动一' }],
    onSendNow: vi.fn(),
    onEditToDraft: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
    onMoveLane: vi.fn(),
    ...overrides
  };
}

const panel = () => document.querySelector('.agent-composer-qspanel');
const capsule = () => screen.queryByRole('button', { name: '展开排队面板' });

describe('QueueSendPanel 最小化', () => {
  beforeEach(() => localStorage.removeItem(QUEUE_PANEL_MINIMIZED_KEY));

  it('收起 → 胶囊显示分段计数并记住偏好；点胶囊展开', async () => {
    render(<QueueSendPanel {...props()} />);
    expect(panel()).toBeTruthy();
    expect(capsule()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '收起排队面板' }));
    expect(localStorage.getItem(QUEUE_PANEL_MINIMIZED_KEY)).toBe('1');
    const cap = capsule()!;
    expect(cap).toBeTruthy();
    expect(cap.textContent).toContain('自动 2');
    expect(cap.textContent).toContain('待确认 1');
    await waitFor(() => expect(panel()).toBeNull());

    fireEvent.click(cap);
    expect(localStorage.getItem(QUEUE_PANEL_MINIMIZED_KEY)).toBeNull();
    expect(panel()).toBeTruthy();
    await waitFor(() => expect(capsule()).toBeNull());
  });

  it('偏好跨挂载保持：已收起时直接渲染胶囊；只有手动条目时只显示待确认段', () => {
    localStorage.setItem(QUEUE_PANEL_MINIMIZED_KEY, '1');
    render(<QueueSendPanel {...props({ autoItems: [] })} />);
    expect(panel()).toBeNull();
    const cap = capsule()!;
    expect(cap.textContent).not.toContain('自动');
    expect(cap.textContent).toContain('待确认 1');
  });

  it('收起态队列清空：胶囊退场，不留空胶囊', async () => {
    localStorage.setItem(QUEUE_PANEL_MINIMIZED_KEY, '1');
    const { rerender } = render(<QueueSendPanel {...props()} />);
    expect(capsule()).toBeTruthy();
    rerender(<QueueSendPanel {...props({ autoItems: [], manualItems: [] })} />);
    await waitFor(() => expect(capsule()).toBeNull());
  });
});
