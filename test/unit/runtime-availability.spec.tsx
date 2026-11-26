import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentRuntimeEntry } from '../../src/shared/types';
import type { RuntimeAvailabilitySnapshot } from '../../src/shared/runtimeAvailability';
import { availableRuntimeEntries, runtimeSelectionAvailable, useRuntimeAvailability } from '../../src/renderer/src/hooks/useRuntimeAvailability';
import { currentApiMock } from './helpers/api-mock';

const worker = { id: 'worker', label: 'Worker', enabled: true, surface: 'pty' } as AgentRuntimeEntry;
const snapshot = (runtimes = [worker], acpAgents: RuntimeAvailabilitySnapshot['acpAgents'] = []): RuntimeAvailabilitySnapshot => ({ runtimes, acpAgents, checkedAt: 1 });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

it('does not probe a closed surface; reopening starts pending and failure cannot expose registry defaults', async () => {
  const api = currentApiMock(); const pending = deferred<RuntimeAvailabilitySnapshot>();
  api.override('runtimes.availability', () => pending.promise);
  const hook = renderHook(({ active }) => useRuntimeAvailability(active), { initialProps: { active: false } });
  act(() => { api.emit('runtimes:changed', []); window.dispatchEvent(new Event('focus')); });
  expect(api.mockOf('runtimes.availability')).not.toHaveBeenCalled();
  hook.rerender({ active: true });
  expect(hook.result.current.ready).toBe(false); expect(hook.result.current.loading).toBe(true);
  await act(async () => pending.reject(new Error('probe failed')));
  expect(hook.result.current.snapshot).toBeNull(); expect(hook.result.current.ready).toBe(false);
  expect(hook.result.current.error).toBe('probe failed');
  api.override('runtimes.availability', async () => snapshot());
  await act(async () => { expect(await hook.result.current.refresh(true)).toEqual(snapshot()); });
  expect(api.mockOf('runtimes.availability')).toHaveBeenLastCalledWith(true);
  expect(hook.result.current.ready).toBe(true);
  hook.rerender({ active: false });
  expect(hook.result.current.snapshot).toEqual(snapshot()); expect(hook.result.current.ready).toBe(false);
  act(() => { api.emit('runtimes:availabilityChanged', {}); window.dispatchEvent(new Event('focus')); });
  expect(api.mockOf('runtimes.availability')).toHaveBeenCalledOnce();
  hook.rerender({ active: true }); expect(hook.result.current.ready).toBe(false); expect(hook.result.current.snapshot).toBeNull();
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
});

it('rejects stale responses immediately when availability is invalidated by broadcasts', async () => {
  vi.useFakeTimers();
  try {
    const api = currentApiMock(); const requests: ReturnType<typeof deferred<RuntimeAvailabilitySnapshot>>[] = [];
    api.override('runtimes.availability', () => { const next = deferred<RuntimeAvailabilitySnapshot>(); requests.push(next); return next.promise; });
    const hook = renderHook(() => useRuntimeAvailability(true));
    expect(requests).toHaveLength(1);
    act(() => { api.emit('runtimes:changed', []); api.emit('runtimes:availabilityChanged', {}); });
    // 每个广播各自 reread 主进程快照，不再合并成一次；共 3 次请求。
    expect(requests).toHaveLength(3);
    await act(async () => requests[0].resolve(snapshot()));
    expect(hook.result.current.ready).toBe(false); expect(hook.result.current.snapshot).toBeNull();
    await act(async () => requests[1].resolve(snapshot()));
    expect(hook.result.current.ready).toBe(false); expect(hook.result.current.snapshot).toBeNull();
    await act(async () => requests[2].resolve(snapshot())); expect(hook.result.current.ready).toBe(true);
    // focus / visibilitychange 监听已退役：focus 不再触发探测。
    act(() => window.dispatchEvent(new Event('focus')));
    expect(hook.result.current.ready).toBe(true);
    hook.unmount();
    act(() => { api.emit('runtimes:availabilityChanged', {}); window.dispatchEvent(new Event('focus')); });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(requests).toHaveLength(3);
  } finally { vi.useRealTimers(); }
});

it('retains the exit snapshot but invalidates a pending check on close and clears it on reopening', async () => {
  const api = currentApiMock(); api.override('runtimes.availability', async () => snapshot());
  const hook = renderHook(({ active }) => useRuntimeAvailability(active), { initialProps: { active: true } });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  const pending = deferred<RuntimeAvailabilitySnapshot>();
  api.mockOf('runtimes.availability').mockImplementationOnce(() => pending.promise);
  let check!: Promise<RuntimeAvailabilitySnapshot | null>;
  act(() => { check = hook.result.current.refresh(true); });
  hook.rerender({ active: false });
  expect(hook.result.current.snapshot).toEqual(snapshot()); expect(hook.result.current.ready).toBe(false);
  await act(async () => { pending.resolve(snapshot([])); expect(await check).toBeNull(); });
  expect(hook.result.current.snapshot).toEqual(snapshot());
  hook.rerender({ active: true });
  expect(hook.result.current.snapshot).toBeNull(); expect(hook.result.current.ready).toBe(false);
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
});

it('does not refresh on visible activation or bounded polling, and returns no success for malformed data', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  try {
    const api = currentApiMock(); api.override('runtimes.availability', async () => snapshot([]));
    const hook = renderHook(() => useRuntimeAvailability(true));
    await act(async () => {}); expect(hook.result.current.ready).toBe(true);
    expect(hook.result.current.snapshot?.runtimes).toEqual([]);
    visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => vi.advanceTimersByTimeAsync(15_000)); expect(api.mockOf('runtimes.availability')).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange')));
    // onVisible 监听已移除：visible 激活不再触发探测。
    await act(async () => vi.advanceTimersByTimeAsync(0)); expect(api.mockOf('runtimes.availability')).toHaveBeenCalledTimes(1);
    // 15s setInterval 轮询已退役：推进计时器不再触发探测。
    await act(async () => vi.advanceTimersByTimeAsync(15_001)); expect(api.mockOf('runtimes.availability')).toHaveBeenCalledTimes(1);
    api.override('runtimes.availability', async () => undefined);
    await act(async () => { expect(await hook.result.current.refresh(true)).toBeNull(); });
    expect(hook.result.current.ready).toBe(false); expect(hook.result.current.error).toContain('无效数据');
    hook.unmount();
  } finally { visibility.mockRestore(); vi.useRealTimers(); }
});

it('intersects current enabled registry entries and requires an explicit available ACP preset', () => {
  const acp = { ...worker, id: 'acp' };
  const disabled = { ...worker, id: 'disabled', enabled: false };
  const unknown = { ...worker, id: 'unregistered' };
  const probe = snapshot([worker, acp, { ...disabled, enabled: true }, unknown], [{ id: 'codex', name: 'Codex' }]);
  expect(availableRuntimeEntries(probe, [{ ...worker, label: 'Renamed' }, disabled, acp]).map(entry => [entry.id, entry.label])).toEqual([['worker', 'Renamed'], ['acp', 'Worker']]);
  expect(availableRuntimeEntries(null, [worker])).toEqual([]);
  expect(runtimeSelectionAvailable(probe, [acp], 'acp')).toBe(false);
  expect(runtimeSelectionAvailable(probe, [acp], 'acp', 'opencode')).toBe(false);
  expect(runtimeSelectionAvailable(probe, [acp], 'acp', 'codex')).toBe(true);
  expect(availableRuntimeEntries(snapshot([acp]), [acp])).toEqual([]);
});
