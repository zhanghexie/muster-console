import { describe, expect, it, vi } from 'vitest';
import { createMemoryCuratorSurface } from '../../src/renderer/src/chatSurface/memoryCuratorSurface';
import type { MemoryCuratorApi, MemoryCuratorSnapshot } from '../../src/shared/memoryCurator';
import { applyLocaleSetting } from '../../src/shared/i18n';

function snapshot(patch: Partial<MemoryCuratorSnapshot> = {}): MemoryCuratorSnapshot {
  return { workspaceId: 'curator-a', sessionId: 'curator-session', generation: 1, status: 'idle', paused: false,
    pending: 0, running: false, failed: 0, messages: [], updatedAt: 1, ...patch };
}

function fixture() {
  const listeners = new Set<(value: MemoryCuratorSnapshot) => void>();
  const unsubscribe = vi.fn();
  const api: MemoryCuratorApi = {
    inspect: vi.fn(async () => ({items:[],total:0,offset:0,limit:30})),
    setArchived: vi.fn(async () => ({changed:false})),
    state: vi.fn(async () => snapshot()), send: vi.fn(async () => ({ accepted: true })),
    setPaused: vi.fn(async (_workspaceId, paused) => snapshot({ paused, status: paused ? 'paused' : 'idle', updatedAt: 2 })),
    clear: vi.fn(async () => snapshot({ generation: 2, updatedAt: 2 })),
    onChanged: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener); unsubscribe(); }; })
  };
  const surface = createMemoryCuratorSurface('curator-a', () => api);
  return { api, surface, unsubscribe, push: (value: MemoryCuratorSnapshot) => listeners.forEach(listener => listener(value)) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('专用记忆会话适配器', () => {
  it('只投影宿主状态消息并响应语言切换，不改原始历史和用户消息', async () => {
    const { api, surface, push } = fixture();
    const detachA = surface.attach(), detachB = surface.attach();
    await Promise.resolve();
    const text = '收到 2 条记忆候选，核对依据与已有知识。';
    const messages: MemoryCuratorSnapshot['messages'] = [
      { id: 'host', role: 'user', host: true, ts: 1, parts: [{ kind: 'text', text }] },
      { id: 'repair', role: 'user', host: true, ts: 2, parts: [{ kind: 'text', text: '已确认 1 条处理回执，正在补齐剩余 2 条。' }] },
      { id: 'user', role: 'user', ts: 3, parts: [{ kind: 'text', text }] },
      { id: 'model', role: 'assistant', ts: 4, parts: [{ kind: 'text', text }] }
    ];
    push(snapshot({ updatedAt: 2, messages }));
    const listener = vi.fn(), unsubscribe = surface.subscribe(listener);
    const displayed = () => surface.getSnapshot().messages as MemoryCuratorSnapshot['messages'];
    try {
      applyLocaleSetting('en');
      expect(displayed()[0]?.parts[0]).toEqual({ kind: 'text', text: 'Received memory candidates: 2; checking their evidence and existing knowledge.' });
      expect(displayed()[1]?.parts[0]).toEqual({ kind: 'text', text: 'Processing receipts confirmed: 1; completing the remaining 2.' });
      expect(displayed()[2]?.parts[0]).toEqual({ kind: 'text', text });
      expect(displayed()[3]?.parts[0]).toEqual({ kind: 'text', text });
      expect(surface.getViewState().snapshot?.messages[0]?.parts[0]).toEqual({ kind: 'text', text });
      expect(messages[0]?.parts[0]).toEqual({ kind: 'text', text });
      expect(api.state).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
      applyLocaleSetting('zh-CN');
      expect(displayed()[0]?.parts[0]).toEqual({ kind: 'text', text });
      detachA(); detachB();
      const calls = listener.mock.calls.length;
      applyLocaleSetting('en');
      expect(listener).toHaveBeenCalledTimes(calls);
    } finally {
      unsubscribe(); detachA(); detachB(); surface.dispose(); applyLocaleSetting('zh-CN');
    }
  });
  it('首次观察只读历史；重复观察、卸载与恢复均不发送或恢复模型', async () => {
    const { api, surface, unsubscribe } = fixture();
    const detachA = surface.attach(), detachB = surface.attach();
    await Promise.resolve();
    expect(api.state).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.setPaused).not.toHaveBeenCalled();
    detachA(); expect(unsubscribe).not.toHaveBeenCalled();
    detachB(); expect(unsubscribe).toHaveBeenCalledTimes(1);
    const detachC = surface.attach(); await Promise.resolve();
    expect(api.state).toHaveBeenCalledTimes(2);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.setPaused).not.toHaveBeenCalled();
    detachC();
  });

  it('只接收本工作区新快照，保留真实工具结果，过滤私有推理', async () => {
    const { surface, push } = fixture(); const detach = surface.attach(); await Promise.resolve();
    const messages: MemoryCuratorSnapshot['messages'] = [{ id: 'a1', role: 'assistant', ts: 20, parts: [
      { kind: 'thinking', text: 'private reasoning' }, { kind: 'text', text: '已合并' },
      { kind: 'tool', tool: { id: 'tool-1', name: 'memory.revise', input: { id: 'k1' }, status: 'ok', output: 'saved record k1' } }
    ] }];
    push(snapshot({ generation: 3, updatedAt: 20, messages, running: true, status: 'running', pending: 2 }));
    expect(surface.getSnapshot().busy).toBe(true);
    expect(surface.getViewState().snapshot?.messages[0]?.parts).toEqual(messages[0]!.parts.slice(1));
    expect(surface.sessionId).toBe('memory:curator-a:3');
    push(snapshot({ workspaceId: 'curator-b', generation: 9, updatedAt: 99 }));
    push(snapshot({ generation: 2, updatedAt: 999 }));
    push(snapshot({ generation: 3, updatedAt: 19 }));
    expect(surface.getSnapshot().messages).toHaveLength(1);
    expect(surface.getSnapshot().busy).toBe(true);
    detach();
  });

  it('历史在途收到推送时保留推送，清空之后的旧代响应不能恢复旧历史', async () => {
    const { api, surface, push } = fixture();
    const history = deferred<MemoryCuratorSnapshot>();
    vi.mocked(api.state).mockReturnValueOnce(history.promise);
    const detach = surface.attach();
    push(snapshot({ updatedAt: 10, running: true, status: 'running' }));
    history.resolve(snapshot()); await Promise.resolve();
    expect(surface.getSnapshot().busy).toBe(true);
    await surface.actions.clear();
    push(snapshot({ generation: 1, updatedAt: 100, running: true, status: 'running' }));
    expect(surface.getViewState().snapshot?.generation).toBe(2);
    expect(surface.getSnapshot().busy).toBe(false);
    detach();
  });

  it('删除与脱离工作区使在途响应失效，旧 surface 不能继续发请求', async () => {
    const { api, surface } = fixture(); const history = deferred<MemoryCuratorSnapshot>();
    vi.mocked(api.state).mockReturnValueOnce(history.promise);
    const detach = surface.attach();
    surface.dispose(); history.resolve(snapshot({ running: true })); await Promise.resolve();
    expect(surface.getViewState().snapshot).toBeNull();
    expect(await surface.actions.send('管理记忆')).toBe(false);
    expect(api.send).not.toHaveBeenCalled();
    await surface.setPaused(false); await surface.actions.clear();
    expect(api.setPaused).not.toHaveBeenCalled(); expect(api.clear).not.toHaveBeenCalled();
    detach();
  });

  it('暂停只调用记忆 API，暂停与带附件请求均拒绝发送，失败可重读历史', async () => {
    const { api, surface } = fixture(); const detach = surface.attach(); await Promise.resolve();
    await surface.setPaused(true);
    expect(api.setPaused).toHaveBeenCalledWith('curator-a', true);
    expect(await surface.actions.send('更正')).toBe(false);
    await surface.setPaused(false);
    expect(await surface.actions.send('更正', [{ id: 'image', name: 'test', data: 'a', mimeType: 'image/png' }])).toBe(false);
    vi.mocked(api.send).mockRejectedValueOnce(new Error('model unavailable'));
    expect(await surface.actions.send('更正')).toBe(false);
    // P3 chat-surface F-05：发送失败只走 sendError 通道，不写 view.error（读取失败面）。
    // 旧断言 historyError='model unavailable' 正是「重新读取记忆会话」+「消息未发送」
    // 双矛盾恢复入口的根源——还原 fail(error) 即红。
    expect(surface.getViewState().error).toBe('');
    expect(surface.getSnapshot().historyError).toBeUndefined();
    surface.actions.retry(); await Promise.resolve();
    expect(surface.getSnapshot().historyError).toBeUndefined();
    detach();
  });
});
