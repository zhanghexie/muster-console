import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LogicalChannel, LogicalChannelSource } from '../../src/shared/messagingChannels';
import { ChannelsSettingsPanel } from '../../src/renderer/src/components/settings/ChannelsSettingsPanel';
import { ChannelRemoteInput } from '../../src/renderer/src/components/settings/ChannelRemoteInput';
import { currentApiMock } from './helpers/api-mock';
import * as webGateway from '../../src/renderer/src/webGatewayEnvironment';

const sources: LogicalChannelSource[] = [
  { id: 'wx', provider: 'weixin', botId: 'bot-wx', conversationId: 'chat-wx', conversationType: 'direct', label: '自己的对话', connected: true, canSend: true, canRemote: true, lastSeenAt: 1 },
  { id: 'fs', provider: 'feishu', botId: 'bot-fs', conversationId: 'chat-fs', conversationType: 'group', label: '项目讨论群', connected: true, canSend: true, canRemote: true, lastSeenAt: 1 }
];

function fixtures() {
  let channels: LogicalChannel[] = [{ id: 'project', name: '项目 A', notify: 'digest', sources: [
    { sourceId: 'wx', source: sources[0], permission: 'read', notify: null, remoteTarget: null, remote: null }
  ] }];
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = currentApiMock();
  api.override('messaging.call', async (namespace: string, method: string, input: unknown) => {
    const payload = input as Record<string, unknown>; calls.push({ method, payload });
    expect(namespace).toBe('channels'); expect(payload).not.toHaveProperty('workspaceId');
    const selected = channels.find(channel => channel.id === payload.channelId);
    let value: unknown;
    switch (method) {
      case 'list': value = channels; break;
      case 'sources.list': value = sources; break;
      case 'create': {
        const created: LogicalChannel = { id: 'created', name: String(payload.name), notify: 'digest', sources: [] };
        channels.push(created); value = created; break;
      }
      case 'update': Object.assign(selected!, { ...(payload.name ? { name: payload.name } : {}), ...(payload.notify ? { notify: payload.notify } : {}) }); value = selected; break;
      case 'sources.add': selected!.sources.push({ sourceId: String(payload.sourceId), source: sources.find(source => source.id === payload.sourceId)!, permission: payload.permission as 'read' | 'reply', notify: null, remoteTarget: null, remote: null }); value = selected; break;
      case 'sources.update': {
        const grant = selected!.sources.find(grant => grant.sourceId === payload.sourceId)!;
        if ('permission' in payload) grant.permission = payload.permission as 'read' | 'reply';
        if ('remoteTarget' in payload) {
          grant.remoteTarget = payload.remoteTarget as typeof grant.remoteTarget;
          if (!grant.remoteTarget) grant.remote = null;
        }
        value = selected; break;
      }
      case 'sources.remove': selected!.sources = selected!.sources.filter(grant => grant.sourceId !== payload.sourceId); value = selected; break;
      case 'remove': channels = channels.filter(channel => channel.id !== payload.channelId); value = null; break;
      case 'remote.begin': {
        const grant = selected!.sources.find(grant => grant.sourceId === payload.sourceId)!;
        grant.remote = { ready: false, boundUsers: [], binding: { code: '123456', expiresAt: Date.now() + 60_000 } }; value = grant.remote; break;
      }
      case 'remote.status': value = selected!.sources.find(grant => grant.sourceId === payload.sourceId)!.remote; break;
      case 'diagnostics': value = { received: 1, remoteHandled: 0, sent: 0, failed: 1, unknown: 0, stages: { receive: 1, authorized: 0, routed: 0, reply: 0, failure: 1 }, lastStage: { stage: 'failure', at: 1, reason: 'sender-not-authorized' } }; break;
      default: throw Error(`Unmocked ${method}`);
    }
    return { ok: true as const, value: structuredClone(value) };
  });
  api.override('messaging.cancel', async () => ({ ok: true }));
  return { calls, api, channels };
}

async function select(label: string, option: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

it('creates a named Channel and adds one existing source with explicit read permission', async () => {
  const { calls } = fixtures();
  render(<ChannelsSettingsPanel workspaceId="ws" />);
  await screen.findByRole('heading', { name: '项目 A' });
  expect(screen.queryByRole('tab', { name: '微信' })).toBeNull();
  fireEvent.click(screen.getByText('新建 Channel'));
  fireEvent.change(screen.getByLabelText('Channel 名称'), { target: { value: '客户反馈' } });
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  await screen.findByRole('heading', { name: '客户反馈' });
  fireEvent.click(screen.getByText('添加消息源'));
  await screen.findByRole('button', { name: '选择消息源' });
  await select('选择消息源', '飞书 · 项目讨论群');
  fireEvent.click(screen.getByRole('button', { name: '加入 Channel' }));
  await waitFor(() => expect(calls).toContainEqual({ method: 'sources.add', payload: { channelId: 'created', sourceId: 'fs', permission: 'read' } }));
  expect(await screen.findByText('消息源已加入。远程输入需单独授权。')).toBeTruthy();
  expect(calls.some(call => call.method === 'remote.begin')).toBe(false);
  expect(calls.some(call => call.method.startsWith('bindings.'))).toBe(false);
});

it('changes per-source permissions and removes only the selected source', async () => {
  const { calls } = fixtures();
  render(<ChannelsSettingsPanel workspaceId="ws" />);
  await screen.findByRole('heading', { name: '项目 A' });
  await select('自己的对话 的读写权限', '读取和回复');
  await waitFor(() => expect(calls).toContainEqual({ method: 'sources.update', payload: { channelId: 'project', sourceId: 'wx', permission: 'reply' } }));
  fireEvent.click(screen.getByRole('button', { name: '移除消息源 自己的对话' }));
  await waitFor(() => expect(screen.queryByText('自己的对话')).toBeNull());
  expect(calls.some(call => call.method === 'remove')).toBe(false);
});

it('authorizes global remote input without a fixed workspace or target and exposes actual diagnostic failures', async () => {
  const { calls } = fixtures();
  render(<ChannelRemoteInput />);
  await screen.findByText('全局工作台');
  expect(screen.queryByRole('button', { name: '输入发送到' })).toBeNull();
  expect(screen.queryByText('模型与思考强度')).toBeNull();
  expect(screen.getByText('/ws')).toBeTruthy();
  expect(screen.getByText('/bind')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '启用并验证操作人' }));
  await screen.findByText('123456');
  const update = calls.findIndex(call => call.method === 'sources.update');
  const begin = calls.findIndex(call => call.method === 'remote.begin');
  expect(update).toBeLessThan(begin);
  expect(calls[update].payload).toEqual({ channelId: 'project', sourceId: 'wx', remoteTarget: { kind: 'workbench' } });
  expect(calls[begin].payload).toEqual({ channelId: 'project', sourceId: 'wx' });
  expect(calls.some(call => call.method === 'targets.list' || call.method.startsWith('bindings.'))).toBe(false);
  fireEvent.click(screen.getByText('收发诊断'));
  expect(await screen.findByText('处理说明：此操作人尚未授权，请在当前对话完成验证码验证。')).toBeTruthy();
  expect(within(screen.getByText('回复已送达').parentElement!).getByText('0')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '停用远程输入' }));
  await screen.findByText('远程输入已停用，Channel 收件继续可用。');
  expect(calls.some(call => call.method === 'sources.remove')).toBe(false);
});

it('keeps the global catalog and unfinished name when the desktop switches workspaces', async () => {
  const { calls } = fixtures();
  const { rerender } = render(<ChannelsSettingsPanel workspaceId="ws" />);
  await screen.findByRole('heading', { name: '项目 A' });
  fireEvent.click(screen.getByText('新建 Channel'));
  fireEvent.change(screen.getByLabelText('Channel 名称'), { target: { value: '跨区服务' } });
  rerender(<ChannelsSettingsPanel workspaceId="other" />);
  expect((screen.getByLabelText('Channel 名称') as HTMLInputElement).value).toBe('跨区服务');
  expect(screen.getByRole('heading', { name: '项目 A' })).toBeTruthy();
  expect(calls.filter(call => call.method === 'list')).toHaveLength(1);
});

it('manages existing account connections from every workspace in the global settings', async () => {
  const { api } = fixtures();
  api.override('messaging.status', async () => ({ state: 'ready', channels: [] }));
  api.override('agentApps.snapshot', async workspaceId => ({ workspaceId, connections: [], apps: [], operations: [], errors: [] }));
  render(<ChannelsSettingsPanel workspaceId="ws" workspaces={[{ id: 'ws', name: '项目一' }, { id: 'other', name: '项目二' }]} />);
  fireEvent.click(screen.getByRole('button', { name: '连接账号' }));
  await waitFor(() => expect(api.mockOf('agentApps.snapshot')).toHaveBeenCalledWith('ws'));
  await select('已有连接所在工作区', '项目二');
  await waitFor(() => expect(api.mockOf('agentApps.snapshot')).toHaveBeenCalledWith('other'));
  expect(api.mockOf('messaging.call').mock.calls.every(([namespace, , payload]) => namespace !== 'channels' || !('workspaceId' in payload))).toBe(true);
});

it('aborts pending management calls when the settings surface becomes inactive', async () => {
  const api = currentApiMock();
  const releases: (() => void)[] = [];
  api.override('messaging.call', () => new Promise(resolve => { releases.push(() => resolve({ ok: true, value: [] })); }));
  api.override('messaging.cancel', async () => ({ ok: true }));
  const { rerender } = render(<ChannelsSettingsPanel workspaceId="ws" />);
  await waitFor(() => expect(releases.length).toBe(2));
  rerender(<ChannelsSettingsPanel workspaceId="ws" active={false} />);
  await waitFor(() => expect(api.mockOf('messaging.cancel')).toHaveBeenCalledTimes(2));
  releases.forEach(release => release());
  expect(screen.queryByRole('alert')).toBeNull();
});

it('explains how to restore a legacy source whose original workspace was removed', async () => {
  const { channels } = fixtures();
  channels[0].sources[0].source = { ...sources[0], legacyOwnerWorkspaceId: 'old-workspace', connected: false, canSend: false, canRemote: false };
  const { rerender } = render(<ChannelsSettingsPanel workspaceId="ws" workspaces={[{ id: 'ws', name: '当前项目' }]} />);
  const explanation = '此连接的原工作区未打开。请重新打开原工作区恢复连接，或连接新账号并替换此消息源。';
  expect(await screen.findByText(explanation)).toBeTruthy();
  rerender(<ChannelsSettingsPanel workspaceId="ws" workspaces={[{ id: 'ws', name: '当前项目' }, { id: 'old-workspace', name: '旧项目' }]} />);
  expect(screen.queryByText(explanation)).toBeNull();
  expect(screen.getByText('来自 旧项目 的已有连接')).toBeTruthy();
});

it('directs gateway users to desktop setup without attempting privileged management calls', () => {
  const gateway = vi.spyOn(webGateway, 'isWebGateway').mockReturnValue(true);
  try {
    const { calls } = fixtures();
    render(<ChannelsSettingsPanel workspaceId="ws" />);
    expect(screen.getByText('请在桌面端设置 Channels 和连接账号；配置完成后可在手机 Channel App 中使用。')).toBeTruthy();
    expect(calls).toEqual([]);
    expect(screen.queryByRole('button', { name: '连接账号' })).toBeNull();
  } finally { gateway.mockRestore(); }
});
