import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { GitPanel } from '../../src/renderer/src/panels/GitPanel';
import { TurnReviewPanel } from '../../src/renderer/src/panels/TurnReviewPanel';
import { defaultWorkspaceFileConfig } from '../../src/shared/metaAgent';
import type { RightContent } from '../../src/shared/rightWorkspace';
import { currentApiMock } from './helpers/api-mock';

const counts = vi.hoisted(() => ({ git: 0, review: 0 }));
// Count descendants of the real panel, preserving its actual memo/forwardRef
// and the real scoped API provider rather than mocking the optimized boundary.
vi.mock('../../src/renderer/src/panels/gitpanel/GitWorkspaceScope', async original => {
  const actual = await original<typeof import('../../src/renderer/src/panels/gitpanel/GitWorkspaceScope')>();
  return { ...actual, GitWorkspaceProvider: (props: React.ComponentProps<typeof actual.GitWorkspaceProvider>) => {
    counts.git++; return <actual.GitWorkspaceProvider {...props}/>;
  } };
});
vi.mock('../../src/renderer/src/components/CustomSelect', async original => {
  const actual = await original<typeof import('../../src/renderer/src/components/CustomSelect')>();
  return { ...actual, CustomSelect: (props: React.ComponentProps<typeof actual.CustomSelect>) => {
    counts.review++; return <actual.CustomSelect {...props}/>;
  } };
});

const workspace = { id: 'render-scope', name: 'Render scope', path: 'E:/repo', openedAt: 0, rootsRevision: 0 };
beforeEach(() => {
  counts.git = counts.review = 0;
  const api = currentApiMock();
  api.override('workspaces.list', async () => ({ workspaces: [workspace], activeWorkspaceId: workspace.id }));
  api.override('config.get', async () => ({ workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN' }));
  api.override('workspaceFile.get', async () => ({ workspaceId: workspace.id, config: defaultWorkspaceFileConfig() }));
  api.override('turnChanges.list', async () => ({ ok: true, entries: [] }));
  Element.prototype.scrollIntoView = () => {};
});

it('未变化的隐藏 Git 面板跳过父级切屏更新，激活仍进入原组件', async () => {
  const page = (active: boolean) => <StoreProvider><PanelHistoryProvider><GitPanel active={active} layout="content"/></PanelHistoryProvider></StoreProvider>;
  const view = render(page(false));
  await waitFor(() => expect(currentApiMock().mockOf('workspaceFile.get')).toHaveBeenCalled());
  await act(async () => {});
  const before = counts.git;
  view.rerender(page(false));
  expect(counts.git).toBe(before);
  await act(async () => { view.rerender(page(true)); });
  expect(counts.git).toBeGreaterThan(before);
  await act(async () => { view.unmount(); });
});

it('隐藏审阅保留内容但跳过父更新，激活和 owner 更新仍重新加载', async () => {
  const content: Extract<RightContent, { kind: 'review' }> = { kind: 'review', owner: { kind: 'gui', id: 'one' } };
  const view = render(<TurnReviewPanel content={content} active={false}/>);
  const before = counts.review;
  expect(before).toBeGreaterThan(0);
  view.rerender(<TurnReviewPanel content={content} active={false}/>);
  expect(counts.review).toBe(before);
  expect(currentApiMock().mockOf('turnChanges.list')).not.toHaveBeenCalled();
  view.rerender(<TurnReviewPanel content={content} active/>);
  await waitFor(() => expect(currentApiMock().mockOf('turnChanges.list')).toHaveBeenCalledWith(content.owner));
  view.rerender(<TurnReviewPanel content={{ ...content, owner: { kind: 'gui', id: 'two' } }} active/>);
  await waitFor(() => expect(currentApiMock().mockOf('turnChanges.list')).toHaveBeenLastCalledWith({ kind: 'gui', id: 'two' }));
});
