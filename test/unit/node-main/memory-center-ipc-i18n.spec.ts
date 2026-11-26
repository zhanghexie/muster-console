import { afterEach, expect, it, vi } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), service: null as unknown }));
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (channel: string, handler: (...args: any[]) => any) => state.handlers.set(channel, handler) }));
vi.mock('../../../src/main/ipc/helpers', () => ({ resolveWorkspaceControlRoot: () => 'fixture-root' }));
vi.mock('../../../src/main/memory/serviceRef', () => ({ getMemoryService: () => state.service }));
vi.mock('../../../src/main/memory/centerState', () => ({
  memoryCenterIntents: () => { throw new Error('记忆目录不能经过符号链接'); },
  memoryCenterCancelIntent: () => { throw new Error('第三方原始错误'); },
  memoryCenterRearmIntent: () => ({ ok: true })
}));
import { registerMemoryCenterIpc } from '../../../src/main/memory/ipc';

afterEach(() => { applyLocaleSetting('zh-CN'); state.handlers.clear(); });

it('localizes known memory failures at reminder IPC boundaries and preserves unknown errors', () => {
  registerMemoryCenterIpc({ config: { get: () => ({ activeWorkspaceId: 'workspace' }) } } as any);
  applyLocaleSetting('en');
  expect(() => state.handlers.get('memoryCenter:badge')!(null)).toThrow('Memory service is not ready yet');
  expect(() => state.handlers.get('memoryCenter:intents')!(null)).toThrow('The memory directory cannot pass through a symbolic link.');
  expect(() => state.handlers.get('memoryCenter:intentCancel')!(null, 1)).toThrow('第三方原始错误');
});
