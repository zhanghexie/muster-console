import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromptTaskPanel } from '../../src/renderer/src/components/PromptTaskPanel';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

it('deletes a scheduled task only from the shared dialog; cancelling preserves it', async () => {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  try {
    const api = currentApiMock();
    const ws = { id: 'ws', name: 'Demo', path: '/demo', openedAt: 1 };
    const task = { id: 'task', name: '巡检', workspaceId: 'ws', runtime: 'shell', prompt: 'Check', enabled: false, createdAt: 1, schedule: { kind: 'daily', time: '09:00' } };
    api.override('workspaces.list', async () => ({ workspaces: [ws], activeWorkspaceId: 'ws' }));
    api.override('config.get', async () => ({ workspaces: [ws], activeWorkspaceId: 'ws', locale: 'zh-CN' }));
    api.override('runtimes.list', async () => []);
    api.override('runtimes.availability', async () => ({ runtimes: [], acpAgents: [], checkedAt: 1 }));
    api.override('services.list', async () => ({ services: [task] }));
    api.override('services.get', async () => task);
    api.override('services.runs', async () => ({ runs: [] }));
    api.override('agentSession.getHarnessModelSelections', async () => ({}));
    api.override('services.delete', async () => { api.override('services.list', async () => ({ services: [] })); });
    render(<StoreProvider><PromptTaskPanel/></StoreProvider>);
    const row = await screen.findByRole('option', { name: /巡检/ });
    expect(screen.queryByRole('region', { name: '任务详情' })).toBeNull();
    await userEvent.click(row);
    expect(await screen.findByRole('region', { name: '任务详情' })).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: '删除任务' }));
    const dialog = await screen.findByRole('dialog', { name: '确认删除该任务？' });
    expect(dialog.closest('.prompt-task-detail')).toBeNull();
    expect(api.mockOf('services.delete')).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(api.mockOf('services.delete')).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '删除任务' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: '确认删除该任务？' })).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(api.mockOf('services.delete')).toHaveBeenCalledExactlyOnceWith('task'));
  } finally {
    if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});
