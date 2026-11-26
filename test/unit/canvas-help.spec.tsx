import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CanvasHelp } from '../../src/renderer/src/panels/freeCanvas/CanvasControls';

it('操作说明默认隐藏，点击问号展开，再点关闭，退场后卸载', async () => {
  render(<CanvasHelp hint="拖动框选，滚轮缩放" />);
  const button = screen.getByRole('button', { name: '操作说明' });
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.mouseEnter(button);
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('note').textContent).toContain('滚轮缩放');
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  await waitFor(() => expect(screen.queryByText('拖动框选，滚轮缩放')).toBeNull());
});

it('点击外部或 Escape 关闭，Escape 恢复按钮焦点', () => {
  render(<CanvasHelp hint="操作提示" />);
  const button = screen.getByRole('button', { name: '操作说明' });
  fireEvent.click(button);
  fireEvent.pointerDown(document.body);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(button);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
});
