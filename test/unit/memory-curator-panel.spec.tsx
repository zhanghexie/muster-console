import React, { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { MemoryCuratorView } from '../../src/renderer/src/components/MemoryCuratorView';
import { createMemoryCuratorSurface, type MemoryCuratorSurface } from '../../src/renderer/src/chatSurface/memoryCuratorSurface';
import { resetOrchestratorListenersForTest } from '../../src/renderer/src/chatSurface/orchestratorSurface';
import type { MemoryCuratorSnapshot } from '../../src/shared/memoryCurator';
import { currentApiMock } from './helpers/api-mock';

vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });

function snapshot(workspaceId: string, messages: MemoryCuratorSnapshot['messages'] = []): MemoryCuratorSnapshot {
  return { workspaceId, sessionId: 'memory-session', generation: 1, status: 'running', paused: false,
    pending: 0, running: true, failed: 0, messages, updatedAt: 1 };
}

function Attached({ surface, workspaceId }: { surface: MemoryCuratorSurface; workspaceId: string }) {
  useEffect(() => surface.attach(), [surface]);
  return <StoreProvider><MemoryCuratorView surface={surface} workspaceId={workspaceId} active disabled={false} /></StoreProvider>;
}

describe('记忆子系统复用调度会话面板', () => {
  it('uses the standard composer/transcript and preserves streaming tool parts', async () => {
    const workspaceId = 'memory-parity';
    const toolMessage = {
      id: 'assistant-1', role: 'assistant' as const, ts: 1,
      parts: [
        { kind: 'tool' as const, tool: { id: 'tool-1', name: 'memory.search', input: { query: '偏好' }, status: 'running' as const } },
        { kind: 'text' as const, text: '正在查询' }
      ]
    };
    const mock = currentApiMock();
    mock.override('memoryCurator.state', async () => snapshot(workspaceId, [toolMessage]));
    mock.override('memoryCurator.onChanged', () => () => undefined);
    resetOrchestratorListenersForTest();
    const surface = createMemoryCuratorSurface(workspaceId);
    render(<Attached surface={surface} workspaceId={workspaceId} />);

    expect(await screen.findByText('正在查询')).toBeTruthy();
    expect(document.querySelector('.agent-composer')).toBeTruthy();
    expect(document.querySelector('.composer-editable[contenteditable="true"]')).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('.tool-call-group')).toBeTruthy();
    expect(screen.getByText('memory.search')).toBeTruthy();
    expect(surface.getSnapshot().messages[0]).toMatchObject({
      parts: expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', tool: expect.objectContaining({ name: 'memory.search', status: 'running' }) })
      ])
    });
  });

  it('exposes the scheduler model button and routes configuration changes to chat.switchModel', async () => {
    const workspaceId = 'memory-model';
    const mock = currentApiMock();
    mock.override('memoryCurator.state', async () => snapshot(workspaceId));
    mock.override('memoryCurator.onChanged', () => () => undefined);
    mock.override('chat.switchModel', async () => ({ ok: true, applied: 'next-turn' }));
    resetOrchestratorListenersForTest();
    const surface = createMemoryCuratorSurface(workspaceId);
    render(<Attached surface={surface} workspaceId={workspaceId} />);
    await waitFor(() => expect(mock.mockOf('memoryCurator.state')).toHaveBeenCalledWith(workspaceId));
    act(() => currentApiMock().emit('agent:context', {
      workspaceId, modelName: '调度模型', modelId: 'dispatch-model', provider: 'fixture',
      tokens: 0, contextWindow: 4096
    }));
    expect(await screen.findByRole('button', { name: '模型与参数' })).toBeTruthy();
    await act(async () => {
      await surface.actions.setModelConfiguration?.({
        expected: 'fixture-stamp', model: { providerId: 'fixture', modelId: 'next-model' }, parameters: {}
      });
    });
    expect(mock.mockOf('chat.switchModel')).toHaveBeenCalledWith(
      { providerId: 'fixture', modelId: 'next-model' }, workspaceId,
      { expected: 'fixture-stamp', parameters: {} }
    );
  });
});
