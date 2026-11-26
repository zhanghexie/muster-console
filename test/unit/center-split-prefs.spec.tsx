import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React, { useState } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultWorkspaceFileConfig } from '../../src/shared/metaAgent';
import { useCenterSplitPrefs } from '../../src/renderer/src/hooks/useCenterSplitPrefs';
import { useWorkspaceFile } from '../../src/renderer/src/hooks/useWorkspaceFile';
import { ErrorTip } from '../../src/renderer/src/components/ErrorTip';
import { currentApiMock } from './helpers/api-mock';

beforeEach(() => dismissTip());

afterEach(() => { vi.useRealTimers(); });

describe('分屏偏好延迟写入的工作区归属', () => {
  it('合并同一工作区的方向与比例，并明确传入该工作区 id', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({ ok: true, config: defaultWorkspaceFileConfig() });
    const error = vi.fn();
    const view = renderHook(() => useCenterSplitPrefs('a', true, patch, error));
    act(() => view.result.current({ dir: 'col' }));
    act(() => { vi.advanceTimersByTime(200); view.result.current({ ratio: 0.65 }); });
    act(() => vi.advanceTimersByTime(399));
    expect(patch).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(patch).toHaveBeenCalledExactlyOnceWith({ centerSplitDir: 'col', centerSplitRatio: 0.65 }, 'a');
    expect(error).not.toHaveBeenCalled();
  });

  it('A 调比例后在 400ms 内切到已 ready 的 B，A pending 不会写入 B', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({ ok: true, config: defaultWorkspaceFileConfig() });
    const view = renderHook(({ id }) => useCenterSplitPrefs(id, true, patch, vi.fn()), { initialProps: { id: 'a' } });
    act(() => view.result.current({ ratio: 0.72 }));
    act(() => vi.advanceTimersByTime(200));
    view.rerender({ id: 'b' });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(patch).not.toHaveBeenCalled();
    act(() => view.result.current({ dir: 'row' }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(patch).toHaveBeenCalledExactlyOnceWith({ centerSplitDir: 'row' }, 'b');
  });

  it('工作区重新加载时取消旧 pending，未就绪与卸载之后不落盘', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({ ok: true, config: defaultWorkspaceFileConfig() });
    const view = renderHook(({ ready }) => useCenterSplitPrefs('a', ready, patch, vi.fn()), { initialProps: { ready: true } });
    act(() => view.result.current({ ratio: 0.3 }));
    view.rerender({ ready: false });
    act(() => view.result.current({ ratio: 0.6 }));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(patch).not.toHaveBeenCalled();
    view.rerender({ ready: true });
    act(() => view.result.current({ dir: 'col' }));
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(patch).not.toHaveBeenCalled();
  });

  it('保存失败通过调用方报告，不留下失效 timer', async () => {
    vi.useFakeTimers();
    const failure = new Error('write failed');
    const patch = vi.fn().mockRejectedValue(failure);
    const report = vi.fn();
    const view = renderHook(() => useCenterSplitPrefs('a', true, patch, report));
    act(() => view.result.current({ ratio: 0.4 }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('配置返回失败回执时报告分屏偏好没有保存', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({ ok: false, config: defaultWorkspaceFileConfig() });
    const report = vi.fn();
    const view = renderHook(() => useCenterSplitPrefs('a', true, patch, report));
    act(() => view.result.current({ ratio: 0.4 }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: '分屏偏好保存失败' }));
  });

  it('分屏写入失败时通过弹出 tip 报告', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({ ok: false, config: defaultWorkspaceFileConfig(), reason: 'write-failed' });
    function Harness(): React.JSX.Element {
      const [error, setError] = useState<string | null>(null);
      const save = useCenterSplitPrefs('a', true, patch, failure => setError((failure as Error).message));
      return <><button onClick={() => save({ ratio: 0.4 })}>调整分屏</button><ErrorTip message={error} /></>;
    }
    const view = render(<><Harness /><AppTipHost /></>);
    fireEvent.click(screen.getByRole('button', { name: '调整分屏' }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole('status').textContent).toContain('分屏偏好保存失败');
    expect(view.container.textContent).not.toContain('分屏偏好保存失败');
  });

  it('切出再切回后，旧写入失败不向当前工作区发出误报', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { ok: boolean; config: ReturnType<typeof defaultWorkspaceFileConfig> }) => void;
    const patch = vi.fn(() => new Promise<{ ok: boolean; config: ReturnType<typeof defaultWorkspaceFileConfig> }>(done => { resolve = done; }));
    const report = vi.fn();
    const view = renderHook(({ id }) => useCenterSplitPrefs(id, true, patch, report), { initialProps: { id: 'a' } });
    act(() => view.result.current({ ratio: 0.4 }));
    await act(async () => { vi.advanceTimersByTime(400); });
    view.rerender({ id: 'b' });
    view.rerender({ id: 'a' });
    await act(async () => { resolve({ ok: false, config: defaultWorkspaceFileConfig() }); });
    expect(report).not.toHaveBeenCalled();
  });
});

describe('workspaceFile.patch 的显式 owner 兜底', () => {
  it('已水合 B 时拒绝来自旧 A 的延迟调用，普通 B 写入仍有效', async () => {
    const api = currentApiMock();
    api.override('workspaceFile.get', () => Promise.resolve({ workspaceId: 'a', config: defaultWorkspaceFileConfig() }));
    const view = renderHook(() => useWorkspaceFile());
    await act(async () => {});
    expect(view.result.current.workspaceId).toBe('a');
    api.override('workspaceFile.get', () => Promise.resolve({ workspaceId: 'b', config: defaultWorkspaceFileConfig() }));
    await act(async () => { api.emit('workspaces:changed', {}); });
    expect(view.result.current.ready).toBe(true);
    expect(view.result.current.workspaceId).toBe('b');
    let stale!: Awaited<ReturnType<typeof view.result.current.patch>>;
    await act(async () => { stale = await view.result.current.patch({ centerSplitRatio: 0.7 }, 'a'); });
    expect(stale).toMatchObject({ ok: false, reason: 'stale-owner' });
    expect(api.mockOf('workspaceFile.patch')).not.toHaveBeenCalled();
    await act(async () => { await view.result.current.patch({ centerSplitRatio: 0.45 }, 'b'); });
    expect(api.mockOf('workspaceFile.patch')).toHaveBeenCalledExactlyOnceWith({ centerSplitRatio: 0.45 }, 'b');
  });

  it('主进程确认所属工作区已过期时，不当作写盘失败', async () => {
    const api = currentApiMock();
    api.override('workspaceFile.get', () => Promise.resolve({ workspaceId: 'a', config: defaultWorkspaceFileConfig() }));
    api.override('workspaceFile.patch', async () => ({ ok: false, stale: true }));
    const view = renderHook(() => useWorkspaceFile());
    await act(async () => {});
    let outcome!: Awaited<ReturnType<typeof view.result.current.patch>>;
    await act(async () => { outcome = await view.result.current.patch({ centerSplitRatio: 0.7 }, 'a'); });
    expect(outcome).toMatchObject({ ok: false, reason: 'stale-owner' });
  });

  it('A 的写入已经发出后切到 B，迟到的 A 响应不会覆盖 B 配置', async () => {
    const api = currentApiMock();
    api.override('workspaceFile.get', () => Promise.resolve({ workspaceId: 'a', config: defaultWorkspaceFileConfig() }));
    let complete!: (result: unknown) => void;
    api.override('workspaceFile.patch', () => new Promise(resolve => { complete = resolve; }));
    const view = renderHook(() => useWorkspaceFile());
    await act(async () => {});
    let write!: ReturnType<typeof view.result.current.patch>;
    act(() => { write = view.result.current.patch({ centerSplitRatio: 0.72 }, 'a'); });
    const bConfig = { ...defaultWorkspaceFileConfig(), centerSplitRatio: 0.35 };
    api.override('workspaceFile.get', () => Promise.resolve({ workspaceId: 'b', config: bConfig }));
    await act(async () => { api.emit('workspaces:changed', {}); });
    let outcome!: Awaited<typeof write>;
    await act(async () => {
      complete({ ok: true, workspaceId: 'a', config: { ...defaultWorkspaceFileConfig(), centerSplitRatio: 0.72 } });
      outcome = await write;
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'stale-owner' });
    expect(api.mockOf('workspaceFile.patch')).toHaveBeenCalledExactlyOnceWith({ centerSplitRatio: 0.72 }, 'a');
    expect(view.result.current.workspaceId).toBe('b');
    expect(view.result.current.cfg.centerSplitRatio).toBe(0.35);
  });

  it('切区后旧写入抛出的错误按过期处理，不向新工作区冒泡', async () => {
    const api = currentApiMock();
    api.override('workspaceFile.get', () => Promise.resolve({ workspaceId: 'a', config: defaultWorkspaceFileConfig() }));
    let reject!: (error: Error) => void;
    api.override('workspaceFile.patch', () => new Promise((_resolve, fail) => { reject = fail; }));
    const view = renderHook(() => useWorkspaceFile());
    await act(async () => {});
    const pending = view.result.current.patch({ centerSplitRatio: 0.7 }, 'a').catch(error => error);
    api.override('workspaceFile.get', () => Promise.resolve({ workspaceId: 'b', config: defaultWorkspaceFileConfig() }));
    await act(async () => { api.emit('workspaces:changed', {}); });
    let outcome: unknown;
    await act(async () => { reject(new Error('old write failed')); outcome = await pending; });
    expect(outcome).toMatchObject({ ok: false, reason: 'stale-owner' });
    expect(view.result.current.workspaceId).toBe('b');
  });
});
