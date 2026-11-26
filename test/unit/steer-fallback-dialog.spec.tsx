import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { SteerFallbackDialog } from '../../src/renderer/src/components/agentComposer/SteerFallbackDialog';

it('offers mailbox and interrupt-send choices when native steering is unavailable', () => {
  const onMail = vi.fn();
  const onInterrupt = vi.fn();
  const onCancel = vi.fn();
  render(<SteerFallbackDialog text="请更新状态" onMail={onMail} onInterrupt={onInterrupt} onCancel={onCancel} />);
  expect(screen.getByRole('heading', { name: '当前引擎不支持立即插话' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '发到 AI 邮箱' }));
  fireEvent.click(screen.getByRole('button', { name: '中断后发送' }));
  expect(onMail).toHaveBeenCalledTimes(1);
  expect(onInterrupt).toHaveBeenCalledTimes(1);
});
