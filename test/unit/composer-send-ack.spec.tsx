import React from 'react';
import { it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { StoreProvider } from '../../src/renderer/src/store';

it.each(['accepted', 'rejected', 'error'] as const)('发送确认 %s 后停止动效，即使回合仍 busy；失败保留草稿', async outcome => {
  let resolve!: (v: boolean) => void;
  let reject!: (e: Error) => void;
  const onSend = vi.fn(() => new Promise<boolean>((yes, no) => { resolve = yes; reject = no; }));
  const props = { workspaceId: 'ack-test', surfaceKind: 'gui-session' as const, onSend, onClear: async () => {}, onStop: vi.fn() };
  const view = (busy: boolean) => <StoreProvider><AgentComposer {...props} busy={busy} /></StoreProvider>;
  const { container, rerender } = render(view(false));
  const editor = screen.getByRole('textbox');
  editor.textContent = 'hello'; fireEvent.input(editor);
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(screen.getByRole('button', { name: '发送中' }).getAttribute('aria-busy')).toBe('true');
  expect(container.querySelector('.brand-loader-core')).toBeTruthy();
  expect(container.querySelector('.brand-loader rect')).toBeNull();
  fireEvent.keyDown(editor, { key: 'Enter' });
  expect(onSend).toHaveBeenCalledTimes(1);
  rerender(view(true));
  expect(screen.getByRole('button', { name: '发送中' })).toBeTruthy();
  await act(async () => { outcome === 'error' ? reject(new Error('offline')) : resolve(outcome === 'accepted'); });
  await waitFor(() => expect(container.querySelector('.brand-loader')).toBeNull());
  expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
  expect(editor.textContent).toBe(outcome === 'accepted' ? '' : 'hello');
});
