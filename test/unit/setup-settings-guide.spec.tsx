import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModelProviderPane } from '../../src/renderer/src/components/settings/ModelProviderPane';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import type { AppConfig } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

vi.mock('../../src/renderer/src/onboarding/SetupCoachmark', () => ({
  SetupCoachmark: ({ children, actions, onDismiss, progress, target, fallbackTarget }: any) => <aside aria-label="setup-guide" data-target={target} data-fallback={fallbackTarget}><span>{progress}</span>{children}{actions}<button onClick={onDismiss}>dismiss-guide</button></aside>
}));

it('模型引导可回退和关闭，添加菜单期间隐藏并在真实添加后推进', async () => {
  currentApiMock().override('config.piCatalog', async () => null);
  function Flow() {
    const [cfg, setCfg] = useState({ openai: { baseUrl: '', apiKey: '', model: '' }, llm: { providers: [{ id: 'custom', name: 'Fixture', baseUrl: 'https://example.com', apiKey: '', enabled: true, models: [] }], activeProviderId: 'custom', activeModelId: '' } } as unknown as AppConfig);
    return <ModelProviderPane cfg={cfg} set={patch => setCfg(value => ({ ...value, ...patch }))} setupGuide />;
  }
  render(<KeybindingProvider><Flow /></KeybindingProvider>);
  expect(screen.getByText('1 / 4')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(screen.getByText('2 / 4')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '上一步' }));
  fireEvent.click(screen.getByRole('button', { name: '＋ 添加供应商' }));
  expect(screen.queryByLabelText('setup-guide')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: /自定义供应商/ }));
  expect(screen.getByText('2 / 4')).toBeTruthy();
  expect(guideAnchor()).toBe(screen.getByLabelText('API Key'));
  fireEvent.click(screen.getByRole('button', { name: 'dismiss-guide' }));
  expect(screen.queryByLabelText('setup-guide')).toBeNull();
});

function guideAnchor() {
  const guide = screen.getByLabelText('setup-guide');
  return document.querySelector(guide.getAttribute('data-target')!)
    ?? document.querySelector(guide.getAttribute('data-fallback')!);
}

it('添加模型步骤显露实际入口，编辑草稿不反复抢滚动位置', async () => {
  currentApiMock().override('config.piCatalog', async () => null);
  currentApiMock().override('config.providerModelCatalog', async () => ({ ok: true, snapshot: null }));
  const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
  function Flow() {
    const [cfg, setCfg] = useState({ openai: { baseUrl: '', apiKey: '', model: '' }, llm: {
      providers: [{ id: 'custom', name: 'Fixture', baseUrl: 'https://example.com', apiKey: '', models: [] }],
      activeProviderId: 'custom', activeModelId: ''
    } } as unknown as AppConfig);
    return <ModelProviderPane cfg={cfg} set={patch => setCfg(value => ({ ...value, ...patch }))} setupGuide />;
  }
  try {
    render(<KeybindingProvider><Flow /></KeybindingProvider>);
    scroll.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    const keyInput = screen.getByLabelText('API Key');
    await waitFor(() => expect(scroll.mock.contexts).toContain(keyInput));
    expect(guideAnchor()).toBe(keyInput);
    fireEvent.change(keyInput, { target: { value: 'fixture-key' } });
    expect(screen.getByText('2 / 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    const entry = screen.getByRole('button', { name: '＋ 添加模型' });
    await waitFor(() => expect(scroll.mock.contexts).toContain(entry));
    const calls = scroll.mock.calls.length;
    fireEvent.change(screen.getByRole('textbox', { name: '供应商名称' }), { target: { value: 'Edited' } });
    fireEvent.change(keyInput, { target: { value: 'different-fixture-key' } });
    expect(scroll.mock.calls).toHaveLength(calls);
    expect(guideAnchor()).toBe(entry);
  } finally {
    scroll.mockRestore();
  }
});

it('模型引导优先真实目录入口，实际打开时隐藏，选模型后推进默认步骤', async () => {
  currentApiMock().override('config.piCatalog', async () => null);
  currentApiMock().override('config.providerModelCatalog', async () => ({ ok: true, snapshot: {
    fetchedAt: Date.now(), models: [{ id: 'qwen4-max', name: 'Qwen4 Max' }]
  } }));
  function Flow() {
    const [cfg, setCfg] = useState({ openai: { baseUrl: '', apiKey: '', model: '' }, llm: {
      providers: [{ id: 'qwen-token-plan-cn', name: 'Qwen Token Plan', baseUrl: 'https://example.com', apiKey: 'fixture', enabled: true, models: [] }],
      activeProviderId: 'qwen-token-plan-cn', activeModelId: ''
    } } as unknown as AppConfig);
    return <ModelProviderPane cfg={cfg} set={patch => setCfg(value => ({ ...value, ...patch }))} setupGuide />;
  }
  render(<KeybindingProvider><Flow /></KeybindingProvider>);
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  const catalog = await screen.findByRole('button', { name: '从目录添加（1）' });
  expect(guideAnchor()).toBe(catalog);
  fireEvent.click(catalog);
  expect(screen.queryByLabelText('setup-guide')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'qwen4-max' }));
  expect(screen.queryByRole('dialog', { name: '从目录添加' })).toBeNull();
  expect(screen.getByText('4 / 4')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '上一步' }));
  expect(guideAnchor()).toBe(screen.getByRole('button', { name: '＋ 添加模型' }));
  fireEvent.click(guideAnchor()!);
  expect(screen.queryByLabelText('setup-guide')).toBeNull();
  expect(screen.getByRole('heading', { name: '添加模型配置' })).toBeTruthy();
});

it('目录缺失时回退手动入口，切换供应商后定位新的目录并关闭旧目录', async () => {
  currentApiMock().override('config.piCatalog', async () => null);
  currentApiMock().override('config.providerModelCatalog', async (provider: any) => ({ ok: true,
    snapshot: provider.id === 'custom' ? null : { fetchedAt: Date.now(), models: [{ id: 'available-model' }] }
  }));
  const cfg = { openai: { baseUrl: '', apiKey: '', model: '' }, llm: {
    providers: ['custom', 'catalog', 'other'].map(id => ({ id, name: id, baseUrl: 'https://example.com', apiKey: '', enabled: true, models: [] })),
    activeProviderId: 'custom', activeModelId: ''
  } } as unknown as AppConfig;
  render(<KeybindingProvider><ModelProviderPane cfg={cfg} set={() => {}} setupGuide /></KeybindingProvider>);
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(guideAnchor()).toBe(screen.getByRole('button', { name: '＋ 添加模型' }));
  fireEvent.click(screen.getByTitle('catalog'));
  const catalog = await screen.findByRole('button', { name: '从目录添加（1）' });
  expect(guideAnchor()).toBe(catalog);
  fireEvent.click(catalog);
  expect(screen.queryByLabelText('setup-guide')).toBeNull();
  fireEvent.click(screen.getByTitle('other'));
  await waitFor(() => expect(screen.getByLabelText('setup-guide')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'available-model' })).toBeNull();
  expect(guideAnchor()).toBe(await screen.findByRole('button', { name: '从目录添加（1）' }));
});
