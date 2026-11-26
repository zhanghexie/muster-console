import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { PhoneSettings } from '../../src/renderer/src/agentApps/PhoneSettings';
import { PhoneLegacyChannelSources } from '../../src/renderer/src/agentApps/PhoneLegacyChannelSources';
import { AppDataView } from '../../src/renderer/src/agentApps/AppDataView';
import type { PhoneRoute } from '../../src/renderer/src/agentApps/presentation';
import { builtInAgentApps } from '../../src/shared/agentAppsBuiltins';
import { isLegacyChannelApp, type AppSnapshot, type AppConnection } from '../../src/shared/agentApps';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting } from '../../src/shared/i18n';

beforeEach(() => dismissTip());

const visibleApps = builtInAgentApps().filter(definition => !isLegacyChannelApp(definition.id))
  .map(definition => ({ definition, enabled: true, installedAt: 1 }));
function snapshot(workspaceId: string, connections: AppConnection[] = []): AppSnapshot {
  return { workspaceId, apps: visibleApps, operations: [], connections, errors: [] };
}

const privateChat: AppConnection = { kind: 'feishu', id: 'private', name: '小王', chatId: 'oc_private', identity: 'bot', profile: 'muster-phone-fixture', enabled: true, revision: 2, grants: { messages: ['messages.read', 'messages.send'] }, notificationHint: '先判断需要回复什么' };
const groupChat: AppConnection = { ...privateChat, id: 'group', name: '讨论群', chatId: 'oc_group' };
const mailbox: AppConnection = {
  kind: 'imap-smtp', id: 'work-mailbox', name: '工作邮箱', enabled: true, revision: 4,
  grants: { mail: ['mail.read'] }, address: 'work@example.test', user: 'work',
  imapHost: 'imap.example.test', imapPort: 993, imapTls: 'tls',
  smtpHost: 'smtp.example.test', smtpPort: 465, smtpTls: 'tls', mailbox: 'INBOX'
};

function openLegacy(connections: AppConnection[]) {
  return render(<PhoneLegacyChannelSources workspaceId="one" snapshot={snapshot('one', connections)} refresh={() => {}}/>);
}

it('phone settings keep the Channel app and leave account connection to desktop settings', async () => {
  const setAuto = vi.fn();
  currentApiMock().override('agentApps.listLibrary', async () => []);
  render(<PhoneSettings workspaceId="one" snapshot={snapshot('one', [privateChat, mailbox])}
    auto setAuto={setAuto} refresh={() => {}}/>);
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.listLibrary')).toHaveBeenCalledWith('one'));
  expect(screen.getByRole('checkbox', { name: 'Channel' })).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: /^(邮箱|短信)$/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /添加邮箱|扫码创建|连接飞书|连接私聊/ })).toBeNull();
  expect(screen.queryByText(privateChat.name)).toBeNull();
  expect(screen.queryByText(mailbox.name)).toBeNull();
  expect(screen.queryByLabelText('手机机器人授权码')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: '自动展示 AI 的应用操作' }));
  expect(setAuto).toHaveBeenCalledWith(false);
  for (const method of ['feishuStatus', 'startFeishuSetup', 'beginFeishuBinding', 'listFeishuChats', 'saveConnection']) {
    expect(currentApiMock().mockOf(`agentApps.${method}`)).not.toHaveBeenCalled();
  }
});

it('the desktop legacy section edits existing Feishu notification preferences with the keyboard', async () => {
  openLegacy([privateChat, groupChat]);
  expect(screen.getByRole('heading', { name: '已有连接' })).toBeTruthy();
  expect(screen.getByText(privateChat.name)).toBeTruthy();
  expect(screen.getByText(groupChat.name)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /添加邮箱|扫码创建|连接私聊/ })).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: '通知与权限' })[0]);
  expect(screen.queryByRole('combobox', { name: '选择飞书会话' })).toBeNull();
  const hint = screen.getByRole('textbox', { name: '收到后怎么处理' }) as HTMLTextAreaElement;
  expect(hint.value).toBe(privateChat.notificationHint);
  fireEvent.change(hint, { target: { value: '' } });
  const trigger = screen.getByRole('button', { name: '新内容通知' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const menu = await screen.findByRole('listbox', { name: '新内容通知' });
  fireEvent.keyDown(menu, { key: 'End' });
  fireEvent.keyDown(menu, { key: 'Enter' });
  expect(trigger.textContent).toContain('静默收取');
  expect(currentApiMock().mockOf('agentApps.saveConnection')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.saveConnection')).toHaveBeenCalledWith('one',
    expect.objectContaining({ id: 'private', chatId: 'oc_private', notificationHint: '', notify: 'mute', expectedRevision: 2 })));
});

it('localizes only marked generated chat names and drops provenance after a name edit', async () => {
  const generated = { ...privateChat, name: '飞书私聊 1', namePlaceholder: 'feishu-private' as const };
  const historical = { ...groupChat, name: '飞书私聊 1' };
  openLegacy([generated, historical]);
  try {
    act(() => { applyLocaleSetting('en'); });
    expect(screen.getByText('Feishu chat 1')).toBeTruthy();
    expect(screen.getByText('飞书私聊 1')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Notifications and permissions' })[0]);
    const name = screen.getByRole('textbox', { name: 'Conversation name' });
    fireEvent.change(name, { target: { value: 'Edited' } });
    fireEvent.change(name, { target: { value: '飞书私聊 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.saveConnection')).toHaveBeenCalledWith('one',
      expect.objectContaining({ id: 'private', chatId: 'oc_private', name: '飞书私聊 1', expectedRevision: 2 })));
    expect(currentApiMock().mockOf('agentApps.saveConnection').mock.calls.at(-1)?.[1].namePlaceholder).toBeUndefined();
    expect(generated.namePlaceholder).toBe('feishu-private');
  } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
});

it('translates recognized existing connection errors without modifying their persisted text', () => {
  const failed = { ...privateChat, lastError: '飞书 CLI 超时' };
  const unknown = { ...groupChat, lastError: '外部服务的原始错误' };
  openLegacy([failed, unknown]);
  const [knownDetails, unknownDetails] = screen.getAllByRole('button', { name: '查看详情' });
  fireEvent.click(knownDetails);
  expect(getTipSnapshot()?.text).toBe(failed.lastError);
  try {
    act(() => { applyLocaleSetting('en'); });
    fireEvent.click(knownDetails);
    expect(getTipSnapshot()?.text).toBe('The Feishu CLI timed out.');
    fireEvent.click(unknownDetails);
    expect(getTipSnapshot()?.text).toBe(unknown.lastError);
    expect(failed.lastError).toBe('飞书 CLI 超时');
  } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
});

it('tests and edits the existing mailbox using its own connection ID and revision', async () => {
  currentApiMock().override('agentApps.testConnection', async () => ({ ok: true }));
  openLegacy([mailbox]);
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect((await screen.findByRole('status')).textContent).toBe('连接测试通过');
  expect(currentApiMock().mockOf('agentApps.testConnection')).toHaveBeenCalledWith('one', mailbox.id);
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  const trigger = screen.getByRole('button', { name: 'IMAP 加密' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const menu = await screen.findByRole('listbox', { name: 'IMAP 加密' });
  fireEvent.keyDown(menu, { key: 'End' });
  fireEvent.keyDown(menu, { key: 'Enter' });
  expect(trigger.textContent).toContain('STARTTLS');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.saveConnection')).toHaveBeenCalledWith('one',
    expect.objectContaining({ id: mailbox.id, address: mailbox.address, expectedRevision: 4, imapTls: 'starttls' })));
});

it('a late save response cannot change the next workspace or refresh the old workspace', async () => {
  let rejectOld!: (error: Error) => void;
  const oldSave = new Promise((_, reject) => { rejectOld = reject; });
  currentApiMock().override('agentApps.saveConnection', (workspaceId: string) =>
    workspaceId === 'one' ? oldSave : Promise.resolve(groupChat));
  const refreshOld = vi.fn(), refreshNew = vi.fn();
  const { rerender } = render(<PhoneLegacyChannelSources workspaceId="one" snapshot={snapshot('one', [privateChat])} refresh={refreshOld}/>);
  fireEvent.click(screen.getByRole('button', { name: '停用' }));
  expect(currentApiMock().mockOf('agentApps.saveConnection')).toHaveBeenCalledWith('one',
    expect.objectContaining({ id: privateChat.id, enabled: false, expectedRevision: 2 }));
  rerender(<PhoneLegacyChannelSources workspaceId="two" snapshot={snapshot('two', [groupChat])} refresh={refreshNew}/>);
  fireEvent.click(screen.getByRole('button', { name: '停用' }));
  await screen.findByRole('status');
  expect(currentApiMock().mockOf('agentApps.saveConnection')).toHaveBeenLastCalledWith('two',
    expect.objectContaining({ id: groupChat.id, enabled: false, expectedRevision: 2 }));
  await act(async () => { rejectOld(new Error('旧工作区的保存失败')); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('已停用');
  expect(refreshOld).not.toHaveBeenCalled();
  expect(refreshNew).toHaveBeenCalledOnce();
});

it('必填选择项必须先选择才能保存，并可通过键盘选择', async () => {
  currentApiMock().override('agentApps.query', async () => ({ records: [], total: 0 }));
  currentApiMock().override('agentApps.call', async () => ({ status: 'ok' }));
  const app = structuredClone(builtInAgentApps().find(a => a.id === 'reminders')!);
  app.collections[0].fields = [{ id: 'missed', label: '错过时', type: 'select', required: true, options: ['catch-up', 'skip'] }];
  const route: PhoneRoute = { appId: app.id, viewId: app.views[0].id, editCommand: 'set' };
  render(<AppDataView workspaceId="one" app={app} view={app.views[0]} route={route} navigate={() => {}} connections={[]} search="" revision={1} scrollPositions={new Map()}/>);
  fireEvent.submit(screen.getByRole('button', { name: '保存' }).closest('form')!);
  expect(getTipSnapshot()).toMatchObject({ text: '请选择错过时', tone: 'error' });
  expect(currentApiMock().mockOf('agentApps.call')).not.toHaveBeenCalled();
  const trigger = screen.getByRole('button', { name: '错过时' });
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const menu = await screen.findByRole('listbox', { name: '错过时' });
  fireEvent.keyDown(menu, { key: 'End' });
  fireEvent.keyDown(menu, { key: 'Enter' });
  fireEvent.submit(screen.getByRole('button', { name: '保存' }).closest('form')!);
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith('one', expect.objectContaining({ params: expect.objectContaining({ values: expect.objectContaining({ missed: 'skip' }) }) })));
});

it('邮箱连接菜单的选择决定后续收信目标', async () => {
  currentApiMock().override('agentApps.query', async () => ({ records: [], total: 0 }));
  currentApiMock().override('agentApps.call', async () => ({ status: 'ok' }));
  const app = builtInAgentApps().find(a => a.id === 'mail')!;
  const connections: AppConnection[] = ['one', 'two'].map(id => ({
    kind: 'imap-smtp', id, name: `邮箱 ${id}`, enabled: true, revision: 1,
    grants: { mail: ['mail.read'] }, address: `${id}@example.test`, user: id,
    imapHost: 'imap.example.test', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.example.test', smtpPort: 465, smtpTls: 'tls', mailbox: 'INBOX'
  }));
  render(<AppDataView workspaceId="one" app={app} view={app.views[0]} route={{ appId: app.id, viewId: app.views[0].id }} navigate={() => {}} connections={connections} search="" revision={1} scrollPositions={new Map()}/>);
  fireEvent.click(screen.getByRole('button', { name: '当前连接' }));
  fireEvent.click(screen.getByRole('option', { name: '邮箱 two' }));
  fireEvent.click(screen.getByRole('button', { name: '收信' }));
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith('one', expect.objectContaining({ commandId: 'sync', params: expect.objectContaining({ accountId: 'two' }) })));
});

function Messages({ connections }: { connections: AppConnection[] }) {
  const [route, setRoute] = React.useState<PhoneRoute>({ appId: 'messages', viewId: 'main' });
  const app = builtInAgentApps().find(a => a.id === 'messages')!;
  return <AppDataView workspaceId="one" app={app} view={app.views[0]} route={route} navigate={setRoute} connections={connections} search="" revision={1} scrollPositions={new Map()}/>;
}

it('短信空状态随语言切换，保留会话内容', async () => {
  currentApiMock().override('agentApps.query', async () => ({ records: [], total: 0 }));
  render(<Messages connections={[]}/>);
  await screen.findByText('还没有消息');
  try {
    act(() => { applyLocaleSetting('en'); });
    expect(await screen.findByText('No messages yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up Feishu' })).toBeTruthy();
    act(() => { applyLocaleSetting('zh-CN'); });
    expect(await screen.findByText('还没有消息')).toBeTruthy();
  } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
});

it('新私聊和群自动显示，打开群后发送只需正文且使用该群目标', async () => {
  currentApiMock().override('agentApps.query', async () => ({ records: [], total: 0 }));
  currentApiMock().override('agentApps.call', async () => ({ status: 'sent' }));
  const { rerender } = render(<Messages connections={[privateChat]}/>);
  expect((await screen.findAllByText('小王')).length).toBeGreaterThan(0);
  expect(screen.queryByRole('combobox', { name: '当前连接' })).toBeNull();
  expect(screen.queryByRole('button', { name: '发送消息' })).toBeNull();
  rerender(<Messages connections={[privateChat, groupChat]}/>);
  fireEvent.click(await screen.findByText('讨论群'));
  expect(screen.queryByRole('combobox', { name: '当前连接' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: '收取消息' }));
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith('one', expect.objectContaining({ appId: 'messages', commandId: 'sync', params: expect.objectContaining({ accountId: 'group' }) })));
  fireEvent.click(await screen.findByRole('button', { name: '发送消息' }));
  expect(screen.queryByRole('combobox', { name: '对话连接' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: '回复消息ID' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '收到' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith('one', expect.objectContaining({ appId: 'messages', commandId: 'send', params: expect.objectContaining({ values: expect.objectContaining({ body: '收到', accountId: 'group' }) }) })));
});
