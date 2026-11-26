import { renderWithAppTips as render, getAppTip } from './helpers/app-tips';
import React from 'react';
import { it, expect, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { OperationButton } from '../../src/renderer/src/components/OperationButton';
import { FileDiffView } from '../../src/renderer/src/panels/FileDiffView';
import { CommitBar } from '../../src/renderer/src/panels/gitpanel/CommitBar';

it.each([true, false])('只在被点击操作等待期间显示；成功=%s 后结束，失败保留提示', async success => {
  let finish!: () => void; let fail!: (e: Error) => void;
  const action = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
  const { container } = render(<><OperationButton onAction={action}>刷新</OperationButton><OperationButton onAction={action}>其他操作</OperationButton></>);
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(action).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('.brand-loader')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '其他操作' }).getAttribute('aria-busy')).toBeNull();
  await act(async () => success ? finish() : fail(new Error('网络失败')));
  expect(container.querySelector('.brand-loader')).toBeNull();
  if (!success) expect(getAppTip().textContent).toContain('网络失败');
});

it('Diff 读取只显示一处动效，读取完成后恢复内容空态', () => {
  const { container, rerender } = render(<FileDiffView diffText="" loading />);
  expect(container.querySelectorAll('.brand-loader')).toHaveLength(1);
  expect(screen.queryByText('无差异')).toBeNull();
  rerender(<FileDiffView diffText="" />);
  expect(container.querySelector('.brand-loader')).toBeNull();
  expect(screen.getByText('无差异')).toBeTruthy();
});

it('Commit 的共享 busy 禁用不产生假动效，只有实际提交在等待时显示', async () => {
  let finish!: (ok: boolean) => void;
  const onCommit = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const draftRef = { current: 'fix' };
  const { container, rerender } = render(<CommitBar busy draftRef={draftRef} onCommit={onCommit} />);
  expect(container.querySelector('.brand-loader')).toBeNull();
  rerender(<CommitBar busy={false} draftRef={draftRef} onCommit={onCommit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
  expect(container.querySelectorAll('.brand-loader')).toHaveLength(1);
  await act(async () => finish(false));
  expect(container.querySelector('.brand-loader')).toBeNull();
  expect(draftRef.current).toBe('fix');
});
