import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhoneSettings } from '../../src/renderer/src/agentApps/PhoneSettings';
import { builtInAgentApps } from '../../src/shared/agentAppsBuiltins';
import { defineRecordApp, type AppSnapshot } from '../../src/shared/agentApps';
import { currentApiMock } from './helpers/api-mock';

const custom = defineRecordApp({ id: 'notes', name: '我的记录', fields: [{ id: 'title', label: '标题', type: 'text', required: true }], titleField: 'title' });
const snapshot: AppSnapshot = { workspaceId: 'one', apps: [...builtInAgentApps(), custom].map(definition => ({ definition, enabled: true, installedAt: 1 })), operations: [], connections: [], errors: [] };
const renderSettings = () => render(<PhoneSettings workspaceId="one" snapshot={snapshot} auto={false} setAuto={() => {}} refresh={() => {}}/>);

describe('phone custom-app uninstall', () => {
  it('only custom apps can be uninstalled and data is retained by default', async () => {
    renderSettings();
    expect(screen.queryByRole('button', { name: '卸载 待办' })).toBeNull();
    expect(screen.queryByRole('button', { name: '卸载 提醒' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '卸载 我的记录' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.uninstall')).toHaveBeenCalledWith('one', 'notes', false));
  });

  it('deletes the data only after the explicit checkbox is selected', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('checkbox', { name: '同时删除 我的记录 的数据' }));
    fireEvent.click(screen.getByRole('button', { name: '卸载 我的记录' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.uninstall')).toHaveBeenCalledWith('one', 'notes', true));
  });
});
