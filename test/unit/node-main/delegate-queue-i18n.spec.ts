import { afterEach, expect, it, vi } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';

vi.mock('../../../src/main/metaAgent/workspaceFile', () => ({ readWorkspaceFile: () => ({}) }));
import { addDelegateDrainedListener, bindDelegateRunner, drainDelegateQueue, enqueueDelegate, resetDelegateQueueForTests } from '../../../src/main/tasks/delegateQueue';
import { waitForSessionLaunch } from '../../../src/main/tasks/delegateLaunch';
import { localizeGuiHostError } from '../../../src/shared/guiHostError';
import { localizeSessionUserError } from '../../../src/main/sessions/userErrors';

afterEach(() => { applyLocaleSetting('zh-CN'); resetDelegateQueueForTests(); });

it('localizes the retained-session notification without changing the workflow outcome', async () => {
  const notices: any[] = [], outcomes: any[] = [];
  const workspace = { id: 'ws', path: process.cwd() };
  const ctx: any = { config: { get: () => ({ workspaces: [workspace], activeWorkspaceId: 'ws' }) },
    sessions: { listByWorkspace: () => [] }, notify: { push: (value: unknown) => notices.push(value) } };
  const off = addDelegateDrainedListener((_id, _workspace, value) => outcomes.push(value));
  const original = Object.assign(new Error('外部原始诊断'), { sessionId: 'child-id' });
  bindDelegateRunner(async () => { throw original; });
  enqueueDelegate(ctx, 'ws', { isolate: false, task: '用户任务' });
  applyLocaleSetting('en');
  await drainDelegateQueue('ws');
  expect(notices[0].text).toBe('Delegation delivery failed. Session child-id was retained; no duplicate was created automatically. 外部原始诊断');
  expect(outcomes[0]).toMatchObject({ ok: false, error: '外部原始诊断', sessionId: 'child-id', dropped: true });
  expect(original.message).toBe('外部原始诊断');
  off();
});

it('translates a real launch failure only at human-facing boundaries', async () => {
  const ctx = { sessions: { get: () => ({ status: 'exited', meta: { launchError: '外部引擎错误' } }) }, pty: { isRunning: () => false } } as any;
  let original!: Error;
  try { await waitForSessionLaunch(ctx, 'child-id'); } catch (error) { original = error as Error; }
  expect(original.message).toBe('会话 child-id 启动失败：外部引擎错误；原会话保留');
  applyLocaleSetting('en');
  expect(localizeGuiHostError(original.message)).toBe('Session child-id failed to start: 外部引擎错误; the original session was retained.');
  expect(localizeGuiHostError('会话 child-id 启动失败：进程已退出；原会话保留')).toBe('Session child-id failed to start: The process exited; the original session was retained.');
  expect(localizeGuiHostError('会话不存在：child-id')).toBe('Session does not exist: child-id');
  expect(original.message).toBe('会话 child-id 启动失败：外部引擎错误；原会话保留');
});

it('retains structured failure details when translating a session error', () => {
  const original = Object.assign(new Error('会话 child-id 启动失败：外部引擎错误；原会话保留'), { sessionId: 'child-id', code: 'ENGINE_FAILED' });
  applyLocaleSetting('en');
  let shown: any;
  try { localizeSessionUserError(original); } catch (error) { shown = error; }
  expect(shown.message).toBe('Session child-id failed to start: 外部引擎错误; the original session was retained.');
  expect(shown.sessionId).toBe('child-id');
  expect(shown.code).toBe('ENGINE_FAILED');
  expect(shown.cause).toBe(original);
  expect(original.message).toBe('会话 child-id 启动失败：外部引擎错误；原会话保留');
});
