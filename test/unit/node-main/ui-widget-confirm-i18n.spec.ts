import { afterEach, expect, it, vi } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({ app: { getPath: () => 'fixture' }, clipboard: { writeText: vi.fn() }, webContents: { getAllWebContents: () => [] } }));
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }));
vi.mock('../../../src/main/uiWidgetStore', () => ({ getUiWidgetStore: () => ({ read: async () => ({ path: '/agent-sessions/session-a/ui/1.inline.html' }) }) }));
vi.mock('../../../src/main/messages/assignment', () => ({ sendSessionMail: vi.fn() }));
import { registerUiWidgetIpc } from '../../../src/main/ipc/uiWidgets';
import { sendSessionMail } from '../../../src/main/messages/assignment';

afterEach(() => { applyLocaleSetting('zh-CN'); handlers.clear(); });

it('uses the current language for the default confirmation title but preserves authored content and outcome', async () => {
  const confirm = vi.fn(async () => ({ confirmed: false }));
  registerUiWidgetIpc({ ui: { confirm } } as any);
  const invoke = handlers.get('uiWidget:action')!;
  applyLocaleSetting('en');
  expect(await invoke(null, 'artifact', { type: 'followup', mode: 'send', text: '用户正文' }))
    .toEqual({ ok: true, cancelled: true, type: 'followup' });
  expect(confirm).toHaveBeenLastCalledWith('Continue the conversation', '用户正文');
  await invoke(null, 'artifact', { type: 'followup', mode: 'send', text: '正文', title: '自定义标题' });
  expect(confirm).toHaveBeenLastCalledWith('自定义标题', '正文');
  applyLocaleSetting('zh-CN');
  await invoke(null, 'artifact', { type: 'followup', mode: 'send', text: '正文' });
  expect(confirm).toHaveBeenLastCalledWith('继续提问', '正文');
});

it('returns localized user-action failures while retaining an upstream mail error', async () => {
  const ctx: any = { ui: { confirm: async () => ({ confirmed: true }) }, sessions: { get: () => undefined }, getWindow: () => null };
  registerUiWidgetIpc(ctx);
  const guest = handlers.get('uiWidget:guest-action')!;
  const event = { sender: { id: 1, isDestroyed: () => false, getType: () => 'webview', getURL: () => 'muster-ext://f/%2Ffixture%2Fwidget.html' } };
  applyLocaleSetting('en');
  expect(() => guest({ sender: { ...event.sender, getType: () => 'window' } }, { type: 'openUrl', url: 'https://example.com' }))
    .toThrow('The interactive page is not connected to the host.');
  await expect(guest(event, { type: 'openUrl', url: 'https://example.com' })).rejects.toThrow('The browser is not ready.');
  const draft = { type: 'followup', mode: 'draft', text: '用户输入' };
  await expect(guest(event, draft)).rejects.toThrow('The owning session has closed.');
  ctx.sessions.get = () => ({ id: 'session-a' });
  await expect(guest(event, draft)).rejects.toThrow('The session window has closed.');
  vi.mocked(sendSessionMail).mockResolvedValueOnce({ stored: false } as any).mockResolvedValueOnce({ stored: false, error: '外部原始错误' } as any);
  const send = { type: 'followup', mode: 'send', text: '用户输入' };
  await expect(guest(event, send)).rejects.toThrow('The message was not sent.');
  await expect(guest(event, send)).rejects.toThrow('外部原始错误');
  vi.mocked(sendSessionMail).mockRejectedValueOnce(new Error('相同寄信标识对应不同内容，请使用新的标识'));
  await expect(guest(event, send)).rejects.toThrow('The same message ID was used for different content. Use a new ID.');
});
