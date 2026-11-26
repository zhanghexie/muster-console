import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { StoreProvider } from '../../src/renderer/src/store';
import type { SessionMeta } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  setFreeViewMode('status');
  setFilterActiveWorkspace(false);
});

it('看板状态和自由视图都按会话的 GUI、ACP 和 CLI 身份显示图标', async () => {
  const ws = [{ id: 'ws', path: 'E:/fixture', name: '工作区', openedAt: 1 }];
  const sessions: SessionMeta[] = [
    { id: 'codex', name: 'Codex 会话', runtime: 'codex-gui' },
    { id: 'kimi', name: 'Kimi 会话', runtime: 'acp', piModeId: 'kimi' },
    { id: 'claude', name: 'Claude 会话', runtime: 'claude-code' },
    { id: 'core', name: 'Core 会话', runtime: 'pi', piModeId: 'creator' },
    { id: 'legacy', name: '旧 ACP 会话', runtime: 'acp' }
  ].map((item): SessionMeta => ({ ...item, type: 'terminal', launchKind: 'agent', workspaceId: 'ws',
    createdAt: 1, lastUsedAt: 1, status: 'idle', lifecycle: 'idle' }));
  const mock = currentApiMock();
  mock.override('workspaces.list', async () => ({ workspaces: ws, activeWorkspaceId: 'ws' }));
  mock.override('config.get', async () => ({ workspaces: ws, activeWorkspaceId: 'ws', locale: 'zh-CN' }));
  mock.override('sessions.list', async () => ({ sessions, activeId: null }));
  const view = render(<StoreProvider><BoardPanel /></StoreProvider>);
  await screen.findByRole('button', { name: 'Codex 会话' });
  const expected = [['Codex 会话', 'Codex'], ['Kimi 会话', 'Kimi Code'],
    ['Claude 会话', 'Claude Code'], ['Core 会话', 'Muster Core'], ['旧 ACP 会话', 'ACP']] as const;
  const check = (container: Element) => {
    for (const [name, harness] of expected) {
      const card = within(container as HTMLElement).getByText(name).closest('.board-card')!;
      const icon = card.querySelector(container.classList.contains('board-free-body') ? '.board-card-avatar' : '.session-harness-icon')!;
      expect(icon.getAttribute('aria-label'), name).toBe(harness);
      if (harness === 'ACP') expect(icon.textContent).toBe('A');
      else expect(icon.querySelector('img, svg, span[style*="mask"]'), name).toBeTruthy();
    }
  };
  check(view.container.querySelector('.board-status-body')!);
  fireEvent.click(screen.getByRole('tab', { name: '自由' }));
  await waitFor(() => expect(view.container.querySelectorAll('.board-free-body .fc-node')).toHaveLength(sessions.length));
  check(view.container.querySelector('.board-free-body')!);
});

it('点击图标仍选择所属会话', () => {
  const select = vi.fn();
  const view = render(<BoardCard sessionId="codex" name="Codex 会话" runtimeLabel="Codex" harnessId="codex"
    status="idle" relTimeTs={1} isActive={false} onSelect={select} onContextMenu={vi.fn()} />);
  fireEvent.click(view.container.querySelector('.session-state-slot')!);
  expect(select).toHaveBeenCalledWith('codex');
});
