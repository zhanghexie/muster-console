import React, { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { SafetyChatView } from '../../src/renderer/src/components/SafetyChatView';
import { createSafetySurface, type SafetySurface } from '../../src/renderer/src/chatSurface/safetySurface';
import { resetOrchestratorListenersForTest } from '../../src/renderer/src/chatSurface/orchestratorSurface';
import type { SafetySnapshot } from '../../src/shared/safety';
import { currentApiMock } from './helpers/api-mock';

vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });

function snapshot(workspaceId: string): SafetySnapshot {
  return {
    workspaceId, messages: [{
      id: 'review-1', role: 'assistant', origin: 'reviewer', createdAt: 1, text: '已读取审批上下文',
      parts: [
        { kind: 'tool', tool: { id: 'tool-1', name: 'safety_evidence', input: { action: 'diff' }, status: 'running' } },
        { kind: 'text', text: '已读取审批上下文' }
      ]
    }],
    rules: [], ruleRevision: 0, busy: true, generation: 1, records: []
  };
}

function Attached({ surface, workspaceId }: { surface: SafetySurface; workspaceId: string }) {
  useEffect(() => surface.attach(), [surface]);
  return <StoreProvider><SafetyChatView surface={surface} workspaceId={workspaceId} active disabled={false} /></StoreProvider>;
}

describe('审核子系统复用调度会话面板', () => {
  it('renders one continuous standard conversation with structured tool output and no extra pages', async () => {
    const workspaceId = 'safety-parity';
    const mock = currentApiMock();
    mock.override('safety.snapshot', async () => snapshot(workspaceId));
    resetOrchestratorListenersForTest();
    const surface = createSafetySurface(workspaceId);
    render(<Attached surface={surface} workspaceId={workspaceId} />);

    expect(await screen.findByText('已读取审批上下文')).toBeTruthy();
    expect(document.querySelector('.agent-composer')).toBeTruthy();
    expect(document.querySelector('.composer-editable[contenteditable="true"]')).toBeTruthy();
    expect(document.querySelector('.tool-call-group')).toBeTruthy();
    expect(screen.getByText('safety_evidence')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('审批事项')).toBeNull();
    expect(screen.queryByText('放行规则')).toBeNull();
  });

  it('shares the scheduler model selector and delegates switching to chat.switchModel', async () => {
    const workspaceId = 'safety-model';
    const mock = currentApiMock();
    mock.override('safety.snapshot', async () => ({ ...snapshot(workspaceId), messages: [] }));
    mock.override('chat.switchModel', async () => ({ ok: true, applied: 'immediate' }));
    resetOrchestratorListenersForTest();
    const surface = createSafetySurface(workspaceId);
    render(<Attached surface={surface} workspaceId={workspaceId} />);
    await waitFor(() => expect(mock.mockOf('safety.snapshot')).toHaveBeenCalledWith(workspaceId));
    act(() => currentApiMock().emit('agent:context', {
      workspaceId, modelName: '审核跟随模型', modelId: 'review-model', provider: 'fixture',
      tokens: 0, contextWindow: 4096
    }));
    expect(await screen.findByRole('button', { name: '模型与参数' })).toBeTruthy();
    await act(async () => {
      await surface.actions.setModelConfiguration?.({
        expected: 'fixture-stamp', model: { providerId: 'fixture', modelId: 'review-next' }, parameters: {}
      });
    });
    expect(mock.mockOf('chat.switchModel')).toHaveBeenCalledWith(
      { providerId: 'fixture', modelId: 'review-next' }, workspaceId,
      { expected: 'fixture-stamp', parameters: {} }
    );
  });
});
