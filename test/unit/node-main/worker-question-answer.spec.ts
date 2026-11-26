import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/agentSession/host/base', () => ({ applySignal: vi.fn(), persistEntry: vi.fn(), syncEntry: vi.fn() }));
vi.mock('../../../src/main/agentSession/tools/policy', () => ({ decideToolCallPermission: vi.fn() }));

import { respondUserQuestion } from '../../../src/main/agentSession/host/approvals';

describe('Worker question answer transport', () => {
  it('preserves an explicitly submitted empty text instead of dropping it', () => {
    const resolve = vi.fn();
    const entry = { sessionId: 'worker', busy: false, activeUserQuestion: { questionId: 'q', resolve },
      assistant: { userQuestion: { questionId: 'q', questions: [], status: 'pending' } } };
    const host = { entries: new Map([['worker', entry]]), ctx: {} } as unknown as Parameters<typeof respondUserQuestion>[0];
    expect(respondUserQuestion(host, 'worker', 'q', 'answer', [{ id: 'host-text', selected: [], custom: '' }])).toBe(true);
    expect(resolve).toHaveBeenCalledWith({ kind: 'answered', answers: [{ id: 'host-text', selected: [], custom: '' }] });
    expect(entry.assistant.userQuestion).toMatchObject({ status: 'answered', answers: [{ id: 'host-text', selected: [], custom: '' }] });
  });
});
