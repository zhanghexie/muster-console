import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAsAgentSession, runAsAgentWorkspace, runAsSchedulerTool } from '../../../src/main/agent/agentScope';
import type { AppContext } from '../../../src/main/context';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../../src/main/messages/read', () => ({ readMailbox: mocks.read }));
import { mailboxHost } from '../../../src/main/capabilities/hosts/mailbox';

const letter = { id: 'one', from: 'child', fromName: 'Worker', read: true, text: '信件正文', offset: 0 };
const result = { messages: [letter], nextCursor: 'next' };

describe('宿主展示记录的读信来源', () => {
  beforeEach(() => { mocks.read.mockReset(); });

  it('按可信调用会话捕获正文，工具返回值保持原样', async () => {
    const publish = vi.fn(() => true);
    const capture = vi.fn(() => publish);
    const ctx = { sessions: { get: () => ({ workspaceId: 'ws' }) }, agentSessions: { captureDisplayItemSink: capture } } as unknown as AppContext;
    mocks.read.mockResolvedValue(result);
    const args = { __actorSessionId: 'session' };
    const actual = await runAsAgentSession('session', () => mailboxHost['sessions.readMessages'](ctx, args));
    expect(actual).toBe(result);
    expect(capture).toHaveBeenCalledWith('session');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mail', pages: [expect.objectContaining({ text: '信件正文' })] }));
  });

  it('调度按调用工作区捕获；摘要、失败和无可信会话不产生附加记录', async () => {
    const publish = vi.fn(() => true);
    const capture = vi.fn(() => publish);
    const ctx = { resolveBubbleWorkspaceId: () => 'ws', orchestrator: { captureDisplayItemSink: capture },
      sessions: { get: () => ({ workspaceId: 'ws' }) }, agentSessions: { captureDisplayItemSink: vi.fn(() => publish) } } as unknown as AppContext;
    mocks.read.mockResolvedValueOnce({ messages: [{ ...letter, text: undefined, preview: '摘要' }] })
      .mockRejectedValueOnce(new Error('读取失败')).mockResolvedValueOnce(result);
    await runAsAgentWorkspace('ws', () => runAsSchedulerTool(() => mailboxHost['sessions.readMessages'](ctx, { includeBody: false })));
    expect(capture).toHaveBeenCalledWith('ws');
    await expect(runAsAgentSession('session', () => mailboxHost['sessions.readMessages'](ctx, { __actorSessionId: 'session' }))).rejects.toThrow('读取失败');
    await mailboxHost['sessions.readMessages'](ctx, { __actorSessionId: 'session' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('结果返回前调用方取消时不创建展示记录', async () => {
    const publish = vi.fn(() => true);
    const ctx = { sessions: { get: () => ({ workspaceId: 'ws' }) },
      agentSessions: { captureDisplayItemSink: () => publish } } as unknown as AppContext;
    const controller = new AbortController();
    mocks.read.mockImplementation(async () => { controller.abort(); return result; });
    expect(await runAsAgentSession('session', () => mailboxHost['sessions.readMessages'](ctx, { __actorSessionId: 'session' }, { signal: controller.signal }))).toBe(result);
    expect(publish).not.toHaveBeenCalled();
  });
});
