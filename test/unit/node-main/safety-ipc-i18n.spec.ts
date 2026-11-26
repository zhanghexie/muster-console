import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import { applyLocaleSetting } from '../../../src/shared/i18n';
import { localizeSafetyReason } from '../../../src/shared/safetyReason';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('../../../src/main/ipc/handle', () => ({
  handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
  ipcCaller: (event: { alive: boolean }) => ({ isAlive: () => event.alive })
}));
import { registerSafetyIpc } from '../../../src/main/ipc/safety';

afterEach(() => { applyLocaleSetting('zh-CN'); handlers.clear(); });

it('localizes human safety validation without bypassing its guards', () => {
  const send = vi.fn();
  registerSafetyIpc({ workspaces: { list: () => [{ id: 'ws' }] }, safety: { send } } as unknown as AppContext);
  const sendHandler = handlers.get('safety:send')!;
  applyLocaleSetting('en');
  expect(() => sendHandler({ alive: false }, 'ws', 'text')).toThrow('The user connection has closed.');
  expect(() => sendHandler({ alive: true }, 'ws', '')).toThrow('Enter a message between 1 and 8,000 characters.');
  expect(() => sendHandler({ alive: true }, 'missing', 'text')).toThrow('The workspace no longer exists.');
  expect(send).not.toHaveBeenCalled();
  applyLocaleSetting('zh-CN');
  expect(() => sendHandler({ alive: true }, 'ws', '')).toThrow('请输入 1–8000 字符的消息');
});

it('translates known service errors at the human boundary without changing them', async () => {
  const error = new Error('审批规则版本已变化，请刷新');
  const unknown = new Error('原始模型错误');
  registerSafetyIpc({ workspaces: { list: () => [{ id: 'ws' }] }, safety: {
    setRuleEnabled: () => { throw error; }, send: async () => { throw unknown; }
  } } as unknown as AppContext);
  applyLocaleSetting('en');
  expect(() => handlers.get('safety:setRuleEnabled')!({ alive: true }, 'ws', 'r1', true, 1)).toThrow('The approval rule revision changed. Refresh and retry.');
  await expect(handlers.get('safety:send')!({ alive: true }, 'ws', 'test')).rejects.toBe(unknown);
  expect(error.message).toBe('审批规则版本已变化，请刷新');
  expect(localizeSafetyReason('审批模型失败：安全审核缺少可用模型或凭据。请人工决定本次操作')).toBe('The approval model failed: Safety review has no available model or credentials. Decide this operation manually.');
  expect(localizeSafetyReason('审批模型失败：审批上下文或请求超过预算。请人工决定本次操作')).toBe('The approval model failed: The approval context or request exceeded its budget. Decide this operation manually.');
  expect(localizeSafetyReason('审批模型失败：审批证据不足或不可用。请人工决定本次操作')).toBe('The approval model failed: Approval evidence is insufficient or unavailable. Decide this operation manually.');
  expect(localizeSafetyReason('审批模型失败：审批证据选择未完成。请人工决定本次操作')).toBe('The approval model failed: The approval evidence selection was not completed. Decide this operation manually.');
  expect(localizeSafetyReason('审批模型失败：审批模型必须先等待证据结果。请人工决定本次操作')).toBe('The approval model failed: The approval model must wait for the evidence result first. Decide this operation manually.');
  expect(localizeSafetyReason('审批模型失败：审批证据仓库不可用：repo-1: fixture missing。请人工决定本次操作')).toBe('The approval model failed: The approval evidence repository is unavailable: repo-1: fixture missing. Decide this operation manually.');
  expect(localizeSafetyReason('审批模型失败：安全模型输出达到上限。请人工决定本次操作')).toBe('The approval model failed: The safety model reached its output limit. Decide this operation manually.');
  expect(localizeSafetyReason('审批模型失败：安全模型调用失败：429 provider offline。请人工决定本次操作')).toBe('The approval model failed: The safety model request failed: 429 provider offline. Decide this operation manually.');
  expect(localizeSafetyReason('审批代理需要人工确认：用户原始理由')).toBe('The approval agent requires human confirmation: 用户原始理由');
  expect(localizeSafetyReason('人工未批准本次操作；审批记录暂不可保存')).toBe('The operation was not approved manually; the approval record cannot be saved right now.');
  expect(localizeSafetyReason('用户原始原因；审批记录暂不可保存')).toBe('用户原始原因；审批记录暂不可保存');
});

it('translates the host provider-error prefix in chat while preserving the provider detail', async () => {
  const error = new Error('安全模型调用失败：429 provider offline');
  registerSafetyIpc({ workspaces: { list: () => [{ id: 'ws' }] }, safety: {
    send: async () => { throw error; }
  } } as unknown as AppContext);
  applyLocaleSetting('en');
  await expect(handlers.get('safety:send')!({ alive: true }, 'ws', 'test')).rejects.toThrow('The safety model request failed: 429 provider offline');
  expect(error.message).toBe('安全模型调用失败：429 provider offline');
});
