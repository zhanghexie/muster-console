/**
 * 左栏会话搜索：名称/摘要/胶囊过滤、计数、Esc 清空失焦、无匹配空态。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

// jsdom does not implement the observer used by the sidebar scroll edges.
vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function sess(
  id: string,
  name: string,
  extra: Partial<SessionMeta> = {}
): SessionMeta {
  return {
    id,
    type: 'terminal',
    name,
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    ...extra
  };
}

const SESSIONS: SessionMeta[] = [
  sess('s1', '修搜索条', { liveStatus: { label: '实现中', kind: 'active', ts: 1 } }),
  sess('s2', '其他任务', {
    liveStatus: { label: '排查中', kind: 'waiting', ts: 1, summary: '看日志' }
  }),
  sess('s3', '第三个', {
    liveStatus: { label: '等构建', kind: 'info', ts: 1, summary: '统一搜索摘要' }
  })
];

function seed(): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () =>
    Promise.resolve({ sessions: SESSIONS, activeId: 's1' })
  );
}

function renderLeft(): void {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  seed();
  const noop = (): void => {};
  render(
    <StoreProvider>
      <PanelHistoryProvider>
        <LeftPanel
          utilityPanel={null}
          onSelectUtilityPanel={noop}
          onCloseUtilityPanel={noop}
        />
      </PanelHistoryProvider>
    </StoreProvider>
  );
}

async function openAgentSearch(): Promise<HTMLInputElement> {
  const toggle = await screen.findByRole('button', { name: '搜索工作会话' });
  fireEvent.click(toggle);
  return screen.getByRole('searchbox', { name: '搜索工作会话' }) as HTMLInputElement;
}

describe('左栏会话搜索', () => {
  it('按名称 / 胶囊 / 摘要过滤，并显示匹配计数', async () => {
    const user = userEvent.setup();
    renderLeft();
    await screen.findByText('修搜索条');
    expect(screen.getByText('其他任务')).toBeTruthy();
    expect(screen.getByText('第三个')).toBeTruthy();

    const input = await openAgentSearch();
    await user.type(input, '搜索条');
    expect(screen.getByText('修搜索条')).toBeTruthy();
    expect(screen.queryByText('其他任务')).toBeNull();
    expect(screen.getByText('1/3')).toBeTruthy();

    await user.clear(input);
    await user.type(input, '排查中');
    expect(screen.getByText('其他任务')).toBeTruthy();
    expect(screen.queryByText('修搜索条')).toBeNull();

    await user.clear(input);
    await user.type(input, '统一搜索摘要');
    expect(screen.getByText('第三个')).toBeTruthy();
    expect(screen.queryByText('其他任务')).toBeNull();
  });

  it('无匹配显示空态', async () => {
    const user = userEvent.setup();
    renderLeft();
    const input = await openAgentSearch();
    await user.type(input, 'zzzz-no-hit');
    expect(screen.getByText('无匹配的工作会话')).toBeTruthy();
    expect(screen.getByText('0/3')).toBeTruthy();
  });

  it('Esc 清空并失焦，收起搜索条', async () => {
    const user = userEvent.setup();
    renderLeft();
    const input = await openAgentSearch();
    await user.type(input, '搜索条');
    expect(input.value).toBe('搜索条');

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('searchbox', { name: '搜索工作会话' })).toBeNull();
    });
    expect(screen.getByText('工作会话')).toBeTruthy();
    expect(screen.getByText('其他任务')).toBeTruthy();
  });
});
