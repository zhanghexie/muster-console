import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';

beforeEach(() => { setFreeViewMode('status'); setFilterActiveWorkspace(false); });
it('头像和时间在首行；工作区、摘要、验收说明、风险、任务和分支仍保留', () => {
  const view = render(<BoardCard sessionId="s" name="任务" runtimeLabel="Codex" status="blocked"
    relTimeTs={Date.now()} isActive={false} onSelect={vi.fn()} onContextMenu={vi.fn()}
    liveLabel="等待验收" reviewSessionId="r" reviewSummary="验收说明" reviewRisks="风险" branch="codex/test" reviewable />);
  const head = view.container.querySelector('.board-card-head')!;
  expect(head.querySelector('.session-row-content .session-state-slot')).toBeTruthy();
  expect(head.querySelector('.session-row-content .session-rail-content')).toBeTruthy();
  expect(head.querySelector('.session-reltime')).toBeTruthy();
  expect(view.container.querySelector('.board-card-meta .session-reltime')).toBeNull();
  expect(view.container.querySelector('.session-rail-status')?.textContent).toContain('等待验收');
  for (const text of ['验收说明', '风险']) expect(view.container.textContent).toContain(text);
  expect(view.container.querySelector('.session-wt-mark')?.getAttribute('title')).toContain('codex/test');
  expect(screen.queryByRole('button', { name: '通过' })).toBeNull();
});

it('切换、过滤和操作都在标题工具栏，去掉重复的范围文字；按钮仍有效', async () => {
  const mock = currentApiMock();
  const workspaces = [{ id: 'w', path: 'E:/fixture', name: '演示', openedAt: 1 }];
  mock.override('workspaces.list', () => Promise.resolve({ workspaces, activeWorkspaceId: 'w' }));
  mock.override('config.get', () => Promise.resolve({ workspaces, activeWorkspaceId: 'w', locale: 'zh-CN' }));
  mock.override('sessions.list', () => Promise.resolve({ sessions: [], activeId: null }));
  const close = vi.fn();
  const view = render(<StoreProvider><BoardPanel onClose={close} /></StoreProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: '过滤' })).toBeTruthy());
  const header = view.container.querySelector('.board-toolbar')!;
  const footer = view.container.querySelector('.board-ticker');
  expect(header.contains(screen.getByRole('tablist', { name: '看板视图' }))).toBe(true);
  expect(header.contains(screen.getByRole('button', { name: '过滤' }))).toBe(true);
  expect(header.contains(screen.getByRole('button', { name: '新建' }))).toBe(true);
  expect(screen.getByRole('button', { name: '过滤' }).textContent).toBe('');
  expect(screen.getByRole('button', { name: '新建' }).textContent).toBe('');
  expect(screen.getByRole('button', { name: '过滤' }).querySelector('svg')).toBeTruthy();
  expect(screen.getByRole('button', { name: '新建' }).querySelector('svg')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /批量清理/ })).toBeNull();
  expect(header.querySelector('div:first-child > span')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '过滤' }));
  expect(screen.getByRole('dialog', { name: '过滤' })).toBeTruthy();
  const statusBody = view.container.querySelector('.board-status-body')!;
  const freeBody = view.container.querySelector('.board-free-body')!;
  fireEvent.click(screen.getByRole('tab', { name: '自由' })); expect(screen.getByRole('tab', { name: '自由' }).getAttribute('aria-selected')).toBe('true');
  expect(statusBody.classList.contains('is-shown')).toBe(false);
  expect(statusBody.hasAttribute('inert')).toBe(true);
  expect(freeBody.classList.contains('is-shown')).toBe(true);
  expect(freeBody.hasAttribute('inert')).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: '状态' })); expect(screen.getByRole('tab', { name: '状态' }).getAttribute('aria-selected')).toBe('true');
  expect(view.container.querySelector('.board-status-body')).toBe(statusBody);
  expect(view.container.querySelector('.board-free-body')).toBe(freeBody);
  expect(statusBody.hasAttribute('inert')).toBe(false);
  expect(freeBody.hasAttribute('inert')).toBe(true);
  expect(view.container.querySelector('.board-toolbar')).toBe(header);
  expect(view.container.querySelector('.board-ticker')).toBe(footer);
  expect(screen.queryByRole('button', { name: '关闭看板' })).toBeNull();
  expect(close).not.toHaveBeenCalled();
});

it('两视图是一张主题工作面，列靠留白组织，卡片独立配色和焦点', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/board.css'), 'utf8');
  const block = (selector: string) => css.slice(css.lastIndexOf(`\n${selector} {`) + 1).split('}')[0];
  for (const selector of ['.board-panel', '.board-grid', '.board-free-body', '.fc-viewport', '.board-column']) {
    expect(block(selector)).toContain('background: var(--surface-board-column)');
  }
  expect(css).not.toContain('.board-column::after');
  expect(css).not.toContain('.fc-viewport::after');
  expect(block('.fc-viewport')).toContain('border-radius: 0');
  expect(block('.board-free-body')).toContain('padding: 0;');
  expect(block('.g-board-sheet')).toContain('border: 1px solid var(--surface-edge)');
  expect(block('.board-column')).toContain('--board-list-inset: 0px');
  expect(block('.board-utility-panel')).toContain('--board-divider-width: 20px');
  expect(block('.board-utility-panel')).toContain('--board-list-gap: 10px');
  expect(block('.board-column-body')).toContain('scrollbar-width: none');
  expect(css).toContain('.board-column-body::-webkit-scrollbar { display: none; }');
  expect(block('.board-card')).toContain('border: 1px solid var(--board-card-border)');
  expect(block('.board-card.active')).not.toContain('border-color:');
  expect(block('.board-card.active::before')).toContain('background: var(--fg-muted)');
  expect(block('.fc-node.is-selected .board-card')).toContain('border-color: var(--board-card-border-focus)');
  expect(block('.board-toolbar')).toContain('flex: 0 0 60px');
  expect(block('.board-management')).toContain('flex-wrap: nowrap');
  expect(block('.board-ticker')).toContain('height: var(--board-ticker-h)');
});

it('看板使用会话列表的归档操作，不显示额外快捷按钮', async () => {
  const user = userEvent.setup();
  const select = vi.fn(), archive = vi.fn();
  const view = render(<BoardCard sessionId="s" name="归档会话" runtimeLabel="Codex" status="exited"
    relTimeTs={Date.now()} isActive={false} onSelect={select} onContextMenu={vi.fn()}
    archived onArchive={archive} reviewable />);
  const head = view.container.querySelector('.board-card-head')!;
  const button = head.querySelector('.session-archive-btn') as HTMLButtonElement;
  expect(button?.getAttribute('aria-label')).toBe('取消归档');
  expect(head.querySelector('.session-row-tools .session-reltime')).toBeTruthy();
  for (const label of ['更多', '通过', '打回', '搁置', '重新拉起', '删除']) {
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  }
  await user.click(button);
  expect(archive).toHaveBeenCalledWith('s');
  expect(select).not.toHaveBeenCalled();
});

it('空闲与已完成不显示重复状态，摘要和分支仍显示；有价值的状态保留', () => {
  const base = { sessionId: 's', name: '任务', runtimeLabel: 'Codex', relTimeTs: Date.now(),
    isActive: false, onSelect: vi.fn(), onContextMenu: vi.fn() };
  const view = render(<BoardCard {...base} status="idle" />);
  expect(view.container.querySelector('.board-card-state')).toBeNull();
  expect(view.container.querySelector('.board-card-meta')).toBeNull();
  expect(view.container.querySelector('.board-card')?.getAttribute('title')).not.toContain('空闲');
  view.rerender(<BoardCard {...base} status="done" liveLabel="验收完成" branch="ao/test" />);
  expect(view.container.querySelector('.board-card-state')).toBeNull();
  expect(view.container.querySelector('.session-rail-status')?.textContent).toContain('验收完成');
  expect(view.container.querySelector('.session-wt-mark')?.getAttribute('title')).toContain('ao/test');
  view.rerender(<BoardCard {...base} status="exited" liveLabel="已完成" />);
  expect(view.container.querySelector('.session-rail-status')?.textContent).toBe('已退出');
  view.rerender(<BoardCard {...base} status="quiet" />);
  expect(view.container.querySelector('.session-rail-status')?.textContent).toBe('等待输出');
  view.rerender(<BoardCard {...base} status="working" />);
  expect(view.container.querySelector('.session-rail-status')?.textContent).toBe('工作中');
  view.rerender(<BoardCard {...base} status="done" reviewable />);
  expect(view.container.querySelector('.session-rail-status')?.textContent).toBe('待验收');
});
