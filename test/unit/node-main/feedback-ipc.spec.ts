import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import { applyLocaleSetting } from '../../../src/shared/i18n';
import { bindWorkerToolArgs } from '../../../src/main/capabilities/workerBinding';
import { feedbackHost } from '../../../src/main/capabilities/hosts/feedback';
import { FEEDBACK_TOOL_DEFS } from '../../../src/main/capabilities/catalog/feedback';
import { runAsSchedulerTool } from '../../../src/main/agent/agentScope';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn) }));
import { registerFeedbackIpc } from '../../../src/main/ipc/feedback';

afterEach(() => { handlers.clear(); applyLocaleSetting('zh-CN'); });

it('exposes only type and title as required fields for AI proposals', () => {
  const definition = FEEDBACK_TOOL_DEFS.find(def => def.name === 'feedback.propose')!;
  const params = definition.parameters as any;
  const item = params.properties.items.items;
  expect(item.required).toEqual(['kind', 'title']);
  for (const field of ['area', 'context', 'actual', 'expected', 'steps', 'evidence', 'suggestion', 'impact']) {
    expect(item.properties[field].minLength).toBeUndefined();
  }
});

it('binds the Worker source and history owner to its real session rather than a supplied identity', async () => {
  const propose = vi.fn(() => []);
  const history = vi.fn(async () => ({}));
  const ctx = { feedback: { proposeChecked: propose, history }, sessions: { get: (id: string) => id === 'real' ? { workspaceId: 'ws', name: '真实工作会话' } : undefined },
    workspaces: { list: () => [{ id: 'ws', name: '工作区' }] }, resolveBubbleWorkspaceId: () => 'ws' } as unknown as AppContext;
  const args = bindWorkerToolArgs(ctx, 'feedback.propose', { items: [], checkId: 'check', __actorSessionId: 'forged' }, 'real');
  await feedbackHost['feedback.propose'](ctx, args as { items: unknown; checkId: string; __actorSessionId?: string });
  expect(propose).toHaveBeenCalledWith([], '工作区 · 真实工作会话', 'worker:real', 'check');
  const historyArgs = bindWorkerToolArgs(ctx, 'feedback.history', { __actorSessionId: 'forged' }, 'real');
  await feedbackHost['feedback.history'](ctx, historyArgs);
  expect(history).toHaveBeenCalledWith('worker:real', undefined);
});

it('does not accept a forged Worker identity from the scheduler', async () => {
  const propose = vi.fn(() => []);
  const ctx = { feedback: { proposeChecked: propose }, sessions: { get: () => ({ workspaceId: 'wrong', name: '伪造会话' }) },
    workspaces: { list: () => [{ id: 'ws', name: '工作区' }] }, resolveBubbleWorkspaceId: () => 'ws' } as unknown as AppContext;
  await runAsSchedulerTool(async () => feedbackHost['feedback.propose'](ctx, { items: [], checkId: 'check', __actorSessionId: 'forged' }));
  expect(propose).toHaveBeenCalledWith([], '工作区 · 调度', 'scheduler:ws', 'check');
});

it('allows approval IPC only from the local main frame and localizes errors at the human boundary', async () => {
  const frame = {}, sender = { id: 77, mainFrame: frame };
  const submit = vi.fn(async () => ({ entries: [] }));
  const remove = vi.fn(() => ({ entries: [] }));
  const updateText = vi.fn(() => ({ entries: [] }));
  const copyIssueBody = vi.fn(async () => {});
  const createManual = vi.fn(() => ({ id: 'new', snapshot: { entries: [] } }));
  const service = { submit, delete: remove, updateText, copyIssueBody, createManual, prepare: async () => { throw new Error('GitHub 反馈查询达到限额，请稍后重试。'); }, snapshot: () => { throw new Error('反馈不存在'); } };
  const ctx = { feedback: service, getWindow: () => ({ webContents: sender }) } as unknown as AppContext;
  registerFeedbackIpc(ctx);
  const invoke = handlers.get('feedback:submit')!;
  expect(() => invoke({ sender: { id: 88 }, senderFrame: frame }, 'id', 1, 'review', false)).toThrow('本机工作台');
  expect(() => invoke({ sender, senderFrame: {} }, 'id', 1, 'review', false)).toThrow('本机工作台');
  expect(submit).not.toHaveBeenCalled();
  const copy = handlers.get('feedback:copyIssueBody')!;
  expect(() => copy({ sender: { id: 88 }, senderFrame: frame }, 'id', 2)).toThrow('本机工作台');
  expect(() => copy({ sender, senderFrame: {} }, 'id', 2)).toThrow('本机工作台');
  expect(copyIssueBody).not.toHaveBeenCalled();
  await copy({ sender, senderFrame: frame }, 'id', 2);
  expect(copyIssueBody).toHaveBeenCalledWith('id', 2);
  expect(() => handlers.get('feedback:delete')!({ sender: { id: 88 }, senderFrame: frame }, 'id', 1)).toThrow('本机工作台');
  expect(remove).not.toHaveBeenCalled();
  expect(handlers.get('feedback:delete')!({ sender, senderFrame: frame }, 'id', 1)).toEqual({ entries: [] });
  expect(remove).toHaveBeenCalledWith('id', 1);
  expect(() => handlers.get('feedback:updateText')!({ sender: { id: 88 }, senderFrame: frame }, 'id', 1, 'text')).toThrow('本机工作台');
  expect(updateText).not.toHaveBeenCalled();
  expect(handlers.get('feedback:updateText')!({ sender, senderFrame: frame }, 'id', 1, 'text')).toEqual({ entries: [] });
  expect(updateText).toHaveBeenCalledWith('id', 1, 'text');
  const manual = { kind: 'bug', title: '标题', actual: '内容' };
  expect(() => handlers.get('feedback:createManual')!({ sender: { id: 88 }, senderFrame: frame }, manual)).toThrow('本机工作台');
  expect(createManual).not.toHaveBeenCalled();
  expect(handlers.get('feedback:createManual')!({ sender, senderFrame: frame }, manual)).toEqual({ id: 'new', snapshot: { entries: [] } });
  expect(createManual).toHaveBeenCalledWith(manual);
  expect(handlers.has('feedback:credentialSave')).toBe(false);
  await invoke({ sender, senderFrame: frame }, 'id', 1, 'review', false);
  expect(submit).toHaveBeenCalledOnce();
  applyLocaleSetting('en');
  expect(() => handlers.get('feedback:snapshot')!({ sender, senderFrame: frame })).toThrow('Feedback not found.');
  await expect(handlers.get('feedback:prepare')!({ sender, senderFrame: frame }, 'id', 1)).rejects.toThrow('GitHub issue lookups are rate limited. Try again later.');
});
