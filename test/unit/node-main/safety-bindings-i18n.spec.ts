import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import { applyLocaleSetting } from '../../../src/shared/i18n';

vi.mock('../../../src/main/agent/agentScope', () => ({
  currentAgentSessionId: () => undefined, currentAgentWorkspaceId: () => undefined, isSchedulerInvocation: () => false
}));
vi.mock('../../../src/main/agent/turnScope', () => ({ currentTurnUserText: () => null }));
import { authorizeSafetyOperation } from '../../../src/main/safety/bindings';

afterEach(() => { applyLocaleSetting('zh-CN'); });

it('localizes the human confirmation without changing the reason or approval decision', async () => {
  const confirm = vi.fn(async () => ({ confirmed: false }));
  const signal = new AbortController().signal;
  const rawReason = '审批代理需要人工确认：用户提供的理由';
  const authorize = vi.fn(async (op: { humanConfirm: (reason: string, signal: AbortSignal) => Promise<boolean> }) => ({
    allowed: await op.humanConfirm(rawReason, signal), reason: rawReason, auditUnavailable: false
  }));
  const ctx = { config: { get: () => ({ workspaces: [{ id: 'ws', name: '用户项目' }] }) }, ui: { confirm },
    safety: { authorize }, resolveBubbleWorkspaceId: () => 'ws' } as unknown as AppContext;
  applyLocaleSetting('en');
  const result = await authorizeSafetyOperation(ctx, { workspaceId: 'ws', source: 'catalog', action: 'extensions.trust', args: { id: 'custom' }, dangerous: true });
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe(rawReason);
  const [title, detail, options] = confirm.mock.calls[0] as unknown as [string, string, { summary: string; confirmNote: string; confirmLabel: string; cancelLabel: string; dangerous: boolean; signal: AbortSignal }];
  expect(title).toBe('Approval requires your confirmation');
  expect(detail).toBe('The approval agent requires human confirmation: 用户提供的理由');
  expect(options.confirmNote).toBe(detail);
  expect(options.summary).toContain('用户项目');
  expect(options.summary).toContain('custom');
  expect(options.confirmLabel).toBe('Approve this operation');
  expect(options.cancelLabel).toBe('Deny');
  expect(options.dangerous).toBe(true);
  expect(options.signal).toBe(signal);
});
