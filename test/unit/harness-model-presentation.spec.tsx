import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { HarnessPickerModel } from '../../src/shared/harnessPicker';
import type { AppConfig } from '../../src/shared/types';
import { HarnessModelPicker } from '../../src/renderer/src/components/HarnessModelPicker';
import { HarnessModelSelectionPanel } from '../../src/renderer/src/components/settings/HarnessModelSelectionPanel';
import { currentApiMock } from './helpers/api-mock';
import { pickerCatalog } from './helpers/picker-catalog';

const cfg = { activeWorkspaceId: 'w', workspaces: [{ id: 'w', name: 'Fixture', path: '/workspace', roots: [{ id: 'r', path: '/workspace' }], defaultRootId: 'r', rootsRevision: 1 }],
  llm: { providers: ['a', 'b'].map(id => ({ id, name: `Account ${id}`, models: [{ id: 'same', name: 'Same model' }] })) } } as AppConfig;
const coreModels: HarnessPickerModel[] = ['a', 'b'].map(id => ({ providerId: id, modelId: 'same', label: 'Same model', group: { id, label: `Account ${id}` } }));
const aliases: HarnessPickerModel[] = ['opus', 'sonnet', 'haiku'].map(modelId => ({ providerId: 'claude', modelId, label: 'glm-5.3-flash[1m]' }));

beforeEach(() => { currentApiMock().override('agentSession.getHarnessModelSelections', async () => ({})); });
function picker(models: HarnessPickerModel[]) {
  const api = currentApiMock();
  api.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, { models }));
  const confirm = vi.fn(async () => ({ ok: true }));
  const view = render(<HarnessModelPicker target={{ sessionId: 'fixture' }} onCancel={() => {}} onConfirm={confirm} confirmLabel="确认配置"/>);
  return { ...view, api, confirm };
}

it('groups Core models, searches the provider and submits the original identity', async () => {
  const { confirm } = picker(coreModels);
  const account = await screen.findByRole('group', { name: 'Account b' });
  const model = within(account).getByRole('option', { name: 'Same model' });
  expect(model.querySelector('small')).toBeNull();
  await userEvent.click(model);
  await waitFor(() => expect((screen.getByRole('button', { name: '确认配置' }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole('button', { name: '确认配置' }));
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ model: expect.objectContaining({ providerId: 'b', modelId: 'same', label: 'Same model' }) }));
  await userEvent.type(screen.getByRole('searchbox', { name: '搜索模型' }), 'Account a');
  expect(screen.queryByRole('group', { name: 'Account b' })).toBeNull();
  expect(screen.getByRole('group', { name: 'Account a' })).toBeTruthy();
});

it('reloads a mounted Core picker after publication and lets the user clear a retired draft value', async () => {
  const api = currentApiMock();
  const model = coreModels[0];
  let efforts = ['medium', 'high', 'xhigh'];
  api.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, {
    models: [model], current: { providerId: model.providerId, modelId: model.modelId },
    controls: [{ descriptor: { id: 'reasoning', semantic: 'reasoning', label: '思考强度', supportsDefault: true,
      apply: 'next-turn', defaultValue: 'high', options: efforts.map(value => ({ value, label: value })) },
      effectiveValue: 'high', override: null, source: 'engine' }]
  }));
  const confirm = vi.fn(async () => ({ ok: true }));
  render(<HarnessModelPicker target={{ sessionId: 'core-session' }} onCancel={vi.fn()} onConfirm={confirm} confirmLabel="确认配置" />);
  const initial = await screen.findByRole('radio', { name: 'xhigh' });
  await userEvent.click(initial);
  expect(initial.getAttribute('aria-checked')).toBe('true');
  efforts = ['high', 'xhigh', 'turbo'];
  await act(async () => api.emit('agentSession:coreReasoningCatalogUpdated', {}));
  await screen.findByRole('radio', { name: 'turbo' });
  await waitFor(() => expect(screen.getByRole('radio', { name: 'xhigh' }).getAttribute('aria-checked')).toBe('true'));
  efforts = ['high', 'turbo'];
  await act(async () => api.emit('agentSession:coreReasoningCatalogUpdated', {}));
  const submit = screen.getByRole('button', { name: '确认配置' }) as HTMLButtonElement;
  const clear = await screen.findByRole('button', { name: '清除失效参数' });
  expect(clear.closest('[role="status"]')?.textContent).toContain('部分已选模型参数不再可用。');
  expect(submit.disabled).toBe(true);
  expect(screen.queryByRole('radio', { name: 'xhigh' })).toBeNull();
  await userEvent.click(clear);
  expect(submit.disabled).toBe(false);
  await userEvent.click(submit);
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ parameters: {} }));
});

it('switches the visible Token Plan thinking options when the model changes', async () => {
  const api = currentApiMock();
  const providerId = 'qwen-token-plan-cn';
  const deepseekId = 'deepseek-v4.1-flash-1017';
  const previewId = 'qwen4-max-preview';
  const models = [deepseekId, previewId].map(modelId => ({ providerId, modelId, label: modelId,
    group: { id: providerId, label: 'Qwen Token Plan CN' } }));
  api.override('agentSession.readHarnessPickerCatalog', async request => {
    const preview = request.model?.modelId === previewId;
    const options = (preview ? ['off', 'low', 'medium', 'xhigh'] : ['low', 'high', 'max'])
      .map(value => ({ value, label: value === 'off' ? '关闭' : value }));
    return pickerCatalog(request, { models, current: { providerId, modelId: deepseekId },
      controls: [{ descriptor: { id: 'reasoning', semantic: 'reasoning', label: '思考强度', supportsDefault: true,
        apply: 'next-turn', options, ...(preview ? { defaultValue: 'xhigh' } : {}) },
        effectiveValue: preview ? 'xhigh' : null, override: null, source: 'engine' }] });
  });
  const confirm = vi.fn(async () => ({ ok: true }));
  render(<HarnessModelPicker target={{ sessionId: 'token-plan-session' }} onCancel={vi.fn()} onConfirm={confirm} confirmLabel="确认配置"/>);
  await userEvent.click(await screen.findByRole('radio', { name: 'max' }));
  await userEvent.click(screen.getByRole('option', { name: previewId }));
  const group = await screen.findByRole('radiogroup', { name: '思考强度' });
  await within(group).findByRole('radio', { name: 'medium' });
  expect(within(group).getAllByRole('radio').map(option => option.textContent)).toEqual(['跟随默认', '关闭', 'low', 'medium', 'xhigh']);
  await userEvent.click(within(group).getByRole('radio', { name: 'medium' }));
  await userEvent.click(screen.getByRole('button', { name: '确认配置' }));
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
    model: expect.objectContaining({ providerId, modelId: previewId }), parameters: { reasoning: 'medium' }
  }));
});

it('keeps Claude aliases distinct, including when search leaves a single match', async () => {
  const { confirm } = picker(aliases);
  const sonnet = await screen.findByRole('option', { name: 'glm-5.3-flash[1m] sonnet' });
  expect(sonnet.querySelector('small')?.textContent).toBe('sonnet');
  await userEvent.type(screen.getByRole('searchbox', { name: '搜索模型' }), 'sonnet');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  await userEvent.click(screen.getByRole('option', { name: 'glm-5.3-flash[1m] sonnet' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '确认配置' }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole('button', { name: '确认配置' }));
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ model: expect.objectContaining({ modelId: 'sonnet' }) }));
});

it('keeps opaque external model names intact and exposes IDs through search and title', async () => {
  const label = '[QwenCloud Token Plan] qwen3.8-max';
  picker([{ providerId: 'acp', modelId: 'qwen3.8-max(openai)', label }]);
  const option = await screen.findByRole('option', { name: label });
  expect(option.title).toContain('qwen3.8-max(openai)');
  expect(option.querySelector('small')).toBeNull();
  expect(screen.queryByRole('group')).toBeNull();
  await userEvent.type(screen.getByRole('searchbox', { name: '搜索模型' }), '(openai)');
  expect(screen.getByRole('option', { name: label })).toBeTruthy();
});

it('keyboard navigation skips group headings and crosses provider groups', async () => {
  picker(coreModels);
  const first = within(await screen.findByRole('group', { name: 'Account a' })).getByRole('option');
  act(() => { first.focus(); });
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(within(screen.getByRole('group', { name: 'Account b' })).getByRole('option'));
});

it('settings groups Core providers and changes only the selected native ID', async () => {
  const api = currentApiMock();
  api.override('agentSession.setHarnessModelSelection', async () => ({}));
  render(<HarnessModelSelectionPanel cfg={cfg} runtimeId="pi" active compact/>);
  const checkbox = await within(await screen.findByRole('group', { name: 'Account b' })).findByRole('checkbox', { name: 'Same model' });
  await waitFor(() => expect((checkbox as HTMLInputElement).disabled).toBe(false));
  await userEvent.click(checkbox);
  expect(api.mockOf('agentSession.setHarnessModelSelection')).toHaveBeenCalledWith({ key: 'runtime:pi', modelIds: [JSON.stringify(['a', 'same'])] });
});

it('settings shows only required alias qualifiers, including after search', async () => {
  currentApiMock().override('agentSession.listLocalHarnessModels', async () => ({ ok: true, items: aliases.map(m => ({ id: m.modelId, name: m.label })) }));
  render(<HarnessModelSelectionPanel cfg={cfg} runtimeId="claude" active compact/>);
  const checkbox = await screen.findByRole('checkbox', { name: 'glm-5.3-flash[1m] opus' });
  expect(checkbox.closest('label')?.title).toContain('opus');
  await userEvent.type(screen.getByRole('searchbox', { name: '搜索模型' }), 'opus');
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: 'glm-5.3-flash[1m] opus' })).toBeTruthy();
});
