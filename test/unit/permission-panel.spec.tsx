import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { dismissTip } from '../../src/renderer/src/tips';
import { currentApiMock } from './helpers/api-mock';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterEach(() => { act(() => dismissTip()); });

async function mount(runtime: 'pi' | 'acp') {
  const id = `permission-panel-${runtime}`;
  const api = currentApiMock();
  api.override('sessions.list', async () => ({ sessions: [{ id, runtime, type: 'terminal', launchKind: 'agent', lifecycle: 'idle' }], activeId: id }));
  api.override('sessions.setConfigurePermissions', async () => ({ ok: true }));
  api.override('agentSession.setMode', async () => ({ ok: true }));
  api.override('agentSession.getNativeConfig', async () => ({ identity: { runtimeId: runtime, sourceKey: 'fixture' }, source: 'session', revision: 1, status: 'ready', options: [{
    id: 'native-mode', name: 'Permission Mode', type: 'select', currentValue: 'ask', changePolicy: 'live', choices: [{ value: 'ask', name: 'Always Ask' }]
  }] }));
  function Harness() {
    const surface = useAgentSessionSurface({ sessionId: id, runtimeId: runtime, visible: true });
    return <ChatSurfaceView surface={surface} />;
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  const view = render(<KeybindingProvider><StoreProvider><Harness /><AppTipHost /></StoreProvider></KeybindingProvider>);
  await screen.findByRole('button', { name: runtime === 'pi' ? '权限模式' : '引擎设置' });
  return { ...view, api, id };
}

it('Core keeps its entry visible and puts the switch inside the permission panel', async () => {
  const user = userEvent.setup();
  const { api, id } = await mount('pi');
  const entry = screen.getByRole('button', { name: '权限模式' });
  expect(entry.textContent).toContain('完全访问');
  expect(screen.queryByRole('switch')).toBeNull();
  await user.click(entry);
  const panel = screen.getByRole('dialog', { name: '权限模式' });
  const toggle = within(panel).getByRole('switch', { name: '配置权限' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(within(panel).queryByRole('menuitemradio')).toBeNull();
  toggle.focus();
  await user.keyboard(' ');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(api.mockOf('sessions.setConfigurePermissions')).toHaveBeenCalledWith(id, true);
  await user.click(within(panel).getByRole('menuitemradio', { name: '标准' }));
  await waitFor(() => expect(api.mockOf('agentSession.setMode')).toHaveBeenCalledWith(id, 'standard'));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(entry);
  await user.click(screen.getByRole('switch', { name: '配置权限' }));
  expect(screen.queryByRole('menuitemradio')).toBeNull();
  expect(entry.textContent).toContain('完全访问');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('switch')).toBeNull();
  expect(entry.isConnected).toBe(true);
});

it('external settings keep the switch in their panel and only read native options after enabling it', async () => {
  const user = userEvent.setup();
  const { api } = await mount('acp');
  expect(screen.queryByRole('switch')).toBeNull();
  const entry = screen.getByRole('button', { name: '引擎设置' });
  await user.click(entry);
  const panel = screen.getByRole('dialog', { name: '引擎设置' });
  const toggle = within(panel).getByRole('switch', { name: '配置权限' });
  expect(api.mockOf('agentSession.getNativeConfig')).not.toHaveBeenCalled();
  await user.click(toggle);
  expect(await within(panel).findByRole('button', { name: '权限模式' })).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('switch')).toBeNull();
  await user.click(entry);
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  await user.click(screen.getByRole('switch'));
  expect(screen.queryByRole('button', { name: '权限模式' })).toBeNull();
  expect(entry.isConnected).toBe(true);
});

it('a rejected enable leaves the switch off and reports the error outside the composer', async () => {
  const { api, container } = await mount('acp');
  api.override('sessions.setConfigurePermissions', async () => ({ ok: false, error: '当前 Harness 正在运行，请等待回合结束后开启权限配置' }));
  fireEvent.click(screen.getByRole('button', { name: '引擎设置' }));
  fireEvent.click(screen.getByRole('switch'));
  const tip = await screen.findByRole('status');
  expect(tip.textContent).toContain('当前 Harness 正在运行');
  expect(container.contains(tip)).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  expect(api.mockOf('agentSession.getNativeConfig')).not.toHaveBeenCalled();
});
