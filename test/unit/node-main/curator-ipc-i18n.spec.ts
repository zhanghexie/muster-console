import { afterEach, expect, it, vi } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), runtime: {} as any }));
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (channel: string, fn: (...args: any[]) => any) => state.handlers.set(channel, fn) }));
vi.mock('../../../src/main/memory/curatorBindings', () => ({ bindMemoryCurator: () => {}, memoryCurator: () => state.runtime }));
import { registerMemoryCuratorIpc } from '../../../src/main/memory/curatorIpc';

afterEach(() => { applyLocaleSetting('zh-CN'); state.handlers.clear(); });

it('translates known validation and queue errors for human IPC, preserving original failures', async () => {
  const original = new Error('整理记录不存在，请刷新后重试');
  const unknown = new Error('自定义原始错误');
  state.runtime = { inspect: () => { throw original; }, send: async () => { throw unknown; } };
  registerMemoryCuratorIpc({} as any);
  applyLocaleSetting('en');
  expect(() => state.handlers.get('memoryCurator:setArchived')!(null, 'ws', '', true)).toThrow('Invalid processing record ID.');
  expect(() => state.handlers.get('memoryCurator:inspect')!(null, 'ws')).toThrow('The processing record does not exist. Refresh and retry.');
  await expect(state.handlers.get('memoryCurator:send')!(null, 'ws', '用户原文')).rejects.toBe(unknown);
  expect(original.message).toBe('整理记录不存在，请刷新后重试');
});
