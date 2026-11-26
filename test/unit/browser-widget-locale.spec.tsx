import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BrowserPage } from '../../src/renderer/src/components/BrowserPage';
import { StoreProvider } from '../../src/renderer/src/store';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { currentApiMock } from './helpers/api-mock';

it('updates the existing browser guest activation hint when the app language changes', async () => {
  act(() => applyLocaleSetting('zh-CN'));
  currentApiMock().override('browser.restore', async () => ({ tabs: [{ id: 'widget', title: 'Widget', url: 'https://example.com', favicon: null, loading: false, canGoBack: false, canGoForward: false }], activeId: 'widget', nav: { back: false, forward: false } }));
  const view = render(<StoreProvider><BrowserPage active shown sideTab="browser" onSideTab={() => {}} /></StoreProvider>);
  try {
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy());
    const guest = document.querySelector('webview')!;
    const send = vi.fn();
    Object.defineProperty(guest, 'send', { value: send, configurable: true });
    act(() => guest.dispatchEvent(new Event('dom-ready')));
    expect(send).toHaveBeenLastCalledWith('uiWidget:appearance', expect.objectContaining({ locale: 'zh-CN', activationError: '请点击或用键盘触发此操作' }));
    act(() => applyLocaleSetting('en'));
    expect(send).toHaveBeenLastCalledWith('uiWidget:appearance', expect.objectContaining({ locale: 'en', activationError: 'Click or use the keyboard to perform this action' }));
    expect(document.querySelector('webview')).toBe(guest);
    act(() => applyLocaleSetting('zh-CN'));
    expect(send).toHaveBeenLastCalledWith('uiWidget:appearance', expect.objectContaining({ activationError: '请点击或用键盘触发此操作' }));
    view.unmount();
    send.mockClear();
    act(() => applyLocaleSetting('en'));
    expect(send).not.toHaveBeenCalled();
  } finally { view.unmount(); act(() => applyLocaleSetting('zh-CN')); }
});
