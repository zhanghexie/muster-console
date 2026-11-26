import { beforeEach, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (name: string, handler: (...args: any[]) => any) => ipc.handlers.set(name, handler) }));
import { registerCanvasLinkIpc } from '../../../src/main/canvasLink';

function fixture(messageCount: number) {
  const source = { id: 'source', name: 'DeepSeek', runtime: 'acp', workspaceId: 'ws', cwd: 'E:/fixture',
    piModeId: 'deepseek', modelOverride: { providerId: 'acp', modelId: 'model' } };
  const child = { ...source, id: 'child' };
  const createTerminal = vi.fn(async () => child);
  const forkSession = vi.fn(async () => ({ ok: true, sessionId: 'child' }));
  const open = vi.fn();
  const ctx = { sessions: { get: (id: string) => id === 'source' ? source : id === 'child' ? child : undefined, createTerminal },
    runtimes: { get: () => ({ surface: 'chat' }) }, agentSessions: { open, messageCount: () => messageCount, forkSession } };
  registerCanvasLinkIpc(ctx as any);
  return { ctx, source, child, createTerminal, forkSession, open };
}

beforeEach(() => { ipc.handlers.clear(); });

it('DeepSeek 画布 fork 使用源会话完整历史并返回后台新会话', async () => {
  const f = fixture(2);
  const result = await ipc.handlers.get('sessions:canvasFork')!(null, 'source');
  expect(f.open).toHaveBeenCalledWith(f.source);
  expect(f.forkSession).toHaveBeenCalledWith('source', undefined, { name: 'DeepSeek ·fork', activate: false });
  expect(f.createTerminal).not.toHaveBeenCalled();
  expect(result.session).toBe(f.child);
});

it('无消息的 GUI fork 在创建空副本时也继承源配置', async () => {
  const f = fixture(0);
  await ipc.handlers.get('sessions:canvasFork')!(null, 'source');
  expect(f.forkSession).not.toHaveBeenCalled();
  expect(f.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'source',
    runtime: 'acp', cwd: 'E:/fixture', workspaceId: 'ws', inheritSourceGuiConfig: true, activate: false }));
});

it('源会话无法分叉时明确返回错误，不创建空会话冒充成功', async () => {
  const f = fixture(2);
  f.forkSession.mockResolvedValueOnce({ ok: false, sessionId: undefined, error: '当前回合进行中' } as any);
  await expect(ipc.handlers.get('sessions:canvasFork')!(null, 'source')).rejects.toThrow('当前回合进行中');
  expect(f.createTerminal).not.toHaveBeenCalled();
});
