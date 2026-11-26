import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';

const convert = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getPath: () => '/user-data', getAppPath: () => '/app' } }));
vi.mock('../../../src/main/attachments/convert', () => ({ convertAttachment: convert }));
vi.mock('../../../src/main/agent/agentScope', () => ({ isSchedulerInvocation: () => false }));
import { attachmentsHost } from '../../../src/main/capabilities/hosts/attachments';

describe('CLI managed attachments', () => {
  it('only resolves a CLI actor against its own CLI attachment scope', () => {
    const ctx = { sessions: { get: () => ({ id: 'cli-a', type: 'terminal', runtime: 'fixture' }),
      isChatRuntime: () => false }, config: { get: () => ({}) } } as unknown as AppContext;
    const request = { sourcePath: '/user-data/attachment', mode: 'text' as const, __actorSessionId: 'cli-a' };
    attachmentsHost['attachments.convert'](ctx, request);
    expect(convert).toHaveBeenCalledWith('/user-data', 'cli:cli-a', request, undefined, expect.any(String));
  });
});
