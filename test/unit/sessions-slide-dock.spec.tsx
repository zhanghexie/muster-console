import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { SessionsHotZone } from '../../src/renderer/src/components/SessionsHotZone';
import { useSessionsPeekEscape } from '../../src/renderer/src/components/useSessionsPeekEscape';

function EscapeHarness({ open, onClose }: { open: boolean; onClose: () => void }) {
  useSessionsPeekEscape(open, onClose);
  return <input aria-label="搜索" />;
}

describe('折叠左栏划开唤出', () => {
  it('只在左缘热区武装后唤出，关闭期间不会反复唤出', () => {
    const onSummon = vi.fn();
    const { container, rerender } = render(<SessionsHotZone active onSummon={onSummon} />);
    const root = container.querySelector('.sessions-hot-root') as HTMLDivElement;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800
    } as DOMRect);

    fireEvent.pointerMove(window, { clientX: 100, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 400 });
    expect(container.querySelector('.sessions-hot-ghost')).toBeTruthy();
    fireEvent.pointerEnter(container.querySelector('.sessions-hot-ghost')!);
    expect(onSummon).toHaveBeenCalledTimes(1);

    rerender(<SessionsHotZone active={false} onSummon={onSummon} />);
    fireEvent.pointerMove(window, { clientX: 20, clientY: 400 });
    expect(onSummon).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.sessions-hot-ghost-inner')?.getAttribute('data-mp-stage')).toBe('out');
  });

  it('速览收回（active 恢复）后指针仍压检测带内不重现把手，须先离开再进入（sessions-dock F-01）', () => {
    const onSummon = vi.fn();
    const { container, rerender } = render(<SessionsHotZone active onSummon={onSummon} />);
    const root = container.querySelector('.sessions-hot-root') as HTMLDivElement;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800
    } as DOMRect);

    // 武装 → 带内浮现 → 唤出速览
    fireEvent.pointerMove(window, { clientX: 100, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 400 });
    expect(container.querySelector('.sessions-hot-ghost')).toBeTruthy();
    fireEvent.pointerEnter(container.querySelector('.sessions-hot-ghost')!);
    expect(onSummon).toHaveBeenCalledTimes(1);

    // 速览打开 → Escape 收回：active 恢复 true，指针仍压在检测带上（面板原覆盖区域）
    rerender(<SessionsHotZone active={false} onSummon={onSummon} />);
    rerender(<SessionsHotZone active onSummon={onSummon} />);
    // 带内微移：武装已复位，幽灵把手不得重现（旧实现 bandArmedRef 恒 true → stage 回 in）
    fireEvent.pointerMove(window, { clientX: 21, clientY: 401 });
    expect(container.querySelector('.sessions-hot-ghost-inner')?.getAttribute('data-mp-stage')).toBe('out');
    expect(onSummon).toHaveBeenCalledTimes(1);
    // 指针离开检测带再进入：重新武装，把手正常浮现
    fireEvent.pointerMove(window, { clientX: 200, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 400 });
    expect(container.querySelector('.sessions-hot-ghost')).toBeTruthy();
  });
});

describe('速览 Escape', () => {
  it('在全局冒泡拦截前收回，输入框焦点时交给局部取消', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(<EscapeHarness open onClose={onClose} />);
    const swallow = (e: KeyboardEvent) => e.stopPropagation();
    document.addEventListener('keydown', swallow);
    try {
      fireEvent.keyDown(container, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(container.querySelector('input')!, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      rerender(<EscapeHarness open={false} onClose={onClose} />);
      fireEvent.keyDown(container, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', swallow);
    }
  });
});
