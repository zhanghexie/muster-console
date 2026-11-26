import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhoneSettings } from '../../src/renderer/src/agentApps/PhoneSettings';
import { builtInAgentApps } from '../../src/shared/agentAppsBuiltins';
import type { AppLibraryItem, AppSnapshot } from '../../src/shared/agentApps';
import { currentApiMock } from './helpers/api-mock';

const snapshot: AppSnapshot = { workspaceId: 'one', apps: builtInAgentApps().map(definition => ({ definition, enabled: true, installedAt: 1 })), operations: [], connections: [], errors: [] };
const entry: AppLibraryItem = { catalogId: 'catalog-1', appId: 'shared-notes', name: '共享记录', description: '个人记录', version: 2, private: false, canManageVisibility: false, conflict: false, updateAvailable: false };

beforeEach(() => currentApiMock().override('agentApps.listLibrary', async () => [entry]));

describe('phone app library', () => {
  it('discovers and explicitly installs a shared app in the current workspace', async () => {
    render(<PhoneSettings workspaceId="one" snapshot={snapshot} auto={false} setAuto={() => {}} refresh={() => {}}/>);
    fireEvent.click(await screen.findByRole('button', { name: '安装 共享记录' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.installFromLibrary')).toHaveBeenCalledWith('one', 'catalog-1'));
  });
  it('requires an explicit update and shows identity conflicts', async () => {
    currentApiMock().override('agentApps.listLibrary', async () => [{ ...entry, installedVersion: 1, updateAvailable: true, conflict: true }]);
    render(<PhoneSettings workspaceId="one" snapshot={snapshot} auto={false} setAuto={() => {}} refresh={() => {}}/>);
    expect(await screen.findByText('应用标识冲突')).toBeTruthy();
    expect(currentApiMock().mockOf('agentApps.installFromLibrary')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '更新 共享记录' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.installFromLibrary')).toHaveBeenCalledWith('one', 'catalog-1'));
  });
});
