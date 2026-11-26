import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceFileRef } from '../../src/shared/types';
import { createApiMock, type ApiMock } from './helpers/api-mock';

const transport = vi.hoisted(() => ({ snapshot: { connected: true, note: '' }, listeners: new Set<() => void>() }));
vi.mock('../../src/renderer/src/webGatewayStatus', () => ({
  getWebGatewayStatus: () => transport.snapshot,
  subscribeWebGatewayStatus: (listener: () => void) => { transport.listeners.add(listener); return () => transport.listeners.delete(listener); }
}));
import { useFileRootUse } from '../../src/renderer/src/hooks/useFileRootUse';
let api: ApiMock;
const a = { workspaceId: 'ws', rootId: 'a', relativePath: 'same.txt' };
const b = { ...a, rootId: 'b' };
function View({ fileRef, hidden = false }: { fileRef: WorkspaceFileRef | null; hidden?: boolean }) {
  const use = useFileRootUse(fileRef);
  return <output style={{ visibility: hidden ? 'hidden' : 'visible' }}>{JSON.stringify(use)}</output>;
}
const current = () => JSON.parse(screen.getByRole('status', { hidden: true }).textContent!);
beforeEach(() => { api = createApiMock(); window.api = api.api; transport.snapshot = { connected: true, note: '' }; });

it('隐藏视图/改名/排序不释放；切文件和卸载释放原来的视图身份', async () => {
  const view = render(<View fileRef={b} />);
  await waitFor(() => expect(current().ready).toBe(true));
  const idB = api.mockOf('fs.openFile').mock.calls[0][1];
  expect(api.mockOf('fs.openFile')).toHaveBeenCalledWith(b, idB);
  view.rerender(<View fileRef={{ ...b }} hidden />);
  expect(api.mockOf('fs.openFile')).toHaveBeenCalledOnce();
  expect(api.mockOf('fs.closeFile')).not.toHaveBeenCalled();
  view.rerender(<View fileRef={a} />);
  await waitFor(() => expect(api.mockOf('fs.openFile')).toHaveBeenCalledTimes(2));
  expect(api.mockOf('fs.closeFile')).toHaveBeenCalledWith(idB);
  const idA = api.mockOf('fs.openFile').mock.calls[1][1]; expect(idA).not.toBe(idB);
  view.unmount(); expect(api.mockOf('fs.closeFile')).toHaveBeenLastCalledWith(idA);
});

it('晚到的旧打开/关闭结果不能覆盖新文件或解除新登记', async () => {
  let finishA!: (result: { ok: boolean; error?: string }) => void;
  api.override('fs.openFile', async (ref: WorkspaceFileRef) => ref.rootId === 'a' ? new Promise(resolve => { finishA = resolve; }) : { ok: true });
  const view = render(<View fileRef={a} />);
  const idA = api.mockOf('fs.openFile').mock.calls[0][1];
  view.rerender(<View fileRef={b} />);
  await waitFor(() => expect(current().ready).toBe(true));
  await act(async () => finishA({ ok: false, error: 'stale a' }));
  expect(current()).toEqual({ ready: true, error: '' });
  expect(api.mockOf('fs.closeFile')).toHaveBeenCalledOnce();
  expect(api.mockOf('fs.closeFile')).toHaveBeenCalledWith(idA);
});

it('断线时不可写，重连按原 FileRef 重新登记；失败保持错误而不切默认根', async () => {
  render(<View fileRef={b} />);
  await waitFor(() => expect(current().ready).toBe(true));
  act(() => { transport.snapshot = { connected: false, note: 'offline' }; for (const listener of transport.listeners) listener(); });
  expect(current().ready).toBe(false);
  expect(api.mockOf('fs.closeFile')).toHaveBeenCalledOnce();
  api.override('fs.openFile', async () => ({ ok: false, error: 'source folder removed' }));
  act(() => { transport.snapshot = { connected: true, note: '' }; for (const listener of transport.listeners) listener(); });
  await waitFor(() => expect(current().error).toBe('source folder removed'));
  expect(current().ready).toBe(false);
  expect(api.mockOf('fs.openFile')).toHaveBeenLastCalledWith(b, expect.any(String));
});

it('远程 HTTP 环境没有 randomUUID 时仍可恢复文件视图并释放其登记', async () => {
  const previous = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const view = render(<View fileRef={b} />);
    await waitFor(() => expect(current().ready).toBe(true));
    const viewId = api.mockOf('fs.openFile').mock.calls[0][1];
    expect(viewId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    view.unmount();
    expect(api.mockOf('fs.closeFile')).toHaveBeenCalledWith(viewId);
  } finally {
    if (previous) Object.defineProperty(crypto, 'randomUUID', previous);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  }
});
