/**
 * 发送旁常驻的草稿动作（ComposerDraftCapsules）：
 * - 空草稿禁用而不卸载；空闲无队列只出「留待确认」；忙/已有排队再出「加入自动队列」；
 * - 点击把当前草稿送进对应队列并清空输入（onToManual / onToQueue）。
 * 还原即红：恢复按有无输入挂卸载动作行，或绕过空草稿/输入锁定禁用。
 * 运行: npx vitest run test/unit/composer-draft-capsules.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { ComposerDraftCapsules } from '../../src/renderer/src/components/agentComposer/ComposerDraftCapsules';
import {
  deriveDraftQueueCapsules,
  type DraftQueueCapsuleId
} from '../../src/renderer/src/components/agentComposer/composerHelpers';

function freshProps(overrides: Partial<React.ComponentProps<typeof ComposerDraftCapsules>> = {}) {
  return {
    hasText: true,
    hasImages: false,
    busy: false,
    queuedCount: 0,
    onToManual: vi.fn(),
    onToQueue: vi.fn(),
    ...overrides
  };
}

describe('deriveDraftQueueCapsules 纯推导', () => {
  it('无正文无图 → 空；空闲无队列 → 只手动确认；忙/有排队 → 两项；图-only 也可入手动', () => {
    expect(deriveDraftQueueCapsules({ hasText: false, hasImages: false, busy: true, queuedCount: 1 })).toEqual([]);
    expect(deriveDraftQueueCapsules({ hasText: true, hasImages: false, busy: false, queuedCount: 0 })).toEqual([
      'to-manual'
    ]);
    expect(deriveDraftQueueCapsules({ hasText: true, hasImages: false, busy: true, queuedCount: 0 })).toEqual([
      'to-manual',
      'to-queue'
    ]);
    expect(deriveDraftQueueCapsules({ hasText: true, hasImages: false, busy: false, queuedCount: 2 })).toEqual([
      'to-manual',
      'to-queue'
    ]);
    expect(deriveDraftQueueCapsules({ hasText: true, hasImages: true, busy: true, queuedCount: 0 })).toEqual([
      'to-manual',
      'to-queue'
    ]);
    expect(deriveDraftQueueCapsules({ hasText: false, hasImages: true, busy: false, queuedCount: 0 })).toEqual([
      'to-manual'
    ]);
    expect(deriveDraftQueueCapsules({ hasText: false, hasImages: true, busy: true, queuedCount: 0 })).toEqual([
      'to-manual',
      'to-queue'
    ]);
  });
});

describe('ComposerDraftCapsules 入队建议', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('空闲无队列只显示「手动确认」；点击触发 onToManual', async () => {
    const props = freshProps();
    render(<ComposerDraftCapsules {...props} />);
    await waitFor(() => expect(screen.getByRole('toolbar')).toBeTruthy());
    expect(screen.getByRole('button', { name: '留待确认' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加入自动队列' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '留待确认' }));
    expect(props.onToManual).toHaveBeenCalledTimes(1);
    expect(props.onToQueue).not.toHaveBeenCalled();
  });

  it('已有排队时两项都出；点「排队发送」触发 onToQueue', async () => {
    const props = freshProps({ queuedCount: 1 });
    render(<ComposerDraftCapsules {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '加入自动队列' })).toBeTruthy());
    expect(screen.getByRole('button', { name: '留待确认' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '加入自动队列' }));
    expect(props.onToQueue).toHaveBeenCalledTimes(1);
    expect(props.onToManual).not.toHaveBeenCalled();
  });

  it('空草稿保留动作行；输入和清空只切换禁用态，不挂卸载按钮', () => {
    const props = freshProps({ hasText: false, hasImages: false, busy: true, queuedCount: 1 });
    const { rerender } = render(<ComposerDraftCapsules {...props} />);
    const row = screen.getByRole('toolbar');
    const manual = screen.getByRole('button', { name: '留待确认' }) as HTMLButtonElement;
    const auto = screen.getByRole('button', { name: '加入自动队列' }) as HTMLButtonElement;
    expect(manual.disabled).toBe(true);
    expect(auto.disabled).toBe(true);
    fireEvent.click(manual); fireEvent.click(auto);
    expect(props.onToManual).not.toHaveBeenCalled();
    expect(props.onToQueue).not.toHaveBeenCalled();
    rerender(<ComposerDraftCapsules {...props} hasText />);
    expect(screen.getByRole('toolbar')).toBe(row);
    expect(screen.getByRole('button', { name: '留待确认' })).toBe(manual);
    expect(screen.getByRole('button', { name: '加入自动队列' })).toBe(auto);
    expect(manual.disabled).toBe(false);
    expect(auto.disabled).toBe(false);
    rerender(<ComposerDraftCapsules {...props} />);
    expect(screen.getByRole('toolbar')).toBe(row);
    expect(manual.disabled).toBe(true);
    expect(auto.disabled).toBe(true);
  });

  it('输入锁定时不允许通过辅助按钮入队，解锁后恢复', () => {
    const props = freshProps({ busy: true, disabled: true });
    const { rerender } = render(<ComposerDraftCapsules {...props} />);
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(props.onToManual).not.toHaveBeenCalled();
    expect(props.onToQueue).not.toHaveBeenCalled();
    rerender(<ComposerDraftCapsules {...props} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: '加入自动队列' }));
    expect(props.onToQueue).toHaveBeenCalledTimes(1);
  });

  it('图-only 也出手动确认（清单支持随文图片）', async () => {
    const props = freshProps({ hasText: false, hasImages: true, busy: false, queuedCount: 0 });
    render(<ComposerDraftCapsules {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '留待确认' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: '加入自动队列' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '留待确认' }));
    expect(props.onToManual).toHaveBeenCalledTimes(1);
  });
});
