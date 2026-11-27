import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { setBoardFilterPanelIds, setBoardFilterWorkspaceIds, setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const workspaces = [
  { id: 'a', name: 'Alpha', path: 'E:/alpha', openedAt: 1 },
  { id: 'b', name: 'Beta', path: 'E:/beta', openedAt: 2 }
];
function session(id: string, name: string, workspaceId: string | undefined, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { id, name, workspaceId, type: 'terminal', createdAt: 1, lastUsedAt: 1,
    launchKind: 'agent', runtime: 'pi', status: 'running', lifecycle: 'idle', ...extra };
}
beforeEach(() => { setFilterActiveWorkspace(false); setBoardFilterWorkspaceIds(null); setBoardFilterPanelIds(null); setFreeViewMode('status'); });

it('空看板使用内容自适应空态，不继承侧栏固定高度的会话行', async () => {
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces, activeWorkspaceId: 'a' }));
  mock.override('sessions.list', () => Promise.resolve({ activeId: null, sessions: [] }));
  const view = render(<StoreProvider><BoardPanel /></StoreProvider>);
  const description = await screen.findByText('所有工作区都还没有工作会话');
  const empty = description.closest('.board-empty')!;
  expect(empty.classList.contains('ui-empty')).toBe(true);
  // .session-empty is the left sidebar's 38px row. Reusing it collapses the
  // multi-line board placeholder and clips its 56px brand mark.
  expect(empty.classList.contains('session-empty')).toBe(false);
  const logo = empty.querySelector('svg')!;
  expect(logo.getAttribute('height')).toBe('56');
  expect(empty.querySelectorAll('p')).toHaveLength(2);
  expect(view.container.querySelector('[data-zone="working"]')?.contains(empty)).toBe(true);
});

it('按列和工作区分组，折叠独立且切换过滤后保留；单区仍显示文件夹', async () => {
  const user = userEvent.setup();
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces, activeWorkspaceId: 'a' }));
  mock.override('config.get', () => Promise.resolve({ workspaces, activeWorkspaceId: 'a', locale: 'zh-CN' }));
  mock.override('sessions.list', () => Promise.resolve({ activeId: null, sessions: [
    session('one', 'Alpha 工作', 'a', { lifecycle: 'working' }),
    session('two', 'Beta 空闲', 'b'),
    session('three', 'Alpha 待验收', 'a', { phase: { value: 'needs_you', source: 'model', ts: 1 } }),
    session('four', 'Beta 归档', 'b', { archived: true, status: 'exited', lifecycle: 'exited' }),
    session('five', '无归属会话', undefined)
  ] }));
  const view = render(<StoreProvider><BoardPanel /></StoreProvider>);
  const work = await waitFor(() => {
    const column = view.container.querySelector<HTMLElement>('[data-zone="working"]');
    expect(column?.textContent).toContain('Beta 空闲');
    return column!;
  });
  const alpha = within(work).getByRole('button', { name: /^Alpha · \d+$/ });
  const beta = within(work).getByRole('button', { name: /^Beta · \d+$/ });
  const alphaGroup = alpha.closest('.board-workspace-group')!;
  const betaGroup = beta.closest('.board-workspace-group')!;
  expect(alphaGroup.textContent).toContain('Alpha 工作');
  expect(alphaGroup.querySelector('.board-sched-card')).toBeNull();
  expect(betaGroup.textContent).toContain('Beta 空闲');
  expect(betaGroup.textContent).not.toContain('Alpha 工作');
  expect(within(work).getByRole('button', { name: /^未归属 · \d+$/ })).toBeTruthy();
  expect(alphaGroup.querySelector('.board-card-ws')).toBeNull();
  const needs = view.container.querySelector<HTMLElement>('[data-zone="needsYou"]')!;
  expect(within(needs).getByRole('button', { name: /^Alpha · \d+$/ })).toBeTruthy();
  expect(needs.textContent).toContain('Alpha 待验收');
  const archive = view.container.querySelector<HTMLElement>('[data-zone="archived"]')!;
  expect(within(archive).getByRole('button', { name: /^Beta · \d+$/ })).toBeTruthy();
  expect(archive.textContent).toContain('Beta 归档');
  await user.click(alpha);
  expect(alpha.getAttribute('aria-expanded')).toBe('false');
  const body = document.getElementById(alpha.getAttribute('aria-controls')!)!;
  expect(body.getAttribute('aria-hidden')).toBe('true');
  expect(body.hasAttribute('inert')).toBe(true);
  expect(beta.getAttribute('aria-expanded')).toBe('true');
  await user.click(alpha);
  expect(alpha.getAttribute('aria-expanded')).toBe('true');
  expect(body.hasAttribute('inert')).toBe(false);
  await user.click(alpha);
  await user.click(screen.getByRole('button', { name: '过滤' }));
  const filter = await screen.findByRole('dialog', { name: '过滤' });
  expect(within(filter).getByRole('button', { name: '当前工作区' })).toBeTruthy();
  await user.click(within(filter).getByRole('button', { name: '当前工作区' }));
  expect(work.textContent).toContain('Alpha 工作');
  expect(work.textContent).not.toContain('Beta 空闲');
  await user.click(within(filter).getByRole('button', { name: '全选工作区' }));
  const betaOption = within(filter).getByRole('checkbox', { name: 'Beta' });
  expect(betaOption.closest('label')?.querySelector('.filter-color-dot')).toBeNull();
  await user.click(betaOption);
  await user.click(within(filter).getByRole('checkbox', { name: '未归属' }));
  expect(work.querySelectorAll('.board-workspace-group')).toHaveLength(1);
  expect(within(work).getByRole('button', { name: /^Alpha · \d+$/ }).getAttribute('aria-expanded')).toBe('false');
  expect(work.textContent).not.toContain('Beta 空闲');
  await user.click(within(filter).getByRole('button', { name: '全选工作区' }));
  const restored = within(work).getByRole('button', { name: /^Alpha · \d+$/ });
  expect(restored.getAttribute('aria-expanded')).toBe('false');
  expect(within(work).getByRole('button', { name: /^Beta · \d+$/ }).getAttribute('aria-expanded')).toBe('true');
});

it('过滤菜单可独立多选面板，并保留工作区与面板快捷入口', async () => {
  const user = userEvent.setup();
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces, activeWorkspaceId: 'a' }));
  mock.override('config.get', () => Promise.resolve({ workspaces, activeWorkspaceId: 'a', locale: 'zh-CN' }));
  mock.override('sessions.list', () => Promise.resolve({ activeId: null, sessions: [
    session('working', '进行中', 'a', { lifecycle: 'working' }),
    session('archived', '已归档', 'a', { archived: true, status: 'exited', lifecycle: 'exited' })
  ] }));
  render(<StoreProvider><BoardPanel /></StoreProvider>);
  await screen.findByText('进行中');
  await user.click(screen.getByRole('button', { name: '过滤' }));
  const menu = await screen.findByRole('dialog', { name: '过滤' });
  expect(within(menu).getByRole('button', { name: '当前工作区' })).toBeTruthy();
  expect(within(menu).getByRole('button', { name: '全选工作区' })).toBeTruthy();
  expect(within(menu).getByRole('button', { name: '全选面板' })).toBeTruthy();
  const archived = within(menu).getByRole<HTMLInputElement>('checkbox', { name: '归档' });
  expect(archived.checked).toBe(true);
  expect(archived.closest('label')?.querySelector('.filter-color-dot')).toBeTruthy();
  archived.focus();
  await user.keyboard(' ');
  expect(archived.checked).toBe(false);
  expect(document.querySelector('[data-zone="archived"]')).toBeNull();
  await user.click(within(menu).getByRole('button', { name: '全选面板' }));
  expect(document.querySelector('[data-zone="archived"]')).toBeTruthy();
  expect(archived.checked).toBe(true);
});
