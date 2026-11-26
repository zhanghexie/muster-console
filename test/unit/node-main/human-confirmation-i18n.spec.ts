import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import { confirmAppDefinition, confirmSessionOperation } from '../../../src/main/safety/humanConfirmation';
import { applyLocaleSetting } from '../../../src/shared/i18n';

afterEach(() => { applyLocaleSetting('zh-CN'); });

it('translates approval chrome while preserving the target and denied result', async () => {
  const confirm = vi.fn(async () => ({ confirmed: false }));
  const ctx = { ui: { confirm } } as unknown as AppContext;
  const signal = new AbortController().signal;
  const reason = '审批代理需要人工确认：用户提供的理由';
  applyLocaleSetting('en');
  expect(await confirmAppDefinition(ctx, 'apps.install', { id: 'custom', name: '用户应用' }, reason, signal)).toBe(false);
  expect(confirm).toHaveBeenNthCalledWith(1, 'App approval needs human review', 'apps.install · 用户应用 (custom)\nThe approval agent requires human confirmation: 用户提供的理由', { dangerous: true, signal });
  const args = { target: '用户会话', count: 2 };
  expect(await confirmSessionOperation(ctx, 'sessions.delete', args, reason, signal)).toBe(false);
  expect(confirm).toHaveBeenNthCalledWith(2, 'Session approval needs human review', `sessions.delete\nTarget: ${JSON.stringify(args)}\nThe approval agent requires human confirmation: 用户提供的理由`, { dangerous: true, signal });
  expect(args).toEqual({ target: '用户会话', count: 2 });
});
