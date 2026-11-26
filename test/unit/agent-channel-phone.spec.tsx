import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentPhone } from '../../src/renderer/src/agentApps/AgentPhone';
import { ChannelAppView } from '../../src/renderer/src/agentApps/ChannelAppView';
import { PhoneLegacyChannelSources } from '../../src/renderer/src/agentApps/PhoneLegacyChannelSources';
import { useAgentPhone } from '../../src/renderer/src/agentApps/useAgentPhone';
import { CHANNEL_APP_ID, type AppSnapshot } from '../../src/shared/agentApps';
import { builtInAgentApps } from '../../src/shared/agentAppsBuiltins';
import type { LogicalChannel, LogicalChannelMessage, LogicalChannelSourceGrant } from '../../src/shared/messagingChannels';
import { currentApiMock } from './helpers/api-mock';

beforeEach(() => dismissTip());

const ws = 'one';
const grant = (sourceId: string, provider: string, label: string): LogicalChannelSourceGrant => ({ sourceId,
  permission: 'reply', notify: null, remote: null, remoteTarget: null, source: { id: sourceId, provider, botId: sourceId, label,
    conversationId: `conversation-${sourceId}`, conversationType: 'direct', connected: true, canSend: true, canRemote: false, lastSeenAt: 30 } });
const channel: LogicalChannel = { id: 'user-channel', name: '客户请求', notify: 'digest',
  sources: [grant('telegram-1', 'telegram', '通知群'), grant('legacy:mailbox', 'email', '工作邮箱')] };
const incoming: LogicalChannelMessage = { id: 'message-1', channelId: channel.id, sourceId: 'telegram-1', direction: 'inbound', text: '需要回覆', senderLabel: '小林', createdAt: 30,
  status: 'received', read: false, processed: false };
const draft: LogicalChannelMessage = { ...incoming, id: 'legacy:mail:draft-1', sourceId: 'legacy:mailbox', direction: 'outbound', status: 'draft',
  senderLabel: '', text: '先保留草稿', subject: '草稿主题', recipient: 'draft@example.test', revision: 3 };
const snapshot: AppSnapshot = { workspaceId: ws, apps: builtInAgentApps().map(definition => ({ definition, enabled: true, installedAt: 1 })), operations: [], connections: [], errors: [] };

function Harness() {
  const phone = useAgentPhone(ws);
  return <><button onClick={() => phone.controller.open()}>打开手机</button><AgentPhone workspaceId={ws} workspaceName="测试区" phone={phone}/></>;
}

function stubMailbox() {
  let selected = incoming;
  currentApiMock().override('agentApps.snapshot', async () => snapshot);
  currentApiMock().override('agentApps.query', async (_ws, query) => {
    if (!query.channelId) return { channels: [channel] };
    if (query.id) return { channelMessage: query.id === draft.id ? draft : selected };
    return { channelMessages: { messages: [query.channelQuery?.drafts ? draft : incoming], nextCursor: null } };
  });
  currentApiMock().override('agentApps.call', async (_ws, call) => {
    if (call.commandId === 'state') { selected = { ...selected, ...call.params }; return { channelMessage: selected }; }
    if (call.commandId === 'save-draft') return { channelMessage: draft };
    return { channelMessage: { ...incoming, status: 'sent', direction: 'outbound', text: String(call.params?.text) } };
  });
}

async function openChannel() {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', { name: '打开手机' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Channel' }));
  fireEvent.click(await screen.findByRole('button', { name: /客户请求/ }));
}

it('opens the unified inbox, searches and changes read/processed independently, and replies to the original Telegram message', async () => {
  stubMailbox(); await openChannel();
  expect(screen.queryByRole('button', { name: '短信' })).toBeNull();
  expect(screen.queryByRole('button', { name: '邮箱' })).toBeNull();
  const sources = await screen.findByRole('navigation', { name: '对话来源' });
  expect(within(sources).getByRole('button', { name: /工作邮箱/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '未读' }));
  fireEvent.click(screen.getByRole('button', { name: '未处理' }));
  fireEvent.click(screen.getByRole('button', { name: '手机搜索' }));
  fireEvent.change(screen.getByRole('textbox', { name: '搜索应用内容' }), { target: { value: '需要' } });
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.query')).toHaveBeenCalledWith(ws, expect.objectContaining({ appId: CHANNEL_APP_ID,
    channelId: channel.id, search: '需要', channelQuery: expect.objectContaining({ unread: true, processed: false }) })));
  fireEvent.click(await screen.findByRole('button', { name: /需要回覆/ }));
  fireEvent.click(await screen.findByRole('button', { name: '标为已处理' }));
  expect(await screen.findByRole('button', { name: '标为未处理' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '标为已读' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '回复' }));
  expect(await screen.findByText(/来源 · Telegram · 通知群/)).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: '发送来源' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: '消息内容' }), { target: { value: '已处理' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送回复' })); });
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith(ws, expect.objectContaining({ appId: CHANNEL_APP_ID, commandId: 'reply', requestId: expect.any(String),
    params: expect.objectContaining({ channelId: channel.id, messageId: incoming.id, text: '已处理' }) })));
});

it('searches bodies in all Channels from the home screen and opens the correct source', async () => {
  stubMailbox();
  const match = { ...incoming, text: '季度项目更新', senderLabel: '其他人' };
  currentApiMock().override('agentApps.query', async (_ws, query) => {
    if (query.id === match.id) return { channelMessage: match };
    if (query.search) return { channelMessages: { messages: [match], nextCursor: null } };
    return { channels: [channel] };
  });
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', { name: '打开手机' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Channel' }));
  await screen.findByRole('button', { name: /客户请求/ });
  fireEvent.click(screen.getByRole('button', { name: '手机搜索' }));
  const input = screen.getByRole('textbox', { name: '搜索应用内容' });
  fireEvent.change(input, { target: { value: '季' } });
  fireEvent.change(input, { target: { value: '季度' } });
  fireEvent.change(input, { target: { value: '季度项目' } });
  const result = await screen.findByRole('button', { name: /客户请求 · Telegram · 通知群.*季度项目更新/ });
  const searches = currentApiMock().mockOf('agentApps.query').mock.calls.filter(([_ws, query]) => query.search);
  expect(searches).toHaveLength(1);
  expect(searches[0]).toEqual([ws, expect.objectContaining({ appId: CHANNEL_APP_ID, search: '季度项目' })]);
  fireEvent.click(result);
  await screen.findByRole('heading', { name: '其他人' });
  expect(currentApiMock().mockOf('agentApps.query')).toHaveBeenCalledWith(ws, expect.objectContaining({ channelId: channel.id, id: match.id }));
});

it('requires a single explicit send source and retains a legacy mailbox recipient and subject', async () => {
  stubMailbox(); await openChannel();
  fireEvent.click(await screen.findByRole('button', { name: '撰写消息' }));
  fireEvent.change(await screen.findByRole('textbox', { name: '消息内容' }), { target: { value: '主动发送' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('请选择有发送权限的来源'));
  expect(currentApiMock().mockOf('agentApps.call')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '发送来源' }));
  fireEvent.click(await screen.findByRole('option', { name: /工作邮箱/ }));
  fireEvent.change(screen.getByRole('textbox', { name: '收件人' }), { target: { value: 'recipient@example.test' } });
  fireEvent.change(screen.getByRole('textbox', { name: '邮件主题' }), { target: { value: '业务主题' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送' })); });
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith(ws, expect.objectContaining({ commandId: 'send',
    params: { channelId: channel.id, sourceId: 'legacy:mailbox', text: '主动发送', subject: '业务主题', recipient: 'recipient@example.test' } })));
});

it('opens and edits the same migrated mail draft at its stored revision', async () => {
  stubMailbox(); await openChannel();
  fireEvent.click(await screen.findByRole('button', { name: '草稿' }));
  fireEvent.click(await screen.findByRole('button', { name: /草稿主题/ }));
  fireEvent.click(await screen.findByRole('button', { name: '编辑草稿' }));
  const content = await screen.findByRole('textbox', { name: '消息内容' });
  expect((content as HTMLTextAreaElement).value).toBe(draft.text);
  fireEvent.change(content, { target: { value: '草稿更新' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存草稿' })); });
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith(ws, expect.objectContaining({ commandId: 'save-draft',
    params: expect.objectContaining({ draftId: draft.id, expectedRevision: draft.revision, recipient: draft.recipient, subject: draft.subject, text: '草稿更新' }) })));
});

it('keeps the existing editor scoped to the same connection and ignores refresh after workspace retirement', async () => {
  const refresh = vi.fn();
  let finish!: () => void;
  const existing: AppSnapshot = { ...snapshot, connections: [{ kind: 'feishu', id: 'saved', name: '已有对话', chatId: 'oc_saved',
    identity: 'bot', profile: 'muster-phone-fixture', revision: 2, enabled: true, grants: { messages: ['messages.read'] } }] };
  currentApiMock().override('agentApps.saveConnection', (_ws, connection) => new Promise(resolve => { finish = () => resolve({ ...connection, revision: 3 }); }));
  const { rerender } = render(<PhoneLegacyChannelSources workspaceId={ws} snapshot={existing} refresh={refresh}/>);
  fireEvent.click(screen.getByRole('button', { name: '通知与权限' }));
  const input = await screen.findByRole('textbox', { name: '对话名称' });
  fireEvent.change(input, { target: { value: '新对话名' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(currentApiMock().mockOf('agentApps.saveConnection')).toHaveBeenCalledWith(ws, expect.objectContaining({ id: 'saved', chatId: 'oc_saved', expectedRevision: 2, name: '新对话名' }));
  rerender(<PhoneLegacyChannelSources workspaceId={ws} snapshot={existing} refresh={refresh} active={false}/>);
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.queryByText('设置已保存')).toBeNull());
  expect(refresh).not.toHaveBeenCalled();
});

it('binds global Channels to the current workspace and unbinds without deleting the global Channel', async () => {
  const bound = new Map([['one', false], ['two', true]]);
  const api = currentApiMock();
  api.override('agentApps.query', async (workspace, query) => {
    expect(query).toEqual({ appId: CHANNEL_APP_ID, viewId: 'bindings' });
    return { channelCatalog: [{ id: channel.id, name: channel.name, sourceCount: 2, bound: bound.get(workspace) }] };
  });
  api.override('agentApps.call', async (workspace, call) => {
    expect(call.params).toEqual({ channelId: channel.id });
    expect(['bind', 'unbind']).toContain(call.commandId);
    bound.set(workspace, call.commandId === 'bind');
    return { status: call.commandId === 'bind' ? 'bound' : 'unbound' };
  });
  const props = { workspaceId: 'one', workspaceName: '项目一', route: { appId: CHANNEL_APP_ID, viewId: 'bindings' }, active: true, revision: 0, search: '', navigate: vi.fn() };
  const { rerender } = render(<ChannelAppView {...props}/>);
  fireEvent.click(await screen.findByRole('button', { name: '绑定 客户请求' }));
  expect(await screen.findByRole('button', { name: '解除绑定 客户请求' })).toBeTruthy();
  expect(bound.get('two')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '解除绑定 客户请求' }));
  expect(await screen.findByText('已解除此工作区与 客户请求 的绑定。全局 Channel 和其他工作区不受影响。')).toBeTruthy();
  expect(await screen.findByRole('button', { name: '绑定 客户请求' })).toBeTruthy();
  expect(bound.get('one')).toBe(false); expect(bound.get('two')).toBe(true);
  rerender(<ChannelAppView {...props} workspaceId="two" workspaceName="项目二"/>);
  expect(await screen.findByRole('button', { name: '解除绑定 客户请求' })).toBeTruthy();
  expect(api.mockOf('messaging.call')).not.toHaveBeenCalled();
  expect(api.mockOf('agentApps.call').mock.calls).toHaveLength(2);
});

it('discards a previous workspace catalog and displays binding errors without optimistic access', async () => {
  const api = currentApiMock();
  let finish!: () => void;
  api.override('agentApps.query', async workspace => workspace === 'one'
    ? new Promise(resolve => { finish = () => resolve({ channelCatalog: [{ id: 'old', name: '旧区晚到目录', sourceCount: 2, bound: true }] }); })
    : { channelCatalog: [{ id: 'global', name: '全局服务', sourceCount: 1, bound: false }] });
  api.override('agentApps.call', async () => { throw Error('channel-not-found'); });
  const props = { workspaceId: 'one', route: { appId: CHANNEL_APP_ID, viewId: 'bindings' }, active: true, revision: 0, search: '', navigate: vi.fn() };
  const { rerender } = render(<ChannelAppView {...props}/>);
  rerender(<ChannelAppView {...props} workspaceId="two"/>);
  await screen.findByRole('button', { name: '绑定 全局服务' });
  await act(async () => finish());
  expect(screen.queryByText('旧区晚到目录')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '绑定 全局服务' }));
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('Channel 已被移除'));
  expect(screen.queryByRole('button', { name: '解除绑定 全局服务' })).toBeNull();
});

it('opens workspace binding from the phone and the hardware Back key returns to its inbox', async () => {
  stubMailbox();
  const api = currentApiMock();
  api.override('agentApps.query', async (_workspace, query) => query.viewId === 'bindings'
    ? { channelCatalog: [{ id: channel.id, name: channel.name, sourceCount: 2, bound: true }] }
    : { channels: [channel] });
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', { name: '打开手机' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Channel' }));
  fireEvent.click(await screen.findByRole('button', { name: '绑定 Channel' }));
  await screen.findByRole('button', { name: '解除绑定 客户请求' });
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  expect(await screen.findByRole('button', { name: /客户请求.*通知群/ })).toBeTruthy();
});
