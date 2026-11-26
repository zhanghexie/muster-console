import { describe, expect, it } from 'vitest';
import { mergeNotificationTarget } from '../../src/main/git/mergeNotificationTarget';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';

describe('合入受阻通知归属', () => {
  const workspace = (id: string, first = 'D:/control', second = 'E:/source'): WorkspaceInfo => ({ id, name: id, openedAt: 0,
    path: first, controlRoot: first, roots: [{ id: 'a', path: first }, { id: 'b', path: second }], defaultRootId: 'a' });
  const session = (id: string, repo = 'E:/source/nested'): SessionMeta => ({ id, worktreeBranch: 'ao/task',
    worktreeSource: { mainRepo: repo, commonDir: repo + '/.git' } }) as SessionMeta;
  it('登记源根及其嵌套仓归到对应工作区，未登记仓不归属', () => {
    const ws = workspace('ws');
    const config = { workspaces: [{ ...ws, roots: [...ws.roots!, { id: 'extra', path: 'F:/extra' }] }] };
    for (const repo of ['E:/source', 'E:/source/nested', 'F:/extra/nested']) {
      expect(mergeNotificationTarget(config, () => [], repo, 'ao/task')?.workspaceId).toBe('ws');
    }
    expect(mergeNotificationTarget(config, () => [], 'E:/source-other', 'ao/task')).toBeUndefined();
    expect(mergeNotificationTarget(config, () => [], 'G:/outside', 'ao/task')).toBeUndefined();
    expect(mergeNotificationTarget({ workspaces: [ws] }, () => [], 'F:/extra/nested', 'ao/task')).toBeUndefined();
  });
  it('共享源根通过实际会话仓库身份区分，歧义不指向活动区', () => {
    const config = { workspaces: [workspace('one'), workspace('two', 'G:/control', 'E:/source')] };
    expect(mergeNotificationTarget(config, id => id === 'two' ? [session('owned')] : [session('other', 'F:/elsewhere')],
      'E:/source/nested', 'ao/task')).toEqual({ workspaceId: 'two', session: session('owned') });
    expect(mergeNotificationTarget(config, () => [], 'E:/source/nested', 'ao/task')).toBeUndefined();
    expect(mergeNotificationTarget(config, () => [session('ambiguous')], 'E:/source/nested', 'ao/task')).toBeUndefined();
  });
  it('第二隔离组和组内嵌套仓匹配实际分支，而非旧首组投影', () => {
    const grouped = { ...session('groups', 'D:/control'), worktreeGroups: { version: 1, groups: [{ id: 'g2', path: 'H:/tree',
      source: { mainRepo: 'E:/source', commonDir: 'E:/source/.git' }, branch: 'ao/group2', repos: [{ path: 'nested', branch: 'ao/nested2' }] }] } } as unknown as SessionMeta;
    const config = { workspaces: [workspace('one'), workspace('two', 'G:/control', 'E:/source')] };
    for (const [repo, branch] of [['E:/source', 'ao/group2'], ['E:/source/nested', 'ao/nested2']]) {
      expect(mergeNotificationTarget(config, id => id === 'two' ? [grouped] : [], repo, branch)?.session?.id).toBe('groups');
    }
    expect(mergeNotificationTarget(config, id => id === 'two' ? [grouped] : [], 'H:/tree', 'ao/group2')?.session?.id).toBe('groups');
    expect(mergeNotificationTarget(config, id => id === 'two' ? [grouped] : [], 'H:/tree/nested', 'ao/nested2')?.workspaceId).toBe('two');
  });
  it('坏工作区不会参与通知归属', () => {
    expect(mergeNotificationTarget({ workspaces: [{ ...workspace('bad'), rootsError: 'invalid' }] }, () => [],
      'E:/source', 'ao/task')).toBeUndefined();
  });
});
