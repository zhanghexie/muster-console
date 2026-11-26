import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';

const fixture = vi.hoisted(() => ({ residuals: [{ path: 'E:/用户/保留目录', mainRepo: 'repo', branch: 'fixture', treeRemoved: false, message: '原始诊断' }] }));
vi.mock('../../../src/main/workspaceRootUses', () => ({ workspaceRootUsesFor: () => ({ acquire: () => () => {} }) }));
vi.mock('../../../src/main/git/worktreeSelectionSources', () => ({
  captureWorktreeSelectionSources: () => ({ selections: [{ rootId: 'root', relativePath: 'repo' }], sources: [{ rootId: 'root', path: '/workspace' }] }),
  assertWorktreeSelectionSources: () => {}
}));
vi.mock('../../../src/main/git/worktreeTaskOperation', () => ({ beginTaskWorktreeOperation: () => ({ holdRepository() {}, release() {} }), taskWorktreeOwnership: () => 'same' }));
vi.mock('../../../src/main/git/repoIdentity', () => ({ readGitDirectories: () => ({ commonDir: path.resolve('/workspace/repo/.git') }) }));
vi.mock('../../../src/main/sessions/targets', () => ({ resolveSessionTarget: async () => ({}) }));
vi.mock('../../../src/main/git/worktreeTaskCreate', () => ({ createTaskWorktreeGroups: async () => ({ ok: false, message: 'fixture failure', residuals: fixture.residuals }) }));

import { attachTaskWorktrees } from '../../../src/main/git/worktreeAttach';

afterEach(() => applyLocaleSetting('zh-CN'));

it('localizes the retained-resource toast without changing model results or paths', async () => {
  applyLocaleSetting('en');
  const session = { workspaceId: 'ws', cwd: path.resolve('/workspace'), type: 'terminal', name: 'Worker' };
  const notices: any[] = [];
  const ctx: any = { findSession: () => session, config: { get: () => ({}) }, git: { probeDirty: async () => false }, notify: { push: (notice: unknown) => notices.push(notice) } };
  const result = await attachTaskWorktrees(ctx, 'session', [{ rootId: 'root', relativePath: 'repo' }], true);
  expect(result).toEqual({ ok: false, message: 'fixture failure', residuals: fixture.residuals });
  expect(notices).toEqual([expect.objectContaining({ workspaceId: 'ws', sessionId: 'session', toast: true,
    text: `Appending worktrees left retained resources: ${JSON.stringify(fixture.residuals)}` })]);
});
