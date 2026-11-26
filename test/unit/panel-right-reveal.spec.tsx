import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePanelRightReveal } from '../../src/renderer/src/hooks/usePanelRightReveal';
import { registerFileEditorState } from '../../src/renderer/src/fileEditorState';
import { createApiMock } from './helpers/api-mock';
import { useRef, useState } from 'react';

describe('right panel foreground confirmation', () => {
  it('cancels an earlier hover switch before confirming a programmatic focus', async () => {
    vi.useFakeTimers();
    try {
      const api = createApiMock(); window.api = api.api;
      const switchToTerminal = vi.fn();
      const hover = setTimeout(switchToTerminal, 10);
      const prepare = vi.fn(() => clearTimeout(hover));
      const hook = renderHook(() => usePanelRightReveal({ workspaceId: 'ws', rootsRevision: 1, switching: false,
        transitioning: false, narrow: false, rightDrawerOpen: false, focusMode: false, settingsBlocked: false,
        virtualScreen: true, page: 'git', prepare, showGit: vi.fn(), enableGit: vi.fn(), openDrawer: vi.fn(), settle: async () => {} }));
      let pending!: Promise<void>;
      act(() => { pending = hook.result.current('hover', 'ws', 1, () => true); });
      expect(prepare).toHaveBeenCalledOnce();
      await act(async () => { vi.advanceTimersByTime(20); await pending; });
      expect(switchToTerminal).not.toHaveBeenCalled();
      hook.unmount();
    } finally { vi.useRealTimers(); }
  });
  it('sees a queued terminal selection before deciding whether Git is visible', async () => {
    const api = createApiMock(); window.api = api.api;
    const showGit = vi.fn();
    const hook = renderHook(() => {
      const [page, setPageState] = useState<'terminal' | 'git'>('git');
      const pageIntent = useRef<'terminal' | 'git'>('git');
      const setPage = (next: 'terminal' | 'git') => { pageIntent.current = next; setPageState(next); };
      const reveal = usePanelRightReveal({ workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false,
        narrow: false, rightDrawerOpen: false, focusMode: false, settingsBlocked: false, virtualScreen: true,
        page, pendingPage: () => pageIntent.current, showGit, enableGit: vi.fn(), openDrawer: vi.fn(), settle: async () => {} });
      return { setPage, reveal };
    });
    let pending!: Promise<void>;
    act(() => {
      hook.result.current.setPage('terminal');
      pending = hook.result.current.reveal('queued', 'ws', 1, () => true);
      void pending.catch(() => {});
    });
    expect(showGit).toHaveBeenCalledOnce();
    act(() => hook.result.current.setPage('git'));
    await expect(pending).resolves.toBeUndefined();
    hook.unmount();
  });
  it('does not report success if the workspace briefly leaves view during the transition', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void;
    const initial = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, narrow: false,
      rightDrawerOpen: false, focusMode: false, settingsBlocked: false, virtualScreen: true,
      page: 'git' as 'terminal' | 'git', showGit: vi.fn(), enableGit: vi.fn(), openDrawer: vi.fn(),
      settle: () => new Promise<void>(resolve => { finish = resolve; }) };
    const hook = renderHook(props => usePanelRightReveal(props), { initialProps: initial });
    let pending!: Promise<void>; act(() => { pending = hook.result.current('interrupted', 'ws', 1, () => true); });
    const rejected = expect(pending).rejects.toThrow(/visibility changed/);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    hook.rerender({ ...initial, page: 'terminal' });
    hook.rerender({ ...initial, page: 'git' });
    act(() => finish()); await rejected;
    hook.unmount();
  });
  it('waits through a stale page render only while the host intent still points to Git', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void, intent: 'terminal' | 'git' = 'git';
    const initial = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, narrow: false,
      rightDrawerOpen: false, focusMode: false, settingsBlocked: false, virtualScreen: true,
      page: 'git' as 'terminal' | 'git', pendingPage: () => intent, showGit: vi.fn(), enableGit: vi.fn(), openDrawer: vi.fn(),
      settle: () => new Promise<void>(resolve => { finish = resolve; }) };
    const hook = renderHook(props => usePanelRightReveal(props), { initialProps: initial });
    let pending!: Promise<void>; act(() => { pending = hook.result.current('stale-render', 'ws', 1, () => true); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    hook.rerender({ ...initial, page: 'terminal' });
    hook.rerender({ ...initial, page: 'git' });
    act(() => finish()); await expect(pending).resolves.toBeUndefined();
    let cancelled!: Promise<void>; act(() => { cancelled = hook.result.current('user-away', 'ws', 1, () => true); });
    const rejected = expect(cancelled).rejects.toThrow(/visibility changed/);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    intent = 'terminal'; hook.rerender({ ...initial, page: 'terminal' });
    await rejected; hook.unmount();
  });
  it('waits for the real presentation transition and rechecks the selected target', async () => {
    const api = createApiMock(); window.api = api.api;
    let finish!: () => void, selected = true;
    const settle = () => new Promise<void>(resolve => { finish = resolve; });
    const options = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, narrow: false,
      rightDrawerOpen: false, focusMode: false, settingsBlocked: false, virtualScreen: true, page: 'git' as const,
      showGit: vi.fn(), enableGit: vi.fn(), openDrawer: vi.fn(), settle };
    const hook = renderHook(() => usePanelRightReveal(options));
    let pending!: Promise<void>; act(() => { pending = hook.result.current('settle', 'ws', 1, () => selected); });
    let completed = false; void pending.catch(() => { completed = true; });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(completed).toBe(false);
    selected = false;
    const rejected = expect(pending).rejects.toThrow(/target changed/);
    act(() => finish()); await rejected;
    hook.unmount();
  });
  it('waits for the wide virtual screen or the narrow drawer to become visible', async () => {
    const api = createApiMock(); window.api = api.api;
    const showGit = vi.fn(), enableGit = vi.fn(), openDrawer = vi.fn();
    const initial = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, narrow: false,
      rightDrawerOpen: false, focusMode: false, settingsBlocked: false, virtualScreen: true, page: 'terminal' as 'terminal' | 'git', showGit, enableGit, openDrawer, settle: async () => {} };
    const hook = renderHook(props => usePanelRightReveal(props), { initialProps: initial });
    let wide!: Promise<void>; act(() => { wide = hook.result.current('wide', 'ws', 1, () => true); });
    expect(showGit).toHaveBeenCalledOnce();
    let completed = false; void wide.then(() => { completed = true; });
    await act(async () => { await Promise.resolve(); }); expect(completed).toBe(false);
    hook.rerender({ ...initial, page: 'git' }); await expect(wide).resolves.toBeUndefined();
    hook.rerender({ ...initial, narrow: true });
    let narrow!: Promise<void>; act(() => { narrow = hook.result.current('narrow', 'ws', 1, () => true); });
    expect(openDrawer).toHaveBeenCalledOnce();
    hook.rerender({ ...initial, narrow: true, rightDrawerOpen: true, page: 'git' }); await expect(narrow).resolves.toBeUndefined();
    hook.unmount();
  });

  it('rejects cancellation, stale targets and dirty editors without reporting success', async () => {
    const api = createApiMock(); window.api = api.api;
    const initial = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false, narrow: false,
      rightDrawerOpen: false, focusMode: false, settingsBlocked: false, virtualScreen: false, page: 'terminal' as const,
      showGit: vi.fn(), enableGit: vi.fn(), openDrawer: vi.fn(), settle: async () => {} };
    const hook = renderHook(() => usePanelRightReveal(initial));
    const unregister = registerFileEditorState(() => ({ workspaceId: 'ws', path: 'a', active: true, editing: true, unsaved: true }));
    await expect(hook.result.current('dirty', 'ws', 1, () => true)).rejects.toThrow(/unsaved/);
    expect(initial.enableGit).not.toHaveBeenCalled(); unregister();
    await expect(hook.result.current('stale', 'ws', 1, () => false)).rejects.toThrow(/target changed/);
    let pending!: Promise<void>; act(() => { pending = hook.result.current('cancel', 'ws', 1, () => true); });
    const rejection = expect(pending).rejects.toThrow(/request was closed/);
    act(() => api.emit('panel:focus-tab-closed', { requestId: 'cancel' }));
    await rejection;
    let open!: Promise<void>; act(() => { open = hook.result.current('open', 'ws', 1, () => true); });
    expect(initial.enableGit).toHaveBeenCalled();
    const openRejection = expect(open).rejects.toThrow(/request was closed/);
    act(() => api.emit('panel:open-content-closed', { requestId: 'open' }));
    await openRejection;
    let axis!: Promise<void>; act(() => { axis = hook.result.current('axis', 'ws', 1, () => true); });
    const axisRejection = expect(axis).rejects.toThrow(/request was closed/);
    act(() => api.emit('panel:focus-axis-closed', { requestId: 'axis' }));
    await axisRejection;
    hook.unmount();
  });
});
