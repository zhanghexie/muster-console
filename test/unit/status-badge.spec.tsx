import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatusBadge } from '../../src/renderer/src/components/StatusBadge';

describe('共享状态展示', () => {
  it('原样显示调用方的状态，不推导或替换文案', () => {
    const { container, rerender } = render(<StatusBadge label="等待方案验收" />);
    const badge = container.querySelector('.status-badge')!;
    expect(badge.classList.contains('session-capsule')).toBe(true);
    expect(badge.getAttribute('data-status-attention')).toBeNull();
    expect(screen.getByText('等待方案验收')).toBeTruthy();
    rerender(<StatusBadge label="需你确认部署" attention />);
    expect(badge.getAttribute('data-status-attention')).toBe('true');
    expect(screen.getByText('需你确认部署')).toBeTruthy();
  });

  it('调度点击留在外壳，禁用后不会触发；Badge不创建嵌套按钮', () => {
    const open = vi.fn();
    const { container, rerender } = render(<button onClick={open}><StatusBadge label="空闲" /></button>);
    fireEvent.click(screen.getByText('空闲'));
    expect(open).toHaveBeenCalledTimes(1);
    rerender(<button disabled onClick={open}><StatusBadge label="空闲" /></button>);
    fireEvent.click(screen.getByText('空闲'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('会话长状态可复用稳定内容层、ref 与键盘事件', () => {
    const ref = React.createRef<HTMLSpanElement>();
    const key = vi.fn();
    const { container } = render(
      <StatusBadge ref={ref} className="session-capsule session-rail-status waiting" role="button" tabIndex={0}
        aria-label="等待完整审阅" onKeyDown={key}>
        <span className="session-rail-status-label">等待完整审阅</span>
        <span className="session-rail-status-expanded" aria-hidden="true">完整状态</span>
      </StatusBadge>
    );
    expect(ref.current).toBe(container.firstElementChild);
    expect(ref.current?.className.match(/\bsession-capsule\b/g)).toHaveLength(1);
    expect(ref.current?.querySelector('.session-rail-status-expanded')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: '等待完整审阅' }), { key: 'Enter' });
    expect(key).toHaveBeenCalledTimes(1);
  });
});
