import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UiSessionPage } from '../../src/renderer/src/chatSurface/UiSessionPage';
import { emptyUiWidgetState, type UiWidgetSnapshot } from '../../src/shared/uiWidgetProtocol';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting } from '../../src/shared/i18n';

function widget(n: number, mode = 'inline'): UiWidgetSnapshot {
  return { path: `/data/agent-sessions/cli/ui/${n}-form.${mode}.html`, title: `界面 ${n}`, artifactVersion: 1,
    state: emptyUiWidgetState(), receipt: { status: 'generated', visible: false, updatedAt: 0 } } as UiWidgetSnapshot;
}
function setup() {
  const api = currentApiMock();
  api.override('uiWidgets.read', async (path: string) => ({ ...widget(1), path }));
  api.override('uiWidgets.receipt', async () => widget(1));
  api.override('uiWidgets.save', async (_path: string, patch: any) => ({ ...widget(1), state: { ...emptyUiWidgetState(), ...patch } }));
  return api;
}
describe('CLI UI-only page', () => {
  it('orders every UI in one page, embeds browser artifacts, and appends without remounting existing cards', async () => {
    const api = setup(); let items = [widget(10, 'browser'), widget(2)];
    api.override('uiWidgets.list', async () => items);
    const view = render(<UiSessionPage sessionId="cli" visible />);
    await waitFor(() => expect(view.container.querySelectorAll('iframe')).toHaveLength(2));
    expect(Array.from(view.container.querySelectorAll('[data-ui-path]')).map(node => node.getAttribute('data-ui-path'))).toEqual([widget(2).path, widget(10, 'browser').path]);
    const first = view.container.querySelector('iframe');
    items = [...items, widget(11)];
    act(() => api.emit('uiWidget:updated', { path: widget(11).path, artifactVersion: 1 }));
    await waitFor(() => expect(view.container.querySelectorAll('iframe')).toHaveLength(3));
    expect(view.container.querySelector('iframe')).toBe(first);
    expect(view.container.querySelector('webview')).toBeNull();
    const calls = api.mockOf('uiWidgets.list').mock.calls.length;
    act(() => api.emit('uiWidget:updated', { path: '/data/agent-sessions/other/ui/1-form.inline.html', artifactVersion: 1 }));
    expect(api.mockOf('uiWidgets.list').mock.calls).toHaveLength(calls);
  });
  it('keeps the card and iframe when hiding or collapsing; routes followup once through the owning session', async () => {
    const api = setup(); api.override('uiWidgets.list', async () => [widget(1)]);
    api.override('uiWidgets.sessionAction', async () => ({ ok: true, type: 'followup', mode: 'draft', text: '继续', sessionId: 'cli' }));
    const listener = vi.fn(); window.addEventListener('ma-ui-followup', listener);
    const onDraft = vi.fn();
    const view = render(<UiSessionPage sessionId="cli" visible onDraft={onDraft}/>);
    await waitFor(() => expect(view.container.querySelector('iframe')).toBeTruthy());
    const frame = view.container.querySelector('iframe')!;
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(view.container.querySelector('iframe')).toBe(frame);
    view.rerender(<UiSessionPage sessionId="cli" visible={false} onDraft={onDraft}/>);
    expect(view.container.querySelector('iframe')).toBe(frame);
    expect(view.container.querySelector('.ui-session-page')!.hasAttribute('inert')).toBe(true);
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { __ma: true, v: 2, type: 'action', id: 'one', action: { type: 'followup', text: '继续' } } })); });
    await waitFor(() => expect(api.mockOf('uiWidgets.sessionAction')).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onDraft).toHaveBeenCalledTimes(1));
    expect(onDraft).toHaveBeenCalledWith('继续');
    expect(listener).not.toHaveBeenCalled(); window.removeEventListener('ma-ui-followup', listener);
  });
  it('surfaces loading errors and supports retry', async () => {
    const api = setup(); let fail = true;
    api.override('uiWidgets.list', async () => { if (fail) throw new Error('读取失败'); return [widget(1)]; });
    const view = render(<UiSessionPage sessionId="cli" visible />);
    expect((await screen.findByRole('alert')).textContent).toContain('读取失败');
    fail = false; fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(view.container.querySelector('iframe')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('localizes a known host read error and keeps the retry working', async () => {
    const api = setup(), failure = new Error('部件路径无效'); let fail = true;
    api.override('uiWidgets.list', async () => { if (fail) throw failure; return [widget(1)]; });
    const view = render(<UiSessionPage sessionId="cli" visible />);
    try {
      expect((await screen.findByRole('alert')).textContent).toContain(failure.message);
      act(() => { applyLocaleSetting('en'); });
      expect(screen.getByRole('alert').textContent).toContain('Invalid widget path');
      expect(failure.message).toBe('部件路径无效');
      fail = false; fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(view.container.querySelector('iframe')).toBeTruthy());
    } finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('clears visibility receipts when a different tab hides the still-mounted cards', async () => {
    const api = setup();
    const item = widget(1, 'browser');
    api.override('uiWidgets.list', async () => [item]);
    const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof callbacks[number]) { callbacks.push(callback); }
      observe(): void {}
      disconnect(): void {}
    });
    const view = render(<UiSessionPage sessionId="cli" visible />);
    try {
      await waitFor(() => expect(callbacks).toHaveLength(2));
      act(() => callbacks.forEach(callback => callback([{ isIntersecting: true }])));
      const frame = await screen.findByTitle('1-form.browser.html');
      const receipts = api.mockOf('uiWidgets.receipt');
      expect(receipts).toHaveBeenLastCalledWith(item.path, expect.objectContaining({ visible: true }), expect.any(String));

      view.rerender(<UiSessionPage sessionId="cli" visible={false} />);
      expect(receipts).toHaveBeenLastCalledWith(item.path, expect.objectContaining({ visible: false }), expect.any(String));
      // A queued observation or late frame load from the previous tab cannot
      // make the now-hidden presentation appear visible again.
      act(() => callbacks[1]!([{ isIntersecting: true }]));
      fireEvent.load(frame);
      expect(receipts).toHaveBeenLastCalledWith(item.path, expect.objectContaining({ visible: false }), expect.any(String));
      expect(view.container.querySelector('iframe')).toBe(frame);

      view.rerender(<UiSessionPage sessionId="cli" visible />);
      act(() => callbacks[1]!([{ isIntersecting: true }]));
      expect(receipts).toHaveBeenLastCalledWith(item.path, expect.objectContaining({ visible: false }), expect.any(String));
      act(() => callbacks.at(-1)!([{ isIntersecting: true }]));
      expect(receipts).toHaveBeenLastCalledWith(item.path, expect.objectContaining({ visible: true }), expect.any(String));
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
});
