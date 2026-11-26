import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChannelsSettingsPanel } from '../../src/renderer/src/components/settings/ChannelsSettingsPanel';
import { currentApiMock } from './helpers/api-mock';

const channels = [
  { key: 'telegram', label: 'Telegram', supported: true },
  { key: 'email', label: '邮箱', supported: true },
  { key: 'imessage', label: 'iMessage', supported: false, reason: 'macos-only' }
];
const snapshot = { bots: [], revision: 1 };

it('opens the messaging settings on demand and submits credentials through the channel IPC', async () => {
  const api = currentApiMock();
  api.override('messaging.status', async () => ({ state: 'ready', channels }));
  api.override('webAccess.status', async () => ({ running: false, urls: [], hook: null }));
  let connectedSnapshot: { revision: number; bots: { botId: string; connected: boolean; bot: { name: string } }[] } = snapshot;
  api.override('messaging.call', async (_channel, method) => {
    if (_channel === 'channels') return { ok: true, value: [] };
    if (method === 'bot.bind-credentials') {
      connectedSnapshot = {
        bots: [{ botId: 'fixture-bot', connected: true, bot: { name: '验收机器人' } }],
        revision: 2
      };
    }
    return { ok: true, value: connectedSnapshot };
  });

  render(<ChannelsSettingsPanel workspaceId="ws" />);
  expect(api.mockOf('messaging.status')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '连接账号' }));
  fireEvent.click(await screen.findByRole('button', { name: '填写 Bot Token' }));
  const token = screen.getByLabelText('Bot Token');
  expect(token.getAttribute('type')).toBe('password');
  fireEvent.change(token, { target: { value: 'offline-fixture-token' } });
  fireEvent.click(screen.getByRole('button', { name: '绑定并连接' }));

  await waitFor(() => expect(api.mockOf('messaging.call')).toHaveBeenCalledWith(
    'telegram', 'bot.bind-credentials', { token: 'offline-fixture-token' }, expect.any(String)
  ));
  const botName = await screen.findByText('验收机器人', { exact: true, selector: 'h3' });
  expect(botName.closest('article')?.getAttribute('data-bot-id')).toBe('fixture-bot');
  expect(screen.queryByLabelText('Bot Token')).toBeNull();
  expect(api.mockOf('messaging.call').mock.calls.some(([, method]) => method === 'remote.begin')).toBe(false);
});

it('selects a provider from the Channels account page and explains iMessage restrictions', async () => {
  const api = currentApiMock();
  api.override('messaging.status', async () => ({ state: 'ready', channels }));
  api.override('messaging.call', async (channel) => ({ ok: true, value: channel === 'channels' ? [] : snapshot }));
  render(<ChannelsSettingsPanel workspaceId="ws" />);
  fireEvent.click(screen.getByRole('button', { name: '连接账号' }));
  const select = await screen.findByRole('button', { name: '选择消息服务' });
  fireEvent.keyDown(select, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'iMessage' }));
  expect(await screen.findByText('iMessage 仅在 macOS 上通过「信息」应用连接。')).toBeTruthy();
  expect(api.mockOf('messaging.call').mock.calls.every(([channel]) => channel !== 'imessage')).toBe(true);
});

it('manages a previously connected WeChat account from Channels without opening old account pairing', async () => {
  const api = currentApiMock();
  const botId = 'fixture-wechat';
  const wechat = {
    revision: 2,
    bots: [{ botId, connected: true, bot: { name: '微信验收账号' }, workspace: '/fixture-workspace',
      agentPreset: 'fixture-agent-preset', model: { provider: 'test', model: 'fixture-agent-model' } }]
  };
  api.override('messaging.status', async () => ({ state: 'ready', channels: [{ key: 'weixin', label: '微信', supported: true }] }));
  api.override('messaging.call', async channel => ({ ok: true, value: channel === 'channels' ? [] : wechat }));
  const view = render(<ChannelsSettingsPanel workspaceId="ws" />);
  fireEvent.click(screen.getByRole('button', { name: '连接账号' }));

  expect(await screen.findByText('微信验收账号', { exact: true, selector: 'h3' })).toBeTruthy();
  const toggle = screen.getByRole('button', { name: '展开账号管理' });
  const details = document.getElementById(toggle.getAttribute('aria-controls')!);
  expect(details?.hasAttribute('inert')).toBe(true);
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(await screen.findByRole('button', { name: '移除接入' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '生成绑定码' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '收起账号管理' }));
  expect(details?.hasAttribute('inert')).toBe(true);
  expect(view.container.textContent).not.toMatch(/工作目录|上下文增强|思考强度|Agent 预设|fixture-agent-model/);
  expect(api.mockOf('messaging.call').mock.calls.some(([, method]) => method.startsWith('remote.'))).toBe(false);
});

it('cancels the provider IPC request when returning to Channels', async () => {
  const api = currentApiMock();
  api.override('messaging.status', async () => ({ state: 'ready', channels }));
  api.override('messaging.call', channel => channel === 'channels' ? Promise.resolve({ ok: true, value: [] }) : new Promise(() => {}));
  api.override('messaging.cancel', async () => ({ ok: true }));
  render(<ChannelsSettingsPanel workspaceId="ws" />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接账号' })); });
  await waitFor(() => expect(api.mockOf('messaging.call').mock.calls.find(([channel]) => channel === 'telegram')).toBeTruthy());
  const request = api.mockOf('messaging.call').mock.calls.find(([channel]) => channel === 'telegram')!;
  expect(request[3]).toMatch(/^[\da-f-]{36}$/i);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '返回 Channels' })); });
  expect(api.mockOf('messaging.cancel')).toHaveBeenCalledWith(request[3]);
});
