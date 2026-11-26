import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { planPanelAxisFocus } from '../../src/renderer/src/panelAxisFocus';
import { usePanelAxisFocus } from '../../src/renderer/src/hooks/usePanelAxisFocus';
import { usePanelRightReveal } from '../../src/renderer/src/hooks/usePanelRightReveal';
import { registerFileEditorState } from '../../src/renderer/src/fileEditorState';
import { createApiMock } from './helpers/api-mock';

describe('panel axis focus guard', () => {
  it('cancels earlier hover and queued Git selection before confirming terminal', async () => {
    const api = createApiMock(); window.api = api.api;
    const prepare = vi.fn(), showTerminal = vi.fn();
    const options = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false,
      page: 'terminal' as const, pendingPage: () => 'git' as const, prepare, virtualScreen: true, focusMode: false,
      settingsModal: false, narrow: false, rightDrawerOpen: false, closeDrawer: vi.fn(),
      revealRight: vi.fn(), showTerminal, settleTerminal: async () => {} };
    const hook = renderHook(() => usePanelAxisFocus(options));
    act(() => api.emit('panel:focus-axis-request', { requestId: 'terminal', workspaceId: 'ws', rootsRevision: 1, page: 'terminal' }));
    expect(prepare).toHaveBeenCalledOnce();
    expect(showTerminal).toHaveBeenCalledOnce();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(api.mockOf('panel.replyFocusAxis')).toHaveBeenCalledWith('terminal', { ok: true, page: 'terminal' });
    hook.unmount();
  });
  it('uses existing transitions, protects unsaved edits, and treats current page as a no-op', () => {
    const base = { page: 'terminal' as const, virtualScreen: false, focusMode: false, activeEditorUnsaved: false };
    expect(planPanelAxisFocus(base, 'git')).toBe('enable-git');
    expect(planPanelAxisFocus({ ...base, virtualScreen: true }, 'git')).toBe('show-git');
    expect(planPanelAxisFocus({ ...base, focusMode: true }, 'git')).toBe('show-git');
    expect(planPanelAxisFocus({ ...base, page: 'git', virtualScreen: true }, 'terminal')).toBe('show-terminal');
    expect(planPanelAxisFocus({ ...base, activeEditorUnsaved: true }, 'terminal')).toBe('noop');
    expect(() => planPanelAxisFocus({ ...base, activeEditorUnsaved: true }, 'git')).toThrow(/unsaved/);
  });
  it('acknowledges only the observed page, rejects stale workspace and protects active dirty editors', async () => {
    const api = createApiMock(); window.api = api.api;
    const enableGit = vi.fn(), showGit = vi.fn(), showTerminal = vi.fn();
    const initial = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false,
      page: 'terminal' as 'terminal' | 'git', virtualScreen: false, focusMode: false, settingsBlocked: false, settingsModal: false, settingsDirtyDocked: false, narrow: false, rightDrawerOpen: false,
      closeDrawer: vi.fn(), openDrawer: vi.fn(), settle: async () => {}, settleTerminal: async () => {}, enableGit, showGit, showTerminal };
    const hook = renderHook(props => {
      const revealRight = usePanelRightReveal(props);
      return usePanelAxisFocus({ ...props, revealRight });
    }, { initialProps: initial });
    act(() => api.emit('panel:focus-axis-request', { requestId: '1', workspaceId: 'ws', rootsRevision: 1, page: 'git' }));
    expect(enableGit).toHaveBeenCalledOnce();
    expect(api.mockOf('panel.replyFocusAxis')).not.toHaveBeenCalled();
    hook.rerender({ ...initial, page: 'git', virtualScreen: true });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(api.mockOf('panel.replyFocusAxis')).toHaveBeenLastCalledWith('1', { ok: true, page: 'git' });
    const unregister = registerFileEditorState(() => ({ workspaceId: 'ws', path: 'a.txt', active: true, editing: true, unsaved: true }));
    act(() => api.emit('panel:focus-axis-request', { requestId: '2', workspaceId: 'ws', rootsRevision: 1, page: 'terminal' }));
    expect(showTerminal).not.toHaveBeenCalled();
    expect(api.mockOf('panel.replyFocusAxis')).toHaveBeenLastCalledWith('2', expect.objectContaining({ ok: false, error: expect.stringMatching(/unsaved/) }));
    unregister();
    hook.rerender({ ...initial, page: 'git', virtualScreen: true, settingsDirtyDocked: true });
    act(() => api.emit('panel:focus-axis-request', { requestId: 'dirty-settings', workspaceId: 'ws', rootsRevision: 1, page: 'terminal' }));
    expect(api.mockOf('panel.replyFocusAxis')).toHaveBeenLastCalledWith('dirty-settings', expect.objectContaining({ ok: false, error: expect.stringMatching(/unsaved/) }));
    act(() => api.emit('panel:focus-axis-request', { requestId: '3', workspaceId: 'other', rootsRevision: 1, page: 'terminal' }));
    expect(api.mockOf('panel.replyFocusAxis')).toHaveBeenLastCalledWith('3', expect.objectContaining({ ok: false }));
    hook.unmount();
  });
  it('opens and closes the narrow drawer before acknowledging the requested axis', async () => {
    const api = createApiMock(); window.api = api.api;
    const initial = { workspaceId: 'ws', rootsRevision: 1, switching: false, transitioning: false,
      page: 'terminal' as 'terminal' | 'git', virtualScreen: true, focusMode: false, settingsBlocked: false, settingsModal: false, narrow: true, rightDrawerOpen: false,
      closeDrawer: vi.fn(), openDrawer: vi.fn(), settle: async () => {}, settleTerminal: async () => {}, enableGit: vi.fn(), showGit: vi.fn(), showTerminal: vi.fn() };
    const hook = renderHook(props => {
      const revealRight = usePanelRightReveal(props);
      return usePanelAxisFocus({ ...props, revealRight });
    }, { initialProps: initial });
    act(() => api.emit('panel:focus-axis-request', { requestId: 'open', workspaceId: 'ws', rootsRevision: 1, page: 'git' }));
    expect(initial.openDrawer).toHaveBeenCalledOnce();
    expect(api.mockOf('panel.replyFocusAxis')).not.toHaveBeenCalled();
    hook.rerender({ ...initial, page: 'git', rightDrawerOpen: true });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(api.mockOf('panel.replyFocusAxis')).toHaveBeenLastCalledWith('open', { ok: true, page: 'git' });
    act(() => api.emit('panel:focus-axis-request', { requestId: 'close', workspaceId: 'ws', rootsRevision: 1, page: 'terminal' }));
    expect(initial.closeDrawer).toHaveBeenCalledOnce(); expect(initial.showTerminal).toHaveBeenCalledOnce();
    hook.rerender({ ...initial, page: 'terminal', rightDrawerOpen: false });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(api.mockOf('panel.replyFocusAxis')).toHaveBeenLastCalledWith('close', { ok: true, page: 'terminal' });
    hook.unmount();
  });
});
