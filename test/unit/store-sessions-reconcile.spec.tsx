/**
 * applySessions 逐会话结构等价（B1-4）单测：
 * sessions:changed 广播（500ms 心跳 + lifecycle 翻转）每次都是全新数组/全新对象
 * （IPC 结构化克隆）。契约：
 * 1) 全字段等价判定——fixtures 用 Required<SessionMeta>（编译期强制覆盖全部字段），
 *    逐字段变异必判不等（每字段变化必换引用）；
 * 2) 全表全等时连数组引用也复用（React 同引用 bail out）；
 * 3) 部分变化只换变化行与数组，未变行保持旧引用；
 * 4) 顺序/长度变化视为变化（不复用旧数组）。
 * 还原即红：applySessions 退回无条件 setSessions（或等价门短路 return next）时，
 * 2) 3) 的引用断言转红。
 * 运行: npx vitest run test/unit/store-sessions-reconcile.spec.tsx
 */
import { describe, it, expect } from 'vitest';
import {
  reconcileSessions,
  sessionsEquivalent
} from '../../src/renderer/src/store';
import type { SessionMeta } from '../../src/shared/types';

/** 全字段就位的会话：Required 编译期强制——SessionMeta 新增字段时本文件 typecheck 报错 */
const BASE: Required<SessionMeta> = {
  archiveTerminalText: 'Archived output',
  retainedWorktreeOnly: false,
  worktreeCleanupPending: false,
  configurePermissions: true,
  nativePermissionRestore: { identity: { runtimeId: 'pi', sourceKey: 'root' }, selections: [] },
  nativeConfig: { identity: { runtimeId: 'pi', sourceKey: 'root' }, selections: [] },
  workerRouting: { plan: { requested: { tierId: 'tier' }, scope: { workspaceId: 'w1', rootId: 'root', rootsRevision: 0 }, sourceKey: 'root', controlKey: 'root', candidates: [] }, attempts: [], phase: 'idle' },
  id: 's1',
  type: 'terminal',
  name: '会话一',
  autoNamed: false,
  createdAt: 1000,
  lastUsedAt: 2000,
  boardReplyPreview: '最近回复',
  launchKind: 'agent',
  shellProfileId: 'powershell',
  runtime: 'pi',
  cliLaunchOptions: { model: 'example-model', permission: 'ask' },
  /** 子代理通用化：父子链（子代理为带此字段的普通会话）；本用例是顶层会话故为空串 */
  parentSessionId: '',
  subagentCharacterId: 'rivet',
  externalSessionId: 'ext-1',
  terminalResumeScope: { runtime: 'pi', cwd: 'E:/demo' },
  cwd: 'E:/demo',
  workspaceId: 'ws-a',
  sourceRoot: { rootId: 'r-a', path: 'E:/demo', cwd: 'E:/demo' },
  status: 'running',
  cliSuggestedReplies: { messageId: 'm-1', replies: [] },
  lifecycle: 'working',
  pinned: true,
  pinnedAt: 1500,
  archived: false,
  serviceId: 'svc-1',
  taskId: 'task-1',
  orchestrated: true,
  briefCount: 3,
  liveStatus: { label: '运行中', kind: 'active', summary: '概要', ts: 1234 },
  queuedInjects: 2,
  phase: { value: 'idle', source: 'model', ts: 1200 },
  firstSignalAt: 1100,
  runtimeStartedAt: 1000,
  runtimePresence: 'running',
  lastOutputAt: 2000,
  activity: { kind: 'active', event: 'user-prompt-submit', ts: 1210 },
  worktreePath: 'E:/wt/s1',
  worktreeSource: { mainRepo: 'E:/demo', commonDir: 'E:/demo/.git' },
  worktreeBranch: 'ao/s1',
  worktreeBaseBranch: 'main',
  worktreeRepoSet: [{ path: 'Plugins/Foo', branch: 'ao/s1-foo' }],
  worktreeGroups: { version: 1, primaryGroupId: 'group-a', groups: [{ id: 'group-a', path: 'E:/wt/s1', repos: [] }] },
  statusToken: 'tok-1',
  permissionMode: 'acceptEdits',
  guiMode: 'auto',
  runtimeResumeToken: 'resume-1',
  nativeHistoryStorageKey: 'codex:fixture',
  nativeHistoryCwd: 'E:/demo',
  nativeHistoryDeleteReceipt: '["codex:fixture",["resume-1"]]',
  codexContinuationHistory: [{ sourceId: 'previous', stagingId: 'staging' }],
  piModeId: '',
  modelOverride: {
    providerId: 'p',
    modelId: 'm',
    params: [{ id: 'optimize_for', value: 'quality' }]
  },
  thinkingLevel: 'high',
  modelParameters: { reasoning: 'high' },
  reviewDeferred: false,
  acceptanceLog: [{ at: 1400, decision: 'passed', note: 'ok' }],
  dimensionGates: {
    at: 1350,
    trigger: 'needs_you',
    results: [{ id: 'i18n', status: 'green', checkedFiles: ['a.ts'], problems: [] }]
  },
  meta: { issueId: '42' },
  escalateBudget: { 'task:at-1': 1 },
  hidden: false,
  interruptSnapshot: {
    interruptedAt: 1600,
    lastActivityAt: 1550,
    uncommitted: ['a.ts'],
    worktreeClean: false
  }
};

/** IPC 克隆同款：JSON 往返（BASE 全字段有值，无 undefined 丢键问题） */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 造一个必然不同的值：标量换值，对象/数组深变异首个叶子 */
function changedValue(v: unknown): unknown {
  if (typeof v === 'string') return v + '#变';
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'boolean') return !v;
  if (Array.isArray(v)) return [...v, '__extra__'];
  if (v === null) return 'null→值';
  if (typeof v === 'object') return mutateFirstLeaf(clone(v) as Record<string, unknown>);
  return '其他';
}

function mutateFirstLeaf(obj: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') {
      obj[k] = v + '#变';
      return obj;
    }
    if (typeof v === 'number') {
      obj[k] = v + 1;
      return obj;
    }
    if (typeof v === 'boolean') {
      obj[k] = !v;
      return obj;
    }
    if (Array.isArray(v)) {
      obj[k] = [...v, '__extra__'];
      return obj;
    }
    if (v && typeof v === 'object') return mutateFirstLeaf(v as Record<string, unknown>);
  }
  obj.__changed__ = true;
  return obj;
}

const KEYS = Object.keys(BASE) as Array<keyof Required<SessionMeta>>;

describe('applySessions 逐会话结构等价（B1-4）', () => {
  it('fixtures 覆盖全部字段，同内容克隆判等', () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(45);
    expect(sessionsEquivalent(BASE, clone(BASE))).toBe(true);
  });

  it('每字段变化必判不等（渲染消费字段全覆盖）', () => {
    for (const key of KEYS) {
      const mutated = { ...BASE, [key]: changedValue(BASE[key]) } as Required<SessionMeta>;
      expect(
        sessionsEquivalent(BASE, mutated),
        `字段 ${String(key)} 变化应判不等`
      ).toBe(false);
    }
  });

  it('字段从缺到有也判不等（键数守卫）', () => {
    const without = clone(BASE) as Record<string, unknown>;
    delete without.liveStatus;
    expect(sessionsEquivalent(BASE, without as unknown as SessionMeta)).toBe(false);
  });

  it('全表全等：连数组引用一起复用', () => {
    const prev: SessionMeta[] = [BASE, { ...clone(BASE), id: 's2' }];
    const next = clone(prev);
    expect(reconcileSessions(prev, next)).toBe(prev);
  });

  it('每字段变化必换引用：数组与会话对象都换新', () => {
    for (const key of KEYS) {
      const prev: SessionMeta[] = [BASE];
      const mutated = { ...BASE, [key]: changedValue(BASE[key]) } as Required<SessionMeta>;
      const out = reconcileSessions(prev, [mutated]);
      expect(out, `字段 ${String(key)} 变化应换数组引用`).not.toBe(prev);
      expect(out[0], `字段 ${String(key)} 变化应换会话引用`).not.toBe(BASE);
    }
  });

  it('部分变化：只换变化行，未变行保持旧引用', () => {
    const a = BASE;
    const b: SessionMeta = { ...clone(BASE), id: 's2', name: '会话二' };
    const prev: SessionMeta[] = [a, b];
    const aMutated: SessionMeta = { ...clone(a), liveStatus: { label: '被阻塞', kind: 'waiting', ts: 9999 } };
    const out = reconcileSessions(prev, [aMutated, clone(b)]);
    expect(out).not.toBe(prev);
    expect(out[0]).not.toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
  });

  it('顺序变化（同内容）不复用旧数组；长度变化直接换新', () => {
    const a: SessionMeta = BASE;
    const b: SessionMeta = { ...clone(BASE), id: 's2', name: '会话二' };
    const prev: SessionMeta[] = [a, b];
    const reordered = [clone(b), clone(a)];
    expect(reconcileSessions(prev, reordered)).not.toBe(prev);
    expect(reconcileSessions([a], [a, clone(a)])).not.toBe([a]);
  });
});
