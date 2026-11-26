import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PermissionConfiguration, PermissionConfigurationSwitch, useSessionPermissionConfiguration } from '../../src/renderer/src/components/PermissionConfiguration';
import { NativeConfigLaunchFields } from '../../src/renderer/src/components/NativeSessionConfig';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { dismissTip } from '../../src/renderer/src/tips';

afterEach(() => { act(() => dismissTip()); });

function Launch() {
  const [enabled, setEnabled] = useState(false);
  return <PermissionConfiguration enabled={enabled} onChange={setEnabled}>
    <NativeConfigLaunchFields target={{ runtimeId: 'acp', source: { workspaceId: 'workspace', rootId: 'root' } }} onChange={() => {}} disabled={!enabled} />
  </PermissionConfiguration>;
}

function Session({ id, configured }: { id: string; configured?: boolean }) {
  const state = useSessionPermissionConfiguration(id, configured);
  return <>
    <PermissionConfigurationSwitch enabled={state.enabled} disabled={state.saving} onChange={value => void state.change(value)} />
    {state.enabled ? <span>native settings</span> : null}
    <AppTipHost />
  </>;
}

it('does not read a native directory until enabled; collapse immediately disables exiting controls', async () => {
  const api = currentApiMock();
  api.override('agentSession.describeNativeConfig', async () => ({ status: 'ready', revision: 1, source: 'catalog',
    identity: { runtimeId: 'acp', sourceKey: 'fixture' }, options: [{ id: 'mode', name: 'Permission Mode', type: 'select', changePolicy: 'live',
      choices: [{ value: 'native-manual', name: 'Manual' }] }] }));
  const view = render(<Launch />);
  const toggle = screen.getByRole('switch', { name: '配置权限' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(api.mockOf('agentSession.describeNativeConfig')).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  const permission = await screen.findByRole('button', { name: '权限模式' });
  expect(api.mockOf('agentSession.describeNativeConfig')).toHaveBeenCalledTimes(1);
  fireEvent.click(toggle);
  expect(screen.queryByRole('button', { name: '权限模式' })).toBeNull();
  const leaving = view.container.querySelector<HTMLElement>('.permission-config-body');
  if (leaving) {
    expect(leaving.inert).toBe(true);
    expect((permission as HTMLButtonElement).disabled).toBe(true);
  }
  fireEvent.click(toggle);
  expect(await screen.findByRole('button', { name: '权限模式' })).toBeTruthy();
});

it('changes session permissions only after persistence and reports rejection as a global tip', async () => {
  const api = currentApiMock();
  let finish!: (result: { ok: boolean; error?: string }) => void;
  api.override('sessions.setConfigurePermissions', () => new Promise(resolve => { finish = resolve; }));
  render(<Session id="worker" />);
  const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: '配置权限' });
  fireEvent.click(toggle);
  expect(toggle.disabled).toBe(true);
  expect(screen.queryByText('native settings')).toBeNull();
  expect(api.mockOf('sessions.setConfigurePermissions')).toHaveBeenCalledWith('worker', true);
  await act(async () => finish({ ok: false, error: 'Wait for the current turn' }));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('status').textContent).toBe('Wait for the current turn');
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(toggle);
  await act(async () => finish({ ok: true }));
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('native settings')).toBeTruthy();
  fireEvent.click(toggle);
  expect(api.mockOf('sessions.setConfigurePermissions')).toHaveBeenLastCalledWith('worker', false);
  await act(async () => finish({ ok: true }));
  expect(screen.queryByText('native settings')).toBeNull();
});

it('ignores a late setting reply after switching sessions and follows saved state', async () => {
  let finish!: (value: { ok: boolean }) => void;
  currentApiMock().override('sessions.setConfigurePermissions', () => new Promise(resolve => { finish = resolve; }));
  const view = render(<Session id="old" />);
  fireEvent.click(screen.getByRole('switch', { name: '配置权限' }));
  view.rerender(<Session id="new" />);
  await act(async () => finish({ ok: true }));
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByText('native settings')).toBeNull();
  view.rerender(<Session id="new" configured />);
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
});

it('localizes the switch and default permission tooltip', () => {
  const view = render(<PermissionConfigurationSwitch enabled={false} onChange={() => {}} />);
  try {
    act(() => { applyLocaleSetting('en'); });
    expect(screen.getByRole('switch', { name: 'Configure permissions' }).getAttribute('title')).toBe('Use full access when off');
  } finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
});
