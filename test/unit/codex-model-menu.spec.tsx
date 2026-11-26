import { renderWithAppTips as render, getAppTip } from './helpers/app-tips';
import {overrideGuiHistory} from './helpers/gui-history-range';
/** 实际 GUI 适配器 → ChatSurfaceView → Composer：Codex 目录、覆盖与恢复默认。 */
import React from 'react';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { currentApiMock } from './helpers/api-mock';
import type { ChatModelSelection } from '../../src/shared/chatSurface';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { pickerCatalog } from './helpers/picker-catalog';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
function View() {
  const surface = useAgentSessionSurface({ sessionId: 'codex-test', visible: true, runtimeId: 'codex-gui' });
  return <ChatSurfaceView surface={surface} workspaceId="ws-a" />;
}
function AcpView() {
  const surface = useAgentSessionSurface({ sessionId: 'acp-test', visible: true, runtimeId: 'acp' });
  return <ChatSurfaceView surface={surface} workspaceId="ws-a" />;
}
const catalog = { ok: true, source: 'app-server', defaultModelId: 'cli-default', items: [{ id: 'cli-default', displayName: 'CLI Default' }, { id: 'chosen', displayName: 'Selected Codex' }] };
function seed() {
  let model: ChatModelSelection | null = null;
  const mock = currentApiMock();
  mock.override('config.get', async () => ({ locale: 'zh-CN', workspaces: [], activeWorkspaceId: null, llm: { activeProviderId: 'other', activeModelId: 'deepseek', providers: [{ id: 'other', name: 'Other', models: [{ id: 'deepseek', name: 'Unrelated Global' }] }] } }));
  overrideGuiHistory(mock, async () => ({ messages: [], busy: true, mode: 'default', modelOverride: model, thinkingConfigured: false }));
  mock.override('agentSession.listCodexModels', async () => catalog);
  mock.override('agentSession.setModel', async (_id, next) => { model = next; return { ok: true, applied: 'next-turn' }; });
  mock.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, {
    harness: { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui' }, current: model, canRefresh: true,
    models: catalog.items.map(item => ({ providerId: 'codex-gui', modelId: item.id, label: item.displayName }))
  }));
  mock.override('agentSession.setModelConfiguration', async input => { model = input.model; return { ok: true, applied: 'next-turn' }; });
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!document.execCommand) document.execCommand = () => false;
  return mock;
}
function menu() { return within(document.querySelector('.agent-composer-model-menu') as HTMLElement); }
function trigger() { return document.querySelector('.agent-composer-model-trigger') as HTMLButtonElement; }

it('updates a known harness catalog error when the display language changes', async () => {
  const mock = seed(), original = '会话或引擎配置已变化，请重新打开模型目录';
  const response = { ok: false, error: original };
  overrideGuiHistory(mock, async () => ({ messages: [], busy: false, mode: 'default', piModeId: 'kimi' }));
  mock.override('agentSession.getHarnessModelSelections', async () => ({}));
  mock.override('agentSession.getSessionHarnessModelState', async () => response);
  mock.override('agentSession.readHarnessPickerCatalog', async () => response as { ok: false; error: string });
  const view = render(<StoreProvider><AcpView /></StoreProvider>);
  try {
    await waitFor(() => expect(trigger()).toBeTruthy());
    fireEvent.click(trigger());
    await waitFor(() => expect(getAppTip().textContent).toBe(original));
    act(() => { applyLocaleSetting('en'); });
    expect(getAppTip().textContent).toBe('The session or engine configuration changed. Reopen the model catalog.');
    expect(response.error).toBe(original);
  } finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
});

it('Codex 目录可选，忙时保存覆盖；重挂恢复；清除跟随 CLI，不改全局配置', async () => {
  const mock = seed();
  const view = render(<StoreProvider><View /></StoreProvider>);
  await waitFor(() => expect(trigger()?.textContent).toContain('CLI Default'));
  expect(mock.mockOf('agentSession.listCodexModels')).toHaveBeenCalledWith('codex-test', false);
  fireEvent.click(trigger());
  expect(menu().queryByText('Unrelated Global')).toBeNull();
  fireEvent.click(await menu().findByRole('option', { name: 'Selected Codex' }));
  expect(mock.mockOf('agentSession.setModelConfiguration')).not.toHaveBeenCalled();
  await confirm();
  await waitFor(() => expect(trigger().textContent).toContain('Selected Codex'));
  expect(mock.mockOf('agentSession.setModelConfiguration')).toHaveBeenCalledWith({ sessionId: 'codex-test', expected: 'test-stamp', model: { providerId: 'codex-gui', modelId: 'chosen' }, parameters: {} });
  expect(mock.mockOf('config.update')).not.toHaveBeenCalled();
  expect(mock.mockOf('agentSession.abort')).not.toHaveBeenCalled();
  view.unmount();
  render(<StoreProvider><View /></StoreProvider>);
  await waitFor(() => expect(trigger()?.textContent).toContain('Selected Codex'));
  fireEvent.click(trigger());
  fireEvent.click(await menu().findByRole('option', { name: /跟随.*默认|跟随 Codex 配置/ }));
  await confirm();
  await waitFor(() => expect(trigger().textContent).toContain('CLI Default'));
  expect(mock.mockOf('agentSession.setModelConfiguration')).toHaveBeenLastCalledWith({ sessionId: 'codex-test', expected: 'test-stamp', model: null, parameters: {} });
  expect(mock.mockOf('agentSession.listCodexModels')).not.toHaveBeenCalledWith('codex-test', true);
});

it('禁用 Codex 默认模型后显示目录中第一个允许模型，恢复全部后重新显示默认值', async () => {
  const mock = seed();
  overrideGuiHistory(mock, async () => ({ messages: [], busy: false, mode: 'default', modelOverride: null }));
  mock.override('agentSession.getHarnessModelSelections', async () => ({ 'runtime:codex-gui': ['chosen'] }));
  mock.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, {
    harness: { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui' }, models: [{ providerId: 'codex-gui', modelId: 'chosen', label: 'Selected Codex' }]
  }));
  render(<StoreProvider><View /></StoreProvider>);
  await waitFor(() => expect(trigger()?.textContent).toContain('Selected Codex'));
  fireEvent.click(trigger());
  await menu().findByRole('option', { name: 'Selected Codex' });
  expect(menu().queryByRole('option', { name: 'CLI Default' })).toBeNull();
  act(() => mock.emit('agentSession:harnessModelSelectionsChanged', { key: 'runtime:codex-gui', selections: {} }));
  await waitFor(() => expect(trigger()?.textContent).toContain('CLI Default'));
});

async function confirm() {
  const button = menu().getByRole<HTMLButtonElement>('button', { name: '确认配置' });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

it('目录缺失显示告警与刷新入口，重试恢复；点外关闭现有 presence 菜单', async () => {
  const mock = seed();
  mock.override('agentSession.listCodexModels', vi.fn().mockResolvedValueOnce({ ok: false, error: 'CLI catalog unavailable' }).mockResolvedValue(catalog));
  let refreshed = false;
  mock.override('agentSession.readHarnessPickerCatalog', async request => {
    refreshed ||= request.refresh === true;
    return pickerCatalog(request, { harness: { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui' }, canRefresh: true,
      state: refreshed ? 'ready' : 'missing', warning: refreshed ? undefined : 'CLI catalog unavailable',
      models: refreshed ? [{ providerId: 'codex-gui', modelId: 'chosen', label: 'Selected Codex' }] : [] });
  });
  render(<StoreProvider><View /></StoreProvider>);
  await waitFor(() => expect(trigger()?.textContent).toContain('Codex'));
  fireEvent.click(trigger());
  await menu().findByText('CLI catalog unavailable');
  expect(menu().queryByText('Unrelated Global')).toBeNull();
  fireEvent.click(menu().getByRole('button', { name: '刷新模型目录' }));
  await menu().findByRole('option', { name: 'Selected Codex' });
  expect(menu().queryByRole('status')).toBeNull();
  fireEvent.mouseDown(document.body);
  await waitFor(() => expect(document.querySelector('.agent-composer-model-menu')).toBeNull());
});

it('目录刷新保持草稿，确认使用新的目录版本并只提交一次', async () => {
 const mock = seed();
 let catalogVersion = 'initial';
 let finish!: () => void;
 mock.override('agentSession.readHarnessPickerCatalog', async request => {
   if (request.refresh) await new Promise<void>(resolve => { finish = resolve; });
   return pickerCatalog(request, { harness: { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui' }, canRefresh: true,
     models: [{ providerId: 'codex-gui', modelId: 'chosen', label: 'Selected Codex' }], commitStamp: catalogVersion });
 });
 render(<StoreProvider><View /></StoreProvider>);
 await waitFor(() => expect(trigger()?.textContent).toContain('CLI Default'));
 fireEvent.click(trigger());
 fireEvent.click(await menu().findByRole('option', { name: 'Selected Codex' }));
 fireEvent.click(menu().getByRole('button', { name: '刷新模型目录' }));
 expect(document.body.querySelectorAll('.agent-composer-model-menu .brand-loader')).toHaveLength(1);
 await act(async () => { catalogVersion = 'refreshed'; finish(); });
 await waitFor(() => expect(document.body.querySelector('.agent-composer-model-menu .brand-loader')).toBeNull());
 expect(menu().getByRole('option', { name: 'Selected Codex' }).getAttribute('aria-selected')).toBe('true');
 await confirm();
 expect(mock.mockOf('agentSession.setModelConfiguration')).toHaveBeenCalledTimes(1);
 expect(mock.mockOf('agentSession.setModelConfiguration')).toHaveBeenCalledWith(expect.objectContaining({ expected: 'refreshed' }));
});
