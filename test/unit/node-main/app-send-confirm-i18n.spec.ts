import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import { applyLocaleSetting } from '../../../src/shared/i18n';

const state = vi.hoisted(() => ({ operation: null as any, signal: new AbortController().signal }));
vi.mock('../../../src/main/safety/bindings', () => ({
  authorizeSafetyOperation: async (_ctx: unknown, operation: any) => {
    state.operation = operation;
    return { allowed: await operation.humanConfirm('审批代理需要人工确认：原始理由', state.signal) };
  }
}));
import { authorizeAppSend } from '../../../src/main/agentApps/sendAuthorization';

afterEach(() => { applyLocaleSetting('zh-CN'); });

it('translates the manual send confirmation without granting a rejected send', async () => {
  const confirm = vi.fn(async () => ({ confirmed: false }));
  const values = { accountId: 'mail', to: 'user@example.test', body: '用户正文' };
  const ctx = { agentApps: { snapshot: async () => ({ connections: [{ id: 'mail', kind: 'imap-smtp' }] }) }, ui: { confirm } } as unknown as AppContext;
  applyLocaleSetting('en');
  expect(await authorizeAppSend(ctx, 'ws', '用户邮箱', values)).toBe(false);
  const [title, reason, options] = confirm.mock.calls[0] as unknown as [string, string, { dangerous: boolean; signal: AbortSignal; confirmLabel: string }];
  expect(title).toBe('Safety review requires confirmation');
  expect(reason).toBe('The approval agent requires human confirmation: 原始理由');
  expect(options).toEqual({ dangerous: true, signal: state.signal, confirmLabel: 'Continue sending' });
  expect(state.operation.args).toBe(values);
  expect(state.operation.action).toBe('mail.send');
});
