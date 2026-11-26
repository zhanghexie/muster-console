/** Background agent opens must never select a content tab or focus its guest. */
import React, { useReducer } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserPage } from '../../src/renderer/src/components/BrowserPage';
import { StoreProvider } from '../../src/renderer/src/store';
import { RightWorkspaceContext } from '../../src/renderer/src/rightWorkspace';
import { activeRightTab, initialRightWorkspace, reduceRightWorkspace, rightContentLocation, type RightWorkspaceModel } from '../../src/shared/rightWorkspace';
import type { BrowserTabsPayload } from '../../src/shared/browser';
import { currentApiMock } from './helpers/api-mock';

function Harness({ initial }: { initial: RightWorkspaceModel }): React.JSX.Element {
  const [model, dispatch] = useReducer(reduceRightWorkspace, initial);
  const current = activeRightTab(model);
  return <RightWorkspaceContext.Provider value={{ model, current, dispatch, toolbar: null,
    resourceHosts: { files: null, git: null, browser: null }, open: () => {}, registerFile: () => {} }}>
    <input aria-label="User draft" defaultValue="unsent user draft" />
    <output data-testid="selection">{current?.content.kind}:{current?.content.kind === 'web' ? current.content.browserId : current ? rightContentLocation(current.content) : ''}</output>
    <output data-testid="owned-tabs">{JSON.stringify(model.tabs.map(tab => ({ sessionId: tab.sessionId, content: tab.content })))}</output>
    <BrowserPage active={current?.content.kind === 'web'} shown={current?.content.kind === 'web'} sideTab="files" onSideTab={() => {}} />
  </RightWorkspaceContext.Provider>;
}

function initialFile(): RightWorkspaceModel {
  let model = initialRightWorkspace('ws-a', 'user-chat');
  model = reduceRightWorkspace(model, { type: 'hydrate', workspaceId: 'ws-a' });
  return reduceRightWorkspace(model, { type: 'open', content: { kind: 'file', path: 'user-draft.txt' } });
}

function tabs(ids: string[], activeId: string | null): BrowserTabsPayload {
  return { activeId, tabs: ids.map(id => ({ id, title: id, url: `https://example.com/${id}`,
    workspaceId: 'ws-a', sessionId: id === 'same-chat' ? 'user-chat' : 'other-ai',
    openInBackground: true, favicon: null, loading: false, canGoBack: false, canGoForward: false })) };
}

function expectParked(webview: Element): void {
  const node = webview as HTMLElement;
  expect(node.dataset.browserPresentation).toBe('background');
  expect(node.style.visibility).toBe('hidden');
  expect(node.style.position).toBe('fixed');
  expect(node.style.width).toBe('1280px');
  expect(node.style.height).toBe('900px');
  expect(node.style.pointerEvents).toBe('none');
  expect(node.hasAttribute('inert')).toBe(true);
  expect(node.tabIndex).toBe(-1);
}

describe('background browser ownership', () => {
  it('same-chat and other-chat agent opens retain the user file, draft and host focus', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve({ tabs: [], activeId: null }));
    const view = render(<StoreProvider><Harness initial={initialFile()} /></StoreProvider>);
    const input = view.getByRole('textbox', { name: 'User draft' });
    input.focus();
    await waitFor(() => expect(mock.mockOf('browser.restore')).toHaveBeenCalled());
    await act(async () => {});
    act(() => mock.emit('browser:tabs', tabs(['same-chat', 'other-chat'], null)));
    await waitFor(() => expect(view.getByTestId('owned-tabs').textContent).toContain('other-chat'));
    expect(view.getByTestId('selection').textContent).toBe('file:user-draft.txt');
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe('unsent user draft');

    act(() => {
      mock.emit('browser:mount-request', { tabId: 'same-chat' });
      mock.emit('browser:mount-request', { tabId: 'other-chat' });
      mock.emit('browser:agentState', { active: true, action: 'fill', tabId: 'same-chat' });
    });
    await waitFor(() => expect(document.querySelectorAll('webview')).toHaveLength(2));
    for (const webview of document.querySelectorAll('webview')) {
      expectParked(webview);
      const focus = vi.spyOn(webview as HTMLElement, 'focus');
      act(() => mock.emit('browser:agentState', { active: true, action: 'press', tabId: webview.getAttribute('data-tab-id')! }));
      expect(focus).not.toHaveBeenCalled();
    }
    expect(view.getByTestId('selection').textContent).toBe('file:user-draft.txt');
    expect(document.activeElement).toBe(input);
    expect(mock.mockOf('browser.focusAck')).not.toHaveBeenCalled();
    expect(mock.mockOf('browser.activate')).not.toHaveBeenCalled();
    expect(mock.mockOf('browser.executionPreview')).not.toHaveBeenCalled();
    expect(document.querySelector('[data-browser-execution-frame]')).toBeNull();
    expect(view.getByTestId('owned-tabs').textContent).toContain('"sessionId":"user-chat"');
    expect(view.getByTestId('owned-tabs').textContent).toContain('"sessionId":"other-ai"');
  });

  it('mounting and background status updates preserve the foreground web selection', async () => {
    const mock = currentApiMock();
    const foreground = { id: 'foreground', title: 'Foreground', url: 'https://example.com/foreground',
      workspaceId: 'ws-a', sessionId: 'user-chat', favicon: null, loading: false, canGoBack: false, canGoForward: false };
    mock.override('browser.restore', () => Promise.resolve({ tabs: [foreground], activeId: foreground.id }));
    let initial = initialFile();
    initial = reduceRightWorkspace(initial, { type: 'open', content: { kind: 'web', browserId: foreground.id, url: foreground.url, title: foreground.title } });
    const view = render(<StoreProvider><Harness initial={initial} /></StoreProvider>);
    await waitFor(() => expect(document.querySelector('webview[data-tab-id="foreground"]')).toBeTruthy());
    const foregroundNode = document.querySelector('webview[data-tab-id="foreground"]');
    const input = view.getByRole('textbox', { name: 'User draft' });
    input.focus();
    act(() => mock.emit('browser:tabs', { ...tabs(['same-chat', 'other-chat'], foreground.id), tabs: [foreground, ...tabs(['same-chat', 'other-chat'], foreground.id).tabs] }));
    act(() => {
      mock.emit('browser:mount-request', { tabId: 'same-chat' });
      mock.emit('browser:mount-request', { tabId: 'other-chat' });
      mock.emit('browser:agentState', { active: true, action: 'click', tabId: 'other-chat' });
    });
    await waitFor(() => expect(document.querySelectorAll('webview')).toHaveLength(3));
    expect(document.querySelector('webview[data-tab-id="foreground"]')).toBe(foregroundNode);
    expect((foregroundNode as HTMLElement).dataset.browserPresentation).toBe('foreground');
    for (const id of ['same-chat', 'other-chat']) expectParked(document.querySelector(`webview[data-tab-id="${id}"]`)!);
    expect(view.getByTestId('selection').textContent).toBe('web:foreground');
    expect(document.activeElement).toBe(input);
    expect(mock.mockOf('browser.focusAck')).not.toHaveBeenCalled();
  });

  it('a cold mount request received before its tab payload stays background after registration', async () => {
    const mock = currentApiMock();
    mock.override('browser.restore', () => Promise.resolve({ tabs: [], activeId: null }));
    const view = render(<StoreProvider><Harness initial={initialFile()} /></StoreProvider>);
    const input = view.getByRole('textbox', { name: 'User draft' });
    input.focus();
    await waitFor(() => expect(mock.mockOf('browser.restore')).toHaveBeenCalled());
    act(() => mock.emit('browser:mount-request', { tabId: 'cold-ai' }));
    expect(document.querySelector('webview')).toBeNull();
    act(() => mock.emit('browser:tabs', tabs(['cold-ai'], null)));
    await waitFor(() => expect(document.querySelector('webview[data-tab-id="cold-ai"]')).toBeTruthy());
    expectParked(document.querySelector('webview[data-tab-id="cold-ai"]')!);
    expect(view.getByTestId('selection').textContent).toBe('file:user-draft.txt');
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe('unsent user draft');
    expect(mock.mockOf('browser.activate')).not.toHaveBeenCalled();
    expect(mock.mockOf('browser.focusAck')).not.toHaveBeenCalled();
  });
});
