import React, { useEffect, useRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { guardVirtualScreenScroll } from '../../src/renderer/src/virtualScreenScrollGuard';

it('切屏和重排不读取祖先滚动布局，实际异常滚动仍归零且卸载释放监听', () => {
  const read = vi.fn(); let left = 0;
  function View({ dock }: { dock: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const node = ref.current!;
      Object.defineProperty(node, 'scrollLeft', { configurable: true, get: () => { read(); return left; }, set: value => { left = value; } });
      return guardVirtualScreenScroll([node, null, node]);
    }, [dock]);
    return <div ref={ref} data-testid="view"><div data-testid="inner" /></div>;
  }
  const { getByTestId, rerender, unmount } = render(<View dock="terminal" />);
  rerender(<View dock="git" />);
  expect(read).not.toHaveBeenCalled();
  left = 16;
  const node = getByTestId('view');
  fireEvent.scroll(node);
  expect(left).toBe(0);
  // The fallback owns its ancestor only, never an inner transcript/editor's offset.
  const inner = getByTestId('inner'); inner.scrollLeft = 24;
  inner.dispatchEvent(new Event('scroll', { bubbles: true }));
  expect(inner.scrollLeft).toBe(24);
  unmount(); left = 30; node.dispatchEvent(new Event('scroll'));
  expect(left).toBe(30);
});
