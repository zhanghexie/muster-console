import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderModelCatalogPicker } from '../../src/renderer/src/components/settings/ProviderModelCatalogPicker';
import { currentApiMock } from './helpers/api-mock';
import type { ProviderModelCatalogResult } from '../../src/shared/providerModelCatalog';

beforeEach(() => dismissTip());

const provider = { id: 'test', baseUrl: 'https://provider.test/v1', apiKey: 'fixture' };
const builtin = new Map([['old', { name: 'Old model', contextWindow: 128000, reasoning: true }], ['configured', { name: 'Configured' }]]);
const models = [{ id: 'configured' }];
const snapshot = { fetchedAt: 1794672000000, models: [{ id: 'new', name: 'New model', contextWindow: 200000, maxTokens: 8192 }] };
function deferred() { let resolve!: (result: ProviderModelCatalogResult) => void; const promise = new Promise<ProviderModelCatalogResult>(done => { resolve = done; }); return { promise, resolve }; }

describe('provider model catalog', () => {
  it('reads cache without network refresh, then replaces candidates and preserves configured models', async () => {
    const api = currentApiMock(); const pending = deferred(); const add = vi.fn();
    api.override('config.providerModelCatalog', async (_provider, refresh) => refresh ? pending.promise : { ok: true, snapshot: null });
    render(<ProviderModelCatalogPicker provider={provider} builtin={builtin} models={models} onAdd={add}/>);
    const user = userEvent.setup();
    await waitFor(() => expect((screen.getByRole('button', { name: '刷新目录' }) as HTMLButtonElement).disabled).toBe(false));
    expect(api.mockOf('config.providerModelCatalog')).toHaveBeenCalledWith(provider);
    await user.click(screen.getByRole('button', { name: '从目录添加（1）' }));
    expect(screen.getByRole('button', { name: /old/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    expect((screen.getByRole('button', { name: '读取中…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.mockOf('config.providerModelCatalog')).toHaveBeenLastCalledWith(provider, true);
    pending.resolve({ ok: true, snapshot });
    await screen.findByRole('button', { name: /new/ });
    expect(screen.queryByRole('button', { name: /old/ })).toBeNull();
    expect(models).toEqual([{ id: 'configured' }]); expect(add).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /new/ }));
    expect(add).toHaveBeenCalledWith({ id: 'new', name: 'New model', contextWindow: 200000, maxTokens: 8192 });
  });

  it('restores server snapshots, including empty lists, instead of merging retired builtin IDs', async () => {
    currentApiMock().override('config.providerModelCatalog', async () => ({ ok: true, snapshot: { ...snapshot, models: [] } }));
    render(<ProviderModelCatalogPicker provider={provider} builtin={builtin} models={models} onAdd={vi.fn()}/>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '从目录添加（0）' }));
    expect(await screen.findByText('目录中没有尚未添加的模型。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /old/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('0 个模型');
  });

  it.each(['HTTP 401: invalid key', '服务商未提供模型列表接口（HTTP 404），请手动添加模型。'])('falls back to the built-in catalog and enables retry after %s', async error => {
    currentApiMock().override('config.providerModelCatalog', async (_provider, refresh) => refresh ? { ok: false, error } : { ok: true, snapshot });
    render(<ProviderModelCatalogPicker provider={provider} builtin={builtin} models={models} onAdd={vi.fn()}/>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '从目录添加（1）' }));
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    await waitFor(() => expect(getTipSnapshot()).toMatchObject({ text: error, tone: 'error' }));
    expect(screen.getByRole('button', { name: /old/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('回退到内置目录');
    expect((screen.getByRole('button', { name: '刷新目录' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('falls back to the last successful remote catalog for a custom provider', async () => {
    currentApiMock().override('config.providerModelCatalog', async (_provider, refresh) => refresh
      ? { ok: false, error: 'HTTP 401: invalid key' } : { ok: true, snapshot });
    render(<ProviderModelCatalogPicker provider={provider} models={models} onAdd={vi.fn()}/>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '刷新目录' }));
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    await waitFor(() => expect(getTipSnapshot()?.text).toContain('HTTP 401'));
    await user.click(screen.getByRole('button', { name: '从目录添加（1）' }));
    expect(screen.getByRole('button', { name: /new/ })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('保留上次成功目录');
  });

  it('offers refresh for a custom provider without any builtin catalog', async () => {
    currentApiMock().override('config.providerModelCatalog', async (_provider, refresh) => ({ ok: true, snapshot: refresh ? snapshot : null }));
    render(<ProviderModelCatalogPicker provider={provider} models={models} onAdd={vi.fn()}/>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '刷新目录' }));
    await user.click(await screen.findByRole('button', { name: '从目录添加（1）' }));
    expect(await screen.findByRole('button', { name: /new/ })).toBeTruthy();
  });

  it('discards requests after a draft endpoint or credential changes', async () => {
    const pending = deferred();
    currentApiMock().override('config.providerModelCatalog', async (_provider, refresh) => refresh ? pending.promise : { ok: true, snapshot: null });
    const { rerender } = render(<ProviderModelCatalogPicker provider={provider} builtin={builtin} models={models} onAdd={vi.fn()}/>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '刷新目录' }));
    rerender(<ProviderModelCatalogPicker provider={{ ...provider, baseUrl: 'https://other.test/v1', apiKey: 'other' }} builtin={builtin} models={models} onAdd={vi.fn()}/>);
    pending.resolve({ ok: true, snapshot });
    await waitFor(() => expect((screen.getByRole('button', { name: '刷新目录' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '从目录添加（1）' }));
    expect(screen.getByRole('button', { name: /old/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new/ })).toBeNull();
  });

  it('keeps builtin metadata without pinning it when adding a known model; toggles presence and focusability', async () => {
    const add = vi.fn();
    currentApiMock().override('config.providerModelCatalog', async () => ({ ok: true, snapshot: { ...snapshot, models: [{ id: 'old' }] } }));
    render(<ProviderModelCatalogPicker provider={provider} builtin={builtin} models={models} onAdd={add}/>);
    const user = userEvent.setup();
    const toggle = await screen.findByRole('button', { name: '从目录添加（1）' });
    await user.click(toggle);
    const panel = document.querySelector('.llm-catalog-picker')!;
    expect(panel.classList.contains('mp-panel')).toBe(true);
    await user.click(screen.getByRole('button', { name: /old/ }));
    expect(add).toHaveBeenCalledWith({ id: 'old', name: 'Old model' });
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: /old/ })).toBeTruthy();
  });
});
