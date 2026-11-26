import { mockHistoryRange } from './helpers/chat-history-mock';
import { act, waitFor } from '@testing-library/react';
import { currentApiMock } from './helpers/api-mock';
import { ensureOrchestratorHistory, getOrchestratorSurface, resetOrchestratorListenersForTest } from '../../src/renderer/src/chatSurface/orchestratorSurface';

beforeEach(() => resetOrchestratorListenersForTest());

it('打开前已运行的调度读取 busy 快照，期间新结束/开始事件优先于迟到快照', async () => {
  const api = currentApiMock();
  mockHistoryRange(api, async () => []);
  api.override('chat.state', async () => ({ busy: true }));
  const initial = getOrchestratorSurface('snapshot-initial');
  ensureOrchestratorHistory('snapshot-initial');
  await waitFor(() => expect(initial.getSnapshot().busy).toBe(true));
  for (const edge of ['done', 'message']) {
    let resolve!: (s: { busy: boolean }) => void;
    api.override('chat.state', () => new Promise((r) => { resolve = r; }));
    const ws = `snapshot-${edge}`;
    const surface = getOrchestratorSurface(ws);
    ensureOrchestratorHistory(ws);
    const message = { id: 'turn', role: 'assistant', content: '', ts: Date.now() };
    act(() => api.emit(`agent:${edge}`, edge === 'done' ? { workspaceId: ws, message } : { workspaceId: ws, ...message }));
    await act(async () => { resolve({ busy: edge === 'done' }); });
    expect(surface.getSnapshot().busy).toBe(edge === 'message');
  }
});

it('工作区移除再打开时，旧 busy 快照不能恢复或覆盖新快照', async () => {
  const api = currentApiMock();
  const pending: Array<(s: { busy: boolean }) => void> = [];
  mockHistoryRange(api, async () => []);
  api.override('chat.state', () => new Promise((resolve) => { pending.push(resolve); }));
  const ws = 'snapshot-reopened';
  ensureOrchestratorHistory(ws);
  act(() => api.emit('workspaces:changed', { workspaces: [], activeWorkspaceId: null }));
  const surface = getOrchestratorSurface(ws);
  ensureOrchestratorHistory(ws);
  expect(pending).toHaveLength(2);
  await act(async () => { pending[0]({ busy: true }); });
  expect(surface.getSnapshot().busy).toBe(false);
  await act(async () => { pending[1]({ busy: false }); });
  expect(surface.getSnapshot().busy).toBe(false);
});
