import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import type { WorkerRouteState, WorkerTargetConfig } from '../../src/shared/workerRouting';

it('shows the resolved Worker and switch reason, with requested and native-confirmed details on demand', () => {
  const initial: WorkerTargetConfig = { harnessId: 'codex', runtimeId: 'codex-gui', surface: 'gui',
    model: { providerId: 'codex-gui', modelId: 'first' } };
  const next: WorkerTargetConfig = { harnessId: 'claude', runtimeId: 'claude', surface: 'gui',
    model: { providerId: 'claude', modelId: 'second' } };
  const routing: WorkerRouteState = {
    phase: 'running', plan: {
      requested: { tierId: 'deep' }, requestedTierName: '攻坚',
      scope: { workspaceId: 'workspace', rootId: 'root', rootsRevision: 3 },
      sourceKey: 'source', controlKey: 'control', candidates: [{ config: initial }, { config: next }]
    },
    attempts: [
      { attempt: 1, state: 'failed', reason: 'quota', config: initial, startedAt: 1, tierName: '攻坚' },
      { attempt: 2, state: 'running', config: next, startedAt: 2, tierName: '攻坚', nativeConfirmed: { modelId: 'native-second' } }
    ]
  };
  const onSelect = vi.fn();
  render(<BoardCard sessionId="worker" name="派活任务" runtimeLabel="Claude Code" status="working" isActive={false}
    relTimeTs={2} onContextMenu={vi.fn()} onSelect={onSelect} workerRouting={routing} />);
  const summary = screen.getByText(/Claude Code · GUI · second.*额度耗尽/);
  expect(screen.queryByText('指定档位 攻坚')).toBeNull();
  fireEvent.click(summary);
  expect(screen.getByText('指定档位 攻坚')).toBeTruthy();
  expect(screen.getByText('引擎尚未确认模型或参数')).toBeTruthy();
  expect(screen.getByText('引擎已确认 native-second')).toBeTruthy();
  expect(onSelect).not.toHaveBeenCalled();
});
