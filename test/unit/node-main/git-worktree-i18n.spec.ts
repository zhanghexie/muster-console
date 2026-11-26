import { afterEach, expect, it, vi } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), invokeIpcChannel: vi.fn() }));
import { registerGitIpc } from '../../../src/main/ipc/git';

afterEach(() => { applyLocaleSetting('zh-CN'); handlers.clear(); });

it('localizes a retained-worktree warning on user IPC while preserving the underlying result', async () => {
  const original = { ok: false, message: 'git 原始错误；创建失败后目录已保留，请检查：/tmp/用户目录' };
  const ctx = { git: { currentOperationScope: () => ({}), withWorkspace: (_scope: unknown, fn: () => unknown) => fn(), worktreeAdd: async () => original } } as any;
  registerGitIpc(ctx);
  applyLocaleSetting('en');
  const shown = await handlers.get('git:worktreeAdd')!(null, '/repo', { dirName: 'work' });
  expect(shown.message).toBe('git 原始错误; the directory was retained after creation failed. Check: /tmp/用户目录');
  expect(original.message).toBe('git 原始错误；创建失败后目录已保留，请检查：/tmp/用户目录');
  original.message = '外部错误；创建失败后目录已保留，请检查：/a；创建失败后目录已保留，请检查：/b';
  expect((await handlers.get('git:worktreeAdd')!(null, '/repo', { dirName: 'work' })).message).toBe(original.message);
  ctx.git.worktreeAdd = async () => ({ ok: true, path: '/work', message: '用户说明；创建失败后目录已保留，请检查：/user' });
  expect((await handlers.get('git:worktreeAdd')!(null, '/repo', { dirName: 'work' })).message).toBe('用户说明；创建失败后目录已保留，请检查：/user');
});
