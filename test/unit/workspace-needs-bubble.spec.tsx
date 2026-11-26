/**
 * 左下角工作区气泡 needs_you 计数：只计 Worker；调度改走条目胶囊。
 * 与已移除的通知计数胶囊（.agent-notify-count）不是同一物。
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';
import type { WorkspaceInfo } from '../../src/shared/types';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

function ws(id: string, name: string): WorkspaceInfo {
  return { id, path: `E:/demo/${id}`, name, openedAt: 1 };
}

function sess(partial: Partial<SessionMeta> & Pick<SessionMeta, 'id' | 'name'>): SessionMeta {
  return {
    type: 'terminal',
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    phase: { value: 'needs_you', source: 'model', ts: 1 },
    ...partial
  };
}

function seed(opts: { sessions?: SessionMeta[]; schedulerByWs?: Record<string, { phase: string }> }): void {
  const mock = currentApiMock();
  const list = [ws('ws-a', 'Alpha')];
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: list, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: list, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () =>
    Promise.resolve({
      sessions: opts.sessions ?? [],
      activeId: opts.sessions?.[0]?.id ?? null,
      schedulerByWs: opts.schedulerByWs ?? {}
    })
  );
}

function renderFloat() {
  return render(
    <StoreProvider>
      <AgentFloat stackInline />
    </StoreProvider>
  );
}

describe('工作区气泡 needs_you 计数', () => {
  it('无需要你时不渲染计数（也不是旧通知胶囊）', async () => {
    seed({});
    renderFloat();
    await screen.findByTitle(/Alpha/);
    expect(document.querySelectorAll('.agent-notify-needs')).toHaveLength(0);
    expect(document.querySelectorAll('.agent-notify-count')).toHaveLength(0);
  });

  it('Worker needs_you 计 1；调度再报 needs_you 仍为 1', async () => {
    seed({ sessions: [sess({ id: 'se-a', name: '改码' })] });
    renderFloat();
    await screen.findByTitle(/Alpha/);
    await waitFor(() => {
      expect(document.querySelector('.agent-notify-needs')?.textContent).toBe('1');
    });

    currentApiMock().emit('scheduler:status', {
      byWorkspace: {
        'ws-a': {
          workspaceId: 'ws-a',
          sessionId: 'orchestrator:ws-a',
          phase: 'needs_you',
          note: '等决策',
          ts: 1
        }
      }
    });
    await waitFor(() => {
      expect(document.querySelector('.agent-notify-needs')?.textContent).toBe('1');
    });
  });

  it('仅调度 needs_you 不亮黄点', async () => {
    // schedulerByWs 现只喂左下角调度条目胶囊，黄点计数已不读它；保留播种作回归守卫
    //（防止计数重新接回调度源）
    seed({
      schedulerByWs: {
        'ws-a': { phase: 'needs_you' }
      }
    });
    renderFloat();
    await screen.findByTitle(/Alpha/);
    expect(document.querySelectorAll('.agent-notify-needs')).toHaveLength(0);
  });
});
