import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { BoardColumnScroll } from '../../src/renderer/src/panels/BoardColumnScroll';

it('滚动容器可键盘聚焦并带名称，不再渲染可见或隐藏的滑块', async () => {
  const user = userEvent.setup();
  const view = render(<BoardColumnScroll label="滚动列表"><p>任务一</p><p>任务二</p></BoardColumnScroll>);
  const body = screen.getByRole('region', { name: '滚动列表' });
  expect(body.classList.contains('board-column-body')).toBe(true);
  expect(body.textContent).toContain('任务二');
  expect(view.container.querySelector('.board-column-scroll-thumb')).toBeNull();
  expect(screen.queryByRole('scrollbar', { hidden: true })).toBeNull();
  await user.tab();
  expect(document.activeElement).toBe(body);
});
