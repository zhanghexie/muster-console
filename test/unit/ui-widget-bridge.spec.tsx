import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import { currentApiMock } from './helpers/api-mock';
import { emptyUiWidgetState, mergeUiWidgetState, type UiWidgetSnapshot } from '../../src/shared/uiWidgetProtocol';
import { UI_FOLLOWUP_EVENT } from '../../src/renderer/src/chatSurface/uiWidgetEvents';
import { resetUiFontForTest } from '../../src/renderer/src/uiFont';
import { setWorkspaceAppearance } from '../../src/renderer/src/theme';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { localizeUiWidgetHostError, UI_WIDGET_HOST_ERROR_KEYS } from '../../src/shared/uiWidgetHostErrors';

const path = 'E:/data/agent-sessions/a/ui/01-budget.inline.html';
let snapshot: UiWidgetSnapshot;
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  snapshot = { path, title: '预算选择', artifactVersion: 1, state: emptyUiWidgetState(), receipt: { status: 'generated', visible: false, updatedAt: 1 } };
  currentApiMock().override('uiWidgets.read', async () => structuredClone(snapshot));
  currentApiMock().override('uiWidgets.save', async (_path, patch) => {
    snapshot.state = mergeUiWidgetState(snapshot.state, patch); return structuredClone(snapshot);
  });
});
async function setup(collapsed = false) {
  snapshot.state.presentation.collapsed = collapsed;
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<MarkdownBody text={`[预算](<${path}>)`} />); });
  const frame = view.container.querySelector('iframe')!;
  const source = { postMessage: vi.fn() };
  Object.defineProperty(frame, 'contentWindow', { value: source, configurable: true });
  const post = async (data: unknown) => { await act(async () => window.dispatchEvent(new MessageEvent('message', { data: { __ma: true, v: 2, ...(data as object) }, source: source as unknown as Window }))); };
  return { ...view, frame, source, post };
}
describe('stateful inline UI bridge', () => {
  it('sends the selected language to the existing iframe on init and language changes', async () => {
    act(() => applyLocaleSetting('zh-CN'));
    const view = await setup();
    try {
      await view.post({ type: 'ready' });
      expect(view.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init', locale: 'zh-CN' }), '*');
      act(() => applyLocaleSetting('en'));
      expect(view.source.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'appearance', locale: 'en' }), '*');
      expect(view.container.querySelector('iframe')).toBe(view.frame);
    } finally { view.unmount(); act(() => applyLocaleSetting('zh-CN')); }
  });
  it('restores explicit collapse and parameters; reversal retains the same iframe and focus', async () => {
    snapshot.state.privateContent = { values: { budget: 8 } };
    const view = await setup(true);
    expect(screen.getByRole('button', { name: '展开' }).getAttribute('aria-expanded')).toBe('false');
    await view.post({ type: 'ready' });
    expect(view.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init', state: expect.objectContaining({ privateContent: { values: { budget: 8 } } }) }), '*');
    const toggle = screen.getByRole('button', { name: '展开' }); toggle.focus();
    await act(async () => { fireEvent.click(toggle); });
    await act(async () => { fireEvent.click(toggle); });
    expect(view.container.querySelector('iframe')).toBe(view.frame);
    expect(document.activeElement).toBe(toggle);
    expect(snapshot.state.privateContent).toEqual({ values: { budget: 8 } });
    expect(snapshot.state.presentation.collapsed).toBe(true);
  });
  it('acknowledges durable state and reloads only the matching updated artifact', async () => {
    const view = await setup();
    await view.post({ type: 'state', id: 4, state: { modelContent: { selected: 'A' }, privateContent: { values: { selected: 'A' } } } });
    expect(snapshot.state.modelContent).toEqual({ selected: 'A' });
    expect(view.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'state-result', id: 4, ok: true }), '*');
    await act(async () => currentApiMock().emit('uiWidget:updated', { path: 'E:/other/01-example.inline.html', artifactVersion: 2 }));
    expect(view.container.querySelector('iframe')).toBe(view.frame);
    await act(async () => currentApiMock().emit('uiWidget:updated', { path, artifactVersion: 2 }));
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBe(view.frame));
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toContain('attempt=1');
  });
  it('wheel moves its owning chat and announces manual reading before scrolling', async () => {
    const view = await setup();
    const owner = document.createElement('div'); owner.style.overflowY = 'auto';
    Object.defineProperties(owner, { scrollHeight: { value: 5000 }, clientHeight: { value: 500 } });
    view.container.parentElement!.append(owner); owner.append(view.container); owner.scrollTop = 1000;
    const manual = vi.fn(() => expect(owner.scrollTop).toBe(1000)); owner.addEventListener('chat-scroll:user-interaction', manual);
    await view.post({ type: 'wheel', deltaY: -120, deltaMode: 0 });
    expect(manual).toHaveBeenCalledOnce(); expect(owner.scrollTop).toBe(880);
  });
  it('resize alone is not a v2 successful render receipt, and save failures have an explicit ack', async () => {
    const view = await setup();
    await view.post({ type: 'resize', height: 1800, stats: { ok: 1, degraded: 0 } });
    expect(view.frame.style.height).toBe('1800px');
    expect(view.container.querySelector('.is-loading')).toBeTruthy();
    await view.post({ type: 'render', status: 'rendered' });
    expect(view.container.querySelector('.is-loading')).toBeNull();
    currentApiMock().override('uiWidgets.save', async () => { throw new Error('磁盘不可写'); });
    await view.post({ type: 'state', id: 8, state: { modelContent: { a: 1 } } });
    expect(view.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'state-result', id: 8, ok: false, error: '磁盘不可写' }), '*');
    expect(screen.getByRole('status').textContent).toContain('磁盘不可写');
  });
  it('translates a known host save failure while preserving the bridge receipt and author messages', async () => {
    const view = await setup();
    const original = new Error('交互状态必须是 JSON 对象');
    currentApiMock().override('uiWidgets.save', async () => { throw original; });
    try {
      await view.post({ type: 'state', id: 9, state: {} });
      expect(view.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'state-result', id: 9, ok: false, error: original.message }), '*');
      act(() => { applyLocaleSetting('en'); });
      expect(screen.getByRole('status').textContent).toContain('Interactive state must be a JSON object');
      expect(original.message).toBe('交互状态必须是 JSON 对象');
      await view.post({ type: 'state-warning', message: '交互状态必须是 JSON 对象' });
      expect(screen.getByRole('status').textContent).toContain('交互状态必须是 JSON 对象');
    } finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('covers known host error resources and preserves unknown diagnostics', () => {
    try {
      applyLocaleSetting('en');
      for (const key of UI_WIDGET_HOST_ERROR_KEYS) expect(localizeUiWidgetHostError(key), key).not.toBe(key);
      expect(localizeUiWidgetHostError('交互状态超出 256 KiB：已用 300000 字节，上限 262144 字节；请只保存选择 ID 和界面参数'))
        .toBe('Interactive state exceeds 256 KiB: 300000 bytes used, limit 262144 bytes. Save only selection IDs and interface parameters.');
      expect(localizeUiWidgetHostError("Error invoking remote method 'uiWidget:save': Error: 部件路径无效")).toBe('Invalid widget path');
      expect(localizeUiWidgetHostError('作者的原始错误')).toBe('作者的原始错误');
    } finally { applyLocaleSetting('zh-CN'); }
  });
  it('cancelled sending does not touch the composer, and action failure is acknowledged', async () => {
    const view = await setup();
    const followup = vi.fn(); window.addEventListener(UI_FOLLOWUP_EVENT, followup);
    try {
      currentApiMock().override('uiWidgets.action', async () => ({ ok: true, cancelled: true, type: 'followup', text: '不应回填', mode: 'send' }));
      await view.post({ type: 'action', id: 10, action: { type: 'followup', mode: 'send', text: '不应回填' } });
      await waitFor(() => expect(view.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'action-result', id: 10, ok: true, result: expect.objectContaining({ cancelled: true }) }), '*'));
      expect(followup).not.toHaveBeenCalled();
      currentApiMock().override('uiWidgets.action', async () => ({ ok: false, error: '发送未完成' }));
      await view.post({ type: 'action', id: 11, action: { type: 'followup', mode: 'send', text: '失败回执' } });
      await waitFor(() => expect(view.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'action-result', id: 11, ok: false, error: '发送未完成' }), '*'));
      expect(followup).not.toHaveBeenCalled();
    } finally { window.removeEventListener(UI_FOLLOWUP_EVENT, followup); }
  });
  it('font scale and workspace appearance update through the host subscriptions', async () => {
    const view = await setup();
    try {
      await act(async () => resetUiFontForTest({ font: 'system', scale: 'comfortable' }));
      expect(view.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'appearance', cssVars: expect.objectContaining({ '--fs-body': '16px', '--font-sans': expect.not.stringContaining('OPPO') }) }), '*');
      const previous = view.source.postMessage.mock.calls.at(-1)![0].cssVars['--bg-card'];
      await act(async () => setWorkspaceAppearance({ workspaceId: 'colored', accent: '#1874a3', enabled: true }));
      const appearance = view.source.postMessage.mock.calls.at(-1)![0];
      expect(appearance.type).toBe('appearance');
      expect(appearance.cssVars['--bg-card']).toBe(appearance.cssVars['--surface-canvas']);
      expect(appearance.cssVars['--bg-canvas']).toBe(appearance.cssVars['--surface-canvas']);
      expect(appearance.cssVars['--bg-card']).not.toBe(previous);
      await act(async () => resetUiFontForTest({ font: 'system', scale: 'compact' }));
      expect(view.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'appearance', cssVars: expect.objectContaining({ '--fs-body': '14px' }) }), '*');
    } finally {
      await act(async () => { resetUiFontForTest(); setWorkspaceAppearance({ workspaceId: null, accent: '#8b7bff', enabled: false }); });
    }
  });
});
