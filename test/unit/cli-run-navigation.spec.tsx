import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { createApiMock } from './helpers/api-mock';
const requestAgentPanel = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/src/store', () => ({ useUiStore: () => ({ requestAgentPanel }) }));
import { CliRunNavigation } from '../../src/renderer/src/components/CliRunNavigation';

describe('CLI open handoff', () => {
  it('opens the requested workspace through the existing scheduler route only on an explicit event and unsubscribes', () => {
    requestAgentPanel.mockClear();
    const api = createApiMock(); window.api = api.api;
    const view = render(<CliRunNavigation />);
    expect(requestAgentPanel).not.toHaveBeenCalled();
    act(() => api.emit('cli:openRun', { workspaceId: 'background-workspace', runId: 'run-1' }));
    expect(requestAgentPanel).toHaveBeenCalledExactlyOnceWith('background-workspace');
    act(() => api.emit('cli:openRun', { workspaceId: '', runId: 'invalid' }));
    expect(requestAgentPanel).toHaveBeenCalledTimes(1);
    view.unmount();
    act(() => api.emit('cli:openRun', { workspaceId: 'other', runId: 'run-2' }));
    expect(requestAgentPanel).toHaveBeenCalledTimes(1);
  });
});
