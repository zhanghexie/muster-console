import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '', handlers: new Map<string, (...args: any[]) => any>(), delegate: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir }, ipcMain: { on: vi.fn() }, Notification: vi.fn(), nativeImage: {} }));
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (name: string, fn: (...args: any[]) => any) => state.handlers.set(name, fn), ipcCaller: vi.fn() }));
vi.mock('../../../src/main/tasks/delegate', () => ({ delegateTask: state.delegate, recommendIsolate: vi.fn() }));
import { registerSessionIpc } from '../../../src/main/ipc/sessions';
import { prepareCanvasHandover, discardHandoverDraft } from '../../../src/main/handover/documents';

let root = '';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-ipc-'));
  state.dir = path.join(root, 'data'); fs.mkdirSync(state.dir);
  state.handlers.clear(); state.delegate.mockReset();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function prepared(withLongOutput = false) {
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const source = { id: '11111111-1111-4111-8111-111111111111', name: '源任务', runtime: 'acp', workspaceId: 'ws', cwd, type: 'terminal', createdAt: 1 };
  const ctx = { config: { get: () => ({ workspace: cwd, activeWorkspaceId: 'ws', workspaces: [{ id: 'ws', name: 'ws', path: cwd }] }) },
    sessions: { isChatRuntime: () => true, onSessionRemoved: () => () => {}, get: (id: string) => id === source.id ? source : undefined },
    agentSessions: { getHistory: () => ({ busy: false, messages: [{ id: 'm', role: 'user', ts: 1, parts: [{ kind: 'text', text: '源任务内容' }] },
      ...(withLongOutput ? [{ id: 'a', role: 'assistant', ts: 2, parts: [{ kind: 'tool', tool: {
        id: 't', name: 'Read', input: {}, status: 'ok', output: 'a'.repeat(20000) } }] }] : [])] }) } } as any;
  const draft = await prepareCanvasHandover(ctx, source as any, state.dir);
  registerSessionIpc(ctx);
  return { ctx, draft };
}

it('主进程重新组装不可删除的交接信息，并把文档绑定到将来创建的会话', async () => {
  const { draft } = await prepared(true);
  state.delegate.mockResolvedValue({ queued: true, queuePosition: 1, notified: false });
  const result = await state.handlers.get('tasks:delegate')!(null, { task: '', handoverDraftId: draft.id,
    handoverSupplement: '优先检查测试', runtime: 'acp', workspaceId: 'ws', rootId: draft.sourceRoot.rootId, isolate: false,
    modelParameters: { reasoning: 'high' } });
  expect(result.queued).toBe(true);
  expect(state.delegate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    reservedSessionId: draft.id, task: expect.stringContaining(draft.documentPath), modelParameters: { reasoning: 'high' }
  }));
  expect(state.delegate.mock.calls[0][1].task).toContain('优先检查测试');
  expect(state.delegate.mock.calls[0][1].task).toContain(draft.lockedTask);
  expect(state.delegate.mock.calls[0][1].task).toContain('部分超长工具输出已截断');
  expect(state.delegate.mock.calls[0][1].task).toContain('【本次任务】\n优先检查测试');
  expect(state.delegate.mock.calls[0][1].task).not.toContain('【补充要求】');
  await discardHandoverDraft(state.dir, draft.id);
  expect(fs.existsSync(draft.documentPath)).toBe(true); // queued task still owns it
});

it('普通新建任务的模型参数同样传入派活管线', async () => {
  await prepared();
  state.delegate.mockResolvedValue({ notified: false });
  await state.handlers.get('tasks:delegate')!(null, { task: '普通任务', runtime: 'acp', workspaceId: 'ws',
    isolate: false, modelParameters: { reasoning: 'low' } });
  expect(state.delegate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ modelParameters: { reasoning: 'low' } }));
});

it('创建失败前保留草稿供重试，取消后删除', async () => {
  const { draft } = await prepared();
  state.delegate.mockRejectedValue(new Error('启动预检失败'));
  await expect(state.handlers.get('tasks:delegate')!(null, { task: '', handoverDraftId: draft.id,
    runtime: 'acp', workspaceId: 'ws', isolate: false })).rejects.toThrow('启动预检失败');
  expect(fs.existsSync(draft.documentPath)).toBe(true);
  await discardHandoverDraft(state.dir, draft.id);
  expect(fs.existsSync(draft.documentPath)).toBe(false);
});
