import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { SessionRailContent } from '../../src/renderer/src/components/SessionRailContent';

function content(editing = false, status = '很长的状态说明'): React.JSX.Element {
  return <SessionRailContent name="很长的会话名称" status={status} statusClassName="session-capsule waiting" editing={editing}>
    {editing ? <input aria-label="重命名" /> : <span className="session-name"><span className="session-name-text">很长的会话名称</span><span className="fixture-badge">隔离</span></span>}
  </SessionRailContent>;
}

describe('会话名称与胶囊固定单行', () => {
  it('长名称与状态悬浮、聚焦和点击都不再展开或遮住对方', () => {
    const { container } = render(content());
    const name = container.querySelector('.session-rail-name')!;
    const status = container.querySelector('.session-rail-status')!;
    for (const field of [name, status]) {
      fireEvent.pointerEnter(field); fireEvent.focus(field); fireEvent.click(field);
      expect(field.getAttribute('aria-expanded')).toBeNull();
      expect(field.getAttribute('data-open')).toBeNull();
      expect(field.getAttribute('role')).toBeNull();
    }
    expect(container.querySelector('[inert], .session-rail-name-expanded, .session-rail-status-expanded')).toBeNull();
    expect(name.textContent).toContain('很长的会话名称');
    expect(status.textContent).toBe('很长的状态说明');
  });
  it('不再为悬浮展开订阅尺寸或同步读取文字布局', () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const { rerender } = render(content());
    rerender(content());
    expect(bounds).not.toHaveBeenCalled();
    bounds.mockRestore();
  });
  it('重命名时胶囊让位，退出重命名恢复', () => {
    const { container, rerender } = render(content(true));
    expect(container.querySelector('input')).toBeTruthy();
    expect(container.querySelector('.session-rail-status')).toBeNull();
    rerender(content());
    expect(container.querySelector('.session-rail-status')).toBeTruthy();
  });
  it('已读隐藏时不留下状态占位，也不为名称添加额外的交互焦点', () => {
    const { container } = render(content(false, ''));
    expect(container.querySelector('.session-rail-status')).toBeNull();
    expect(container.querySelector('.session-rail-name')?.getAttribute('tabindex')).toBeNull();
  });
});
