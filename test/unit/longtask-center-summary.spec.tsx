/**
 * 长任务诊断的活跃会话摘要接线（P1-3，CenterPanel → longtaskDiag）。
 * 行为合同：活跃会话变化（sessions:changed 广播）时，摘要（id 尾 8 位+名称，
 * 脱敏不含消息正文）随之更新，并进入其后的 longtask 记录；无活跃会话时为 null。
 * 还原即红：CenterPanel 摘除 setLongtaskSessionSummary 接线（或摘要格式改坏、
 * deps 漏掉 active 变化）时对应断言转红。
 * 运行: npx vitest run test/unit/longtask-center-summary.spec.tsx
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { CenterPanel } from '../../src/renderer/src/panels/CenterPanel';
import { currentApiMock } from './helpers/api-mock';
import {
  recordLongtask,
  longtaskRecordsForTest,
  resetLongtaskDiagForTest
} from '../../src/renderer/src/longtaskDiag';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';

vi.mock('../../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`term-${sessionId}`} />
  )
}));

vi.mock('../../src/renderer/src/agentChat/AgentChatView', () => ({
  AgentChatView: ({ sessionId }: { sessionId: string }) => <div data-testid={`chat-${sessionId}`} />
}));


const WS: WorkspaceInfo[] = [{ id: 'ws-a', path: 'E:/proj/a', name: 'Alpha', openedAt: 1 }];

function sess(id: string, name: string): SessionMeta {
  return {
    id,
    type: 'terminal',
    name,
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor-cli',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle'
  };
}

// id 尾 8 位即断言用的摘要段
const MAIN = sess('sess-main-77deada1', '调度主会话');
const OTHER = sess('sess-other-00fabc12', '备会话');
const noopDeps = { memory: () => null, report: () => undefined };

function seed(activeId: string | null): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () => Promise.resolve({ sessions: [MAIN, OTHER], activeId }));
}

function lastSession(): string | null {
  const ring = longtaskRecordsForTest();
  return ring[ring.length - 1]!.session;
}

describe('CenterPanel 活跃会话摘要接线（P1-3）', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    resetLongtaskDiagForTest();
  });

  it('活跃会话摘要进入 longtask 记录；sessions:changed 换会话/清空后摘要跟随', async () => {
    seed('sess-main-77deada1');
    render(
      <StoreProvider>
        <CenterPanel utilityPanel={null} onCloseUtilityPanel={() => {}} />
      </StoreProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('term-sess-main-77deada1')).toBeTruthy();
    });

    // 摘要 = id 尾 8 位 + 名称（脱敏，不含消息正文）
    act(() => {
      recordLongtask(0, 1500, noopDeps);
    });
    expect(lastSession()).toBe('77deada1:调度主会话');

    // 切到另一会话：后续记录带新摘要（deps 漏 active 变化时此处转红）
    act(() => {
      currentApiMock().emit('sessions:changed', {
        sessions: [MAIN, OTHER],
        activeId: 'sess-other-00fabc12'
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('term-sess-other-00fabc12')).toBeTruthy();
    });
    act(() => {
      recordLongtask(1000, 1100, noopDeps);
    });
    expect(lastSession()).toBe('00fabc12:备会话');

    // 无活跃会话：摘要清空为 null
    act(() => {
      currentApiMock().emit('sessions:changed', {
        sessions: [MAIN, OTHER],
        activeId: null
      });
    });
    act(() => {
      recordLongtask(2000, 1100, noopDeps);
    });
    expect(lastSession()).toBeNull();
  });
});
