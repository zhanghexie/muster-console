import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import { applyLocaleSetting, t } from '../../../src/shared/i18n';
import { APP_UI_ERROR_KEYS, APP_STATUS_ERROR_KEYS, APP_UI_ERROR_TEMPLATES, localizeAppUserErrorText } from '../../../src/shared/appUserErrors';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }));
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn) }));
import { registerAgentAppsIpc } from '../../../src/main/ipc/agentApps';

afterEach(() => { applyLocaleSetting('zh-CN'); handlers.clear(); });

it('localizes known sync and async IPC errors and preserves unknown diagnostic details', async () => {
  const original = new Error('飞书 CLI 超时');
  const detail = new Error('发送结果未确认，请核对远端后再决定是否重发：远端原始错误');
  const unknown = new Error('上游未知错误');
  const service = {
    snapshot: async () => { throw original; },
    testConnection: async () => { throw detail; },
    listLibrary: () => { throw unknown; }
  };
  registerAgentAppsIpc({ agentApps: service } as unknown as AppContext);
  applyLocaleSetting('en');
  await expect(handlers.get('agentApps:snapshot')!({}, 'ws')).rejects.toThrow('The Feishu CLI timed out.');
  await expect(handlers.get('agentApps:testConnection')!({}, 'ws', 'mail')).rejects.toThrow('The send result was not confirmed. Check the remote status before deciding whether to resend: 远端原始错误');
  expect(() => handlers.get('agentApps:listLibrary')!({}, 'ws')).toThrow(unknown);
  expect(original.message).toBe('飞书 CLI 超时');
  expect(localizeAppUserErrorText('人工确认失败')).toBe('Manual confirmation failed.');
  expect(localizeAppUserErrorText('飞书连接缺少有效的 CLI profile，请在 Channels 中重新接入飞书。'))
    .toBe('This Feishu connection has no valid CLI profile. Reconnect Feishu in Channels.');
  expect(detail.message).toBe('发送结果未确认，请核对远端后再决定是否重发：远端原始错误');
  expect(localizeAppUserErrorText('上游未知错误')).toBe('上游未知错误');
});

it('provides real English translations for every registered error and retains platform recovery guidance', () => {
  applyLocaleSetting('en');
  for (const key of [...APP_UI_ERROR_KEYS, ...APP_STATUS_ERROR_KEYS]) expect(t(key), key).not.toBe(key);
  for (const item of APP_UI_ERROR_TEMPLATES) expect(localizeAppUserErrorText(`${item.prefix}original`)).toContain('original');
  const credentials = localizeAppUserErrorText(APP_UI_ERROR_KEYS.find(key => key.startsWith('系统凭据存储'))!);
  expect(credentials).toContain('Windows'); expect(credentials).toContain('macOS'); expect(credentials).toContain('Linux');
});

it('projects Feishu chat availability into the current language without changing source data', async () => {
  const page = { chats: [
    { chatId: 'one', name: '用户原名', unavailable: '已添加到手机，请编辑原连接' },
    { chatId: 'two', name: '用户原名 2', unavailable: '第三方原因' }
  ], pageToken: 'next' };
  registerAgentAppsIpc({ agentApps: { listFeishuChats: async () => page } } as unknown as AppContext);
  applyLocaleSetting('en');
  const english = await handlers.get('agentApps:listFeishuChats')!({}, 'ws', 'bot');
  expect(english.chats.map((chat: { unavailable: string }) => chat.unavailable)).toEqual([
    'Already added to the phone; edit the existing connection', '第三方原因'
  ]);
  expect(english.pageToken).toBe('next');
  expect(english.chats[0].name).toBe('用户原名');
  expect(page.chats[0].unavailable).toBe('已添加到手机，请编辑原连接');
  applyLocaleSetting('zh-CN');
  const chinese = await handlers.get('agentApps:listFeishuChats')!({}, 'ws', 'bot');
  expect(chinese.chats[0].unavailable).toBe('已添加到手机，请编辑原连接');
});
