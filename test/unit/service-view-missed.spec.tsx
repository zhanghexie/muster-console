/**
 * 触发任务详情：错过策略 + 待确认补跑（T3.4）
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceView } from '../../src/renderer/src/components/ServiceView';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import type { PromptTask } from '../../src/shared/types';

const TASK: PromptTask = {
  id: 'task-missed',
  name: '巡检',
  workspaceId: 'ws1',
  runtime: 'cursor-cli',
  prompt: 'run',
  schedule: { kind: 'daily', time: '09:00' },
  enabled: true,
  createdAt: 1,
  missedPolicy: 'confirm',
  missedPendingConfirm: true
};

describe('ServiceView 错过策略（T3.4）', () => {
  it('confirm 待确认时显示提示与确认补跑，点击走 runNow', async () => {
    const api = currentApiMock();
    api.override('services.get', () => Promise.resolve({ ...TASK }));
    api.override('services.runs', () => Promise.resolve({ runs: [] }));
    api.override('config.get', () => Promise.resolve({ llm: { providers: [] }, workspaces: [], activeWorkspaceId: null }));
    api.override('services.runNow', () => Promise.resolve(TASK));
    const runtime = { id: 'cursor-cli', label: 'Cursor CLI', enabled: true };
    api.override('runtimes.list', async () => [runtime]);
    api.override('runtimes.availability', async () => ({ runtimes: [runtime], acpAgents: [], checkedAt: 1 }));

    render(
      <StoreProvider>
        <ServiceView serviceId="task-missed" />
      </StoreProvider>
    );

    expect(await screen.findByTestId('missed-pending-hint')).toBeTruthy();
    const btn = await screen.findByRole('button', { name: '确认补跑' });
    await userEvent.click(btn);
    await waitFor(() => {
      expect(api.mockOf('services.runNow')).toHaveBeenCalledWith('task-missed');
    });
  });
});
