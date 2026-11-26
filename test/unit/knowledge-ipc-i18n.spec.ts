import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { DatabaseSync } from 'node:sqlite';
import { compensateCuratorPolicy } from '../../src/main/memory/curatorPolicy';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
const state = vi.hoisted(() => ({ service: undefined as any }));
vi.mock('../../src/main/ipc/handle', () => ({ handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }));
vi.mock('../../src/main/ipc/helpers', () => ({ resolveWorkspaceControlRoot: () => 'workspace' }));
vi.mock('../../src/main/memory/serviceRef', () => ({ getMemoryService: () => state.service }));
vi.mock('../../src/main/turnChanges/runtime', () => ({ turnChanges: () => ({}) }));
vi.mock('../../src/main/git/identity', () => ({ readGitIdentity: vi.fn() }));
vi.mock('../../src/main/memory/curatorBindings', () => ({ memoryCurator: () => ({ setPaused: async () => {}, snapshot: () => ({ pending: 0, failed: 0, error: undefined, running: false, paused: false }) }) }));
vi.mock('../../src/main/memory/environment', () => ({ checkMemoryEnvironment: () => undefined }));
vi.mock('../../src/main/memory/knowledgeHistory', () => ({ knowledgeHistorySources: vi.fn(), readKnowledgeHistory: vi.fn() }));
vi.mock('../../src/main/memory/knowledgeActivity', () => ({ knowledgeActivity: vi.fn() }));
import { registerKnowledgeIpc } from '../../src/main/memory/knowledgeIpc';
import { knowledgeHistorySources, readKnowledgeHistory } from '../../src/main/memory/knowledgeHistory';

describe('knowledge IPC localization', () => {
  beforeEach(() => { state.service = undefined; });
  it('localizes human-facing rejection and switches back to Chinese', () => {
    registerKnowledgeIpc({} as any);
    const govern = handlers.get('knowledge:govern')!;
    try {
      applyLocaleSetting('en');
      expect(() => govern()).toThrow('Request a correction in the memory conversation');
      applyLocaleSetting('zh-CN');
      expect(() => govern()).toThrow('请在记忆会话提出更正');
    } finally { applyLocaleSetting('zh-CN'); }
  });

  it('localizes validation and unavailable-service errors at the IPC boundary', async () => {
    registerKnowledgeIpc({ config: { get: () => ({ memoryConsolidation: { enabled: false } }) } } as any);
    try {
      applyLocaleSetting('en');
      expect(() => handlers.get('knowledge:create')!(null, 'ws', { namespace: 'invalid' })).toThrow('Invalid memory scope.');
      await expect(handlers.get('knowledge:search')!(null, 'ws', {})).rejects.toThrow('A search query is required.');
      await expect(handlers.get('knowledge:process')!(null, 'ws')).rejects.toThrow('Background memory processing is off.');
      expect(() => handlers.get('knowledge:list')!(null, 'ws')).toThrow('Memory service is not ready yet');
      applyLocaleSetting('zh-CN');
      expect(() => handlers.get('knowledge:create')!(null, 'ws', { namespace: 'invalid' })).toThrow('无效记忆范围');
    } finally { applyLocaleSetting('zh-CN'); }
  });

  it('translates known store errors only for UI calls and preserves unknown errors and raw store messages', () => {
    const failure = new Error('记忆已变化，请刷新后操作');
    const revise = vi.fn(() => { throw failure; });
    const store = { list: () => ({ records: [{ id: 'memory-id' }] }), revise };
    state.service = { knowledge: () => store };
    registerKnowledgeIpc({} as any);
    const invoke = () => handlers.get('knowledge:revise')!(null, 'ws', { id: 'memory-id', revision: 1, draft: {} });
    try {
      applyLocaleSetting('en');
      expect(invoke).toThrow('The memory changed. Refresh and try again.');
      expect(failure.message).toBe('记忆已变化，请刷新后操作');
      const external = new Error('自定义来源错误');
      revise.mockImplementationOnce(() => { throw external; });
      expect(invoke).toThrow(external);
      revise.mockImplementationOnce(() => { throw new Error('记忆写入冲突：用户/目录'); });
      expect(invoke).toThrow('Memory write conflict: 用户/目录');
      revise.mockImplementationOnce(() => { throw new Error('经验需要问题、方法、依据、适用条件和未来用途'); });
      expect(invoke).toThrow('A reusable lesson needs a problem, action, rationale, applicability and future use.');
      revise.mockImplementationOnce(() => { throw new Error('summary 格式或长度错误'); });
      expect(invoke).toThrow('Invalid format or length for summary.');
      applyLocaleSetting('zh-CN');
      expect(invoke).toThrow('记忆已变化，请刷新后操作');
    } finally { applyLocaleSetting('zh-CN'); }
  });

  it('preserves asynchronous rejection while translating a known error', async () => {
    const failure = new Error('记忆资产不完整');
    vi.mocked(knowledgeHistorySources).mockImplementationOnce(() => Promise.reject(failure) as any);
    registerKnowledgeIpc({} as any);
    try {
      applyLocaleSetting('en');
      await expect(handlers.get('knowledge:historySources')!(null, 'ws')).rejects.toThrow('The memory asset is incomplete.');
      expect(failure.message).toBe('记忆资产不完整');
    } finally { applyLocaleSetting('zh-CN'); }
  });

  it('translates a history scope error only in the user IPC response', () => {
    const failure = new Error('历史来源不属于此工作区或查询无效');
    vi.mocked(readKnowledgeHistory).mockImplementationOnce(() => { throw failure; });
    registerKnowledgeIpc({} as any);
    try {
      applyLocaleSetting('en');
      expect(() => handlers.get('knowledge:history')!(null, 'ws', { sessionId: 'foreign', query: '' }))
        .toThrow('The history source does not belong to this workspace, or the query is invalid.');
      expect(failure.message).toBe('历史来源不属于此工作区或查询无效');
    } finally { applyLocaleSetting('zh-CN'); }
  });

  it('translates the actual policy compensation precondition at the human IPC boundary', async () => {
    const db = new DatabaseSync(':memory:');
    let raw!: Error;
    state.service = { continueKnowledgePolicyCompensation: () => {
      try { return compensateCuratorPolicy({ db, transaction: fn => fn(), persist: () => {}, drain: () => {} }, 'not-disabled'); }
      catch (error) { raw = error as Error; throw error; }
    } };
    registerKnowledgeIpc({} as any);
    try {
      applyLocaleSetting('en');
      await expect(handlers.get('knowledge:maintenance')!(null, 'ws', { action: 'continue_policy', namespace: 'worker', policyVersion: 'not-disabled' }))
        .rejects.toThrow('Disable the memory policy before compensating its operations.');
      expect(raw.message).toBe('必须先持久停用记忆策略，再补偿其操作');
    } finally { db.close(); applyLocaleSetting('zh-CN'); }
  });

  it('supports bounded knowledge listing with filters, cursors, and a response byte cap', () => {
    const makeRecord = (id: string, namespace: string, updatedAt: number, summary = id) => ({
      schema: 1, id, revision: 1, namespace, status: 'active', origin: 'user', kind: 'task_fact',
      summary, applicability: [], evidence: [], createdAt: updatedAt, updatedAt,
      decisionReason: '', history: [],
    });
    const snapshots = new Map([
      ['worker', [makeRecord('worker-new', 'worker', 30), makeRecord('worker-old', 'worker', 10)]],
      ['scheduler', [makeRecord('scheduler', 'scheduler', 20)]],
      ['profile', []],
      ['host', []],
    ]);
    const storeFor = (namespace: string) => ({
      list: () => ({ records: snapshots.get(namespace) ?? [], integrityIssues: [], policySuppressedIds: [], pending: 0, active: snapshots.get(namespace)?.length ?? 0, history: 0, startedAt: 1, governance: [] }),
      deletedKnowledgeIds: () => [],
      core: () => '',
    });
    state.service = { knowledge: (_directory: string, namespace: string) => storeFor(namespace) };
    registerKnowledgeIpc({ config: { get: () => ({}) } } as any);
    const list = handlers.get('knowledge:list')!;

    const first = list(null, 'ws', { namespace: 'worker', limit: 1 });
    expect(first.records.map((record: any) => record.id)).toEqual(['worker-new']);
    expect(first.totalCount).toBe(2);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = list(null, 'ws', { namespace: 'worker', limit: 1, cursor: first.nextCursor });
    expect(second.records.map((record: any) => record.id)).toEqual(['worker-old']);
    expect(second.truncated).toBe(false);

    const filtered = list(null, 'ws', { updatedAfter: 15, updatedBefore: 25, limit: 10 });
    expect(filtered.records.map((record: any) => record.id)).toEqual(['scheduler']);
    expect(filtered.totalCount).toBe(1);

    snapshots.set('scheduler', [makeRecord('scheduler', 'scheduler', 20, 'x'.repeat(20_000))]);
    const oversized = list(null, 'ws', { limit: 10, maxBytes: 16_384 });
    expect(oversized.records.map((record: any) => record.id)).toEqual(['worker-new']);
    expect(oversized.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeLessThanOrEqual(16_384);

    expect(() => list(null, 'ws', { limit: 0 })).toThrow('知识列表条数必须在 1 到 500 之间');
    expect(() => list(null, 'ws', { cursor: 'invalid' })).toThrow('知识分页游标无效');
  });
});
