import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AppDataView } from '../../src/renderer/src/agentApps/AppDataView';
import { builtInAgentApps } from '../../src/shared/agentAppsBuiltins';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { currentApiMock } from './helpers/api-mock';
import type { PhoneRoute } from '../../src/renderer/src/agentApps/presentation';
import { appRecordFieldText } from '../../src/shared/appRecordPlaceholders';
import type { AppConnection, AppPlaceholderKind, AppRecord } from '../../src/shared/agentApps';
import { appConnectionNameText } from '../../src/shared/appConnectionName';

it('translates only marked imported placeholders in lists and details without changing stored content', async () => {
  const app = builtInAgentApps().find(item => item.id === 'mail')!;
  const base = { collection: 'items', revision: 1, createdAt: 1, updatedAt: 1 };
  const rows: AppRecord[] = [
    { ...base, id: 'new', values: { subject: '无主题', body: '邮件较大，正文未下载（上限 2 MB）', folder: 'inbox' }, placeholderFields: { subject: 'mail-no-subject', body: 'mail-body-omitted' } },
    { ...base, id: 'old', values: { subject: '无主题', body: '邮件较大，正文未下载（上限 2 MB）', folder: 'inbox' } },
  ];
  currentApiMock().override('agentApps.query', async (_ws, query) => query.id ? { record: rows.find(row => row.id === query.id) } : { records: rows, total: rows.length });
  function Harness() {
    const [route, navigate] = useState<PhoneRoute>({ appId: app.id, viewId: app.homeView });
    return <AppDataView workspaceId="one" app={app} view={app.views[0]} route={route} navigate={navigate} connections={[]} search="" revision={1} scrollPositions={new Map()}/>;
  }
  const view = render(<Harness/>);
  try {
    await screen.findAllByText('无主题');
    act(() => applyLocaleSetting('en'));
    expect(screen.getByText('No subject')).toBeTruthy();
    expect(screen.getByText('无主题')).toBeTruthy();
    fireEvent.click(screen.getByText('No subject'));
    await screen.findByText('Message too large; the body was not downloaded (2 MB limit).');
    expect(screen.getByText('No subject')).toBeTruthy();
    expect(rows[0].values.subject).toBe('无主题');
    expect(rows[0].values.body).toBe('邮件较大，正文未下载（上限 2 MB）');
    act(() => applyLocaleSetting('zh-CN'));
    await waitFor(() => expect(screen.getByText('无主题')).toBeTruthy());
  } finally { view.unmount(); applyLocaleSetting('zh-CN'); }
});

it('renders marked message placeholders while preserving identical historical messages', async () => {
  const app = builtInAgentApps().find(item => item.id === 'messages')!;
  const base = { collection: 'items', revision: 1, createdAt: 1, updatedAt: 1 };
  const rows: AppRecord[] = [
    { ...base, id: 'new', values: { sender: '未知发送者', body: '此消息已撤回', accountId: 'chat' }, placeholderFields: { sender: 'message-unknown-sender', body: 'message-withdrawn' } },
    { ...base, id: 'old', values: { sender: '未知发送者', body: '此消息已撤回', accountId: 'chat' } },
  ];
  currentApiMock().override('agentApps.query', async () => ({ records: rows, total: rows.length }));
  const view = render(<AppDataView workspaceId="one" app={app} view={app.views[0]} route={{ appId: app.id, viewId: app.homeView, accountId: 'chat' }} navigate={() => {}} connections={[]} search="" revision={1} scrollPositions={new Map()}/>);
  try {
    await screen.findAllByText('此消息已撤回');
    act(() => applyLocaleSetting('en'));
    expect(screen.getByText('Unknown sender')).toBeTruthy();
    expect(screen.getByText('This message was withdrawn.')).toBeTruthy();
    expect(screen.getByText('未知发送者')).toBeTruthy();
    expect(screen.getByText('此消息已撤回')).toBeTruthy();
    expect(rows[0].values.body).toBe('此消息已撤回');
  } finally { view.unmount(); applyLocaleSetting('zh-CN'); }
});

it('has English translations for every known placeholder and rejects stale markers', () => {
  const cases: Array<[AppPlaceholderKind, string, string, string]> = [
    ['rss-no-title', 'title', '无标题', 'Untitled'],
    ['mail-no-subject', 'subject', '无主题', 'No subject'],
    ['mail-body-omitted', 'body', '邮件较大，正文未下载（上限 2 MB）', 'Message too large; the body was not downloaded (2 MB limit).'],
    ['message-unknown-sender', 'sender', '未知发送者', 'Unknown sender'],
    ['message-withdrawn', 'body', '此消息已撤回', 'This message was withdrawn.'],
    ['message-peer', 'sender', '对方', 'Other person'],
    ['message-group-member', 'sender', '群成员', 'Group member'],
    ['message-unknown-body', 'body', '[消息]', '[Message]'],
  ];
  try {
    applyLocaleSetting('en');
    for (const [kind, field, value, english] of cases) {
      const record: AppRecord = { id: kind, collection: 'items', revision: 1, createdAt: 1, updatedAt: 1, values: { [field]: value }, placeholderFields: { [field]: kind } };
      expect(appRecordFieldText(record, field)).toBe(english);
      record.values[field] = '用户实际内容';
      expect(appRecordFieldText(record, field)).toBe('用户实际内容');
    }
  } finally { applyLocaleSetting('zh-CN'); }
});

it('projects generated connection names in the message list without changing identical external names', async () => {
  const app = builtInAgentApps().find(item => item.id === 'messages')!;
  const connection: AppConnection = { kind: 'feishu', id: 'new', name: '飞书群聊 12', namePlaceholder: 'feishu-group', chatId: 'oc_new', identity: 'bot', enabled: true, revision: 1, grants: { messages: ['messages.read'] } };
  const old: AppConnection = { ...connection, id: 'old', chatId: 'oc_old', namePlaceholder: undefined };
  currentApiMock().override('agentApps.query', async () => ({ records: [], total: 0 }));
  const view = render(<AppDataView workspaceId="one" app={app} view={app.views[0]} route={{ appId: app.id, viewId: app.homeView }} navigate={() => {}} connections={[connection, old]} search="" revision={1} scrollPositions={new Map()}/>);
  try {
    await screen.findAllByText('飞书群聊 12');
    act(() => applyLocaleSetting('en'));
    expect(screen.getByText('Feishu group 12')).toBeTruthy();
    expect(screen.getByText('飞书群聊 12')).toBeTruthy();
    expect(appConnectionNameText({ name: '我的飞书私聊', namePlaceholder: 'feishu-paired' })).toBe('My Feishu chat');
    expect(appConnectionNameText({ name: '未命名会话', namePlaceholder: 'feishu-unnamed' })).toBe('Unnamed conversation');
    expect(appConnectionNameText({ name: '用户重命名', namePlaceholder: 'feishu-group' })).toBe('用户重命名');
    expect(connection.name).toBe('飞书群聊 12');
  } finally { view.unmount(); act(() => applyLocaleSetting('zh-CN')); }
});
