import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import type { ExtensionReviewRequest } from '../../../src/main/extensions/extensionReview';
import { applyLocaleSetting } from '../../../src/shared/i18n';

vi.mock('../../../src/main/safety/bindings', () => ({ authorizeSafetyOperation: vi.fn() }));
vi.mock('../../../src/main/agent/agentScope', () => ({ runOutsideAgentScope: (run: () => unknown) => run() }));
import { createExtensionSafetyReviewer } from '../../../src/main/extensions/extensionSafety';

afterEach(() => { applyLocaleSetting('zh-CN'); });

it('localizes a human review request without dropping evidence or relaxing the approval', async () => {
  const confirm = vi.fn(async () => false);
  const review = createExtensionSafetyReviewer({ ui: { confirm } } as unknown as AppContext);
  const request = { manifest: { name: '用户扩展', scope: 'global', permissions: ['native'] },
    candidate: { directory: 'C:/扩展' }, snapshot: { fingerprint: 'sha256:abc' },
    evidenceError: '原始错误', signal: new AbortController().signal } as unknown as ExtensionReviewRequest;
  applyLocaleSetting('en');
  expect(await review(request)).toEqual({ approved: false, reason: '人工审核未通过' });
  const [title, detail, options] = confirm.mock.calls[0] as unknown as [string, string, { dangerous: boolean; signal: AbortSignal; confirmNote: string }];
  expect(title).toBe('Review extension: 用户扩展');
  expect(detail).toContain('Could not complete the automatic review: 原始错误.');
  expect(detail).toContain('Source: C:/扩展');
  expect(detail).toContain('Package fingerprint: sha256:abc');
  expect(detail).toContain('full local permissions');
  expect(options.dangerous).toBe(true);
  expect(options.signal).toBe(request.signal);
  expect(options.confirmNote).toContain('原始错误');
});
