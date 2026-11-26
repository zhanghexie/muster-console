import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ExtensionDiscoveredExtension, ExtensionManagementSnapshot } from '../../src/shared/extension';
import type { ExtensionCenterInstallResult, ExtensionCenterInstallSnapshot, ExtensionCenterListing } from '../../src/shared/extensionCenter';
import { ExtensionsManagerContainer } from '../../src/renderer/src/panels/ExtensionsManagerContainer';

beforeEach(() => dismissTip());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function snapshot(workspaceId: string, rootId: string, name: string): ExtensionManagementSnapshot {
  const project: ExtensionDiscoveredExtension = { workspaceId, id: name, directory: '/workspace', status: 'approved', enabled: true, fingerprint: 'package-extension:1', manifest: { id: name, name, scope: 'project', project: { kind: 'relative', path: 'demo' }, surface: { kind: 'sidebar', entry: 'panel.html' }, domain: { entry: 'domain.mjs', queries: [], commands: [], events: [] }, agent: { profile: 'scheduler-pi', skills: [], mcp: [] }, data: { workspace: true, shared: false }, permissions: ['agent.state'] } };
  return { workspaceId, sourceRootId: rootId, selectionRevision: rootId === 'one' ? 0 : 1, projects: [{ id: 'one', label: '项目一' }, { id: 'two', label: '项目二' }], listing: { global: [], project: [project], issues: [], problems: [] } };
}

it('discards a late response from a previously selected workspace', async () => {
  const old = deferred<ExtensionManagementSnapshot>();
  const api = { snapshot: vi.fn((workspace: string) => workspace === 'a' ? old.promise : Promise.resolve(snapshot('b', 'one', 'b-only'))), selectProject: vi.fn(), setEnabled: vi.fn(), onChanged: vi.fn(() => () => {}) };
  const { rerender } = render(<ExtensionsManagerContainer workspaceId="a" api={api}/>);
  rerender(<ExtensionsManagerContainer workspaceId="b" api={api}/>);
  await screen.findByRole('tab', { name: /项目扩展/ });
  fireEvent.click(screen.getByRole('tab', { name: /项目扩展/ }));
  expect(screen.getByText('b-only')).toBeTruthy();
  await act(async () => { old.resolve(snapshot('a', 'one', 'a-only')); await old.promise; });
  expect(screen.getByText('b-only')).toBeTruthy();
  expect(screen.queryByText('a-only')).toBeNull();
});

it('hides the old project while switching and ignores a late toggle result', async () => {
  let current = snapshot('a', 'one', 'first');
  const toggle = deferred<ExtensionManagementSnapshot>();
  const api = {
    snapshot: vi.fn(async () => current),
    selectProject: vi.fn(async (_workspace: string, root: string) => { current = snapshot('a', root, 'second'); return current; }),
    setEnabled: vi.fn(() => toggle.promise),
    onChanged: vi.fn(() => () => {})
  };
  render(<ExtensionsManagerContainer workspaceId="a" api={api}/>);
  await screen.findByRole('tab', { name: /项目扩展/ });
  fireEvent.click(screen.getByRole('tab', { name: /项目扩展/ }));
  fireEvent.click(screen.getByRole('switch', { name: '启用 first' }));
  expect(api.setEnabled).toHaveBeenCalledWith('a', 'one', 'project', 'first', false, 0);
  fireEvent.click(screen.getByRole('button', { name: '选择当前项目' }));
  fireEvent.click(screen.getByRole('option', { name: '项目二' }));
  await waitFor(() => expect(api.selectProject).toHaveBeenCalledWith('a', 'two'));
  await screen.findByRole('tab', { name: /项目扩展/ });
  expect(screen.getByRole('tab', { name: /项目扩展/ }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText('second')).toBeTruthy();
  await act(async () => { toggle.resolve(snapshot('a', 'one', 'first')); await toggle.promise; });
  expect(screen.getByText('second')).toBeTruthy();
  expect(screen.queryByText('first')).toBeNull();
});

it('shows and clears builtin preparation errors when the host publishes changes', async () => {
  let current = snapshot('a', 'one', 'first');
  let changed = (_workspaceId?: string): void => {};
  const api = {
    snapshot: vi.fn(async () => current), selectProject: vi.fn(), setEnabled: vi.fn(),
    onChanged: vi.fn((listener: (workspaceId?: string) => void) => { changed = listener; return () => {}; })
  };
  render(<ExtensionsManagerContainer workspaceId="a" api={api}/>);
  await screen.findByRole('tab', { name: /全局扩展/ });
  const issue = '内置日报：A 已有无法确认归属的同名扩展，保留原文件';
  current = { ...current, listing: { ...current.listing, issues: [issue] } };
  await act(async () => { changed(); });
  await waitFor(() => expect(getTipSnapshot()).toMatchObject({ text: issue, tone: 'error' }));
  expect(screen.queryByText(issue)).toBeNull();
  act(() => dismissTip());
  current = { ...current, listing: { ...current.listing, issues: [] } };
  await act(async () => { changed(); });
  await waitFor(() => expect(getTipSnapshot()).toBeNull());
});

it('loads the extension center only when its tab is opened', async () => {
  const firstLoad = deferred<ExtensionCenterListing>();
  const centerList = vi.fn<(force?: boolean) => Promise<ExtensionCenterListing>>()
    .mockReturnValueOnce(firstLoad.promise)
    .mockResolvedValueOnce({ source: 'bundled', releases: [] });
  const api = {
    snapshot: vi.fn(async () => snapshot('a', 'one', 'first')),
    selectProject: vi.fn(), setEnabled: vi.fn(), onChanged: vi.fn(() => () => {}), centerList
  };
  render(<ExtensionsManagerContainer workspaceId="a" api={api}/>);
  await screen.findByRole('tab', { name: /全局扩展/ });
  expect(centerList).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: '扩展中心' }));
  expect(screen.queryByText('GitHub 扩展中心')).toBeNull();
  firstLoad.resolve({ source: 'github', releases: [{ packageKey: 'muster/bookshelf', publisherId: 'muster', extensionId: 'bookshelf', name: '图书馆', version: '1.0.0', fingerprint: 'package-extension:abc', sourceKind: 'center', installed: false }] });
  await screen.findByText('图书馆');
  expect(screen.getByText('GitHub 扩展中心')).toBeTruthy();
  expect(centerList).toHaveBeenCalledTimes(1);
  expect(centerList).toHaveBeenCalledWith(false);
  const center = within(screen.getByRole('tabpanel', { name: '扩展中心' }));
  fireEvent.click(center.getByRole('button', { name: '刷新' }));
  await screen.findByText('内置扩展目录');
  expect(centerList).toHaveBeenLastCalledWith(true);
  expect(screen.queryByText('GitHub 扩展中心')).toBeNull();
});

it('shows real install progress in the list and detail, and keeps a failed install retryable', async () => {
  const packageKey = 'muster/guizang-design';
  const installing = deferred<ExtensionCenterInstallResult>();
  const catalog: ExtensionCenterListing = { source: 'github', releases: [{
    packageKey, publisherId: 'muster', extensionId: 'guizang-design', name: '歸藏设计', version: '0.1.1',
    fingerprint: 'package-extension:abc', sourceKind: 'center', installed: false,
  }] };
  let emitProgress: (value: ExtensionCenterInstallSnapshot) => void = () => {};
  const api = {
    snapshot: vi.fn(async () => snapshot('a', 'one', 'first')), selectProject: vi.fn(), setEnabled: vi.fn(),
    onChanged: vi.fn(() => () => {}), centerList: vi.fn(async () => catalog),
    onCenterInstallProgress: (listener: typeof emitProgress) => { emitProgress = listener; return () => {}; },
    centerInstall: vi.fn(() => installing.promise),
  };
  render(<ExtensionsManagerContainer workspaceId="a" api={api}/>);
  fireEvent.click(await screen.findByRole('tab', { name: '扩展中心' }));
  const center = within(screen.getByRole('tabpanel', { name: '扩展中心' }));
  fireEvent.click(await center.findByRole('button', { name: '安装' }));
  act(() => emitProgress({ revision: 1, active: [{ packageKey, progress: { phase: 'downloading', receivedBytes: 1_000_000 } }] }));
  expect(center.getByText(/已下载.*1 MB/)).toBeTruthy();
  expect(center.queryByRole('progressbar')).toBeNull();
  act(() => emitProgress({ revision: 2, active: [{ packageKey, progress: { phase: 'downloading', receivedBytes: 5_000_000, totalBytes: 20_000_000 } }] }));
  expect(center.getByRole('progressbar').getAttribute('value')).toBe('5000000');
  expect(center.getByText('25%')).toBeTruthy();

  api.centerList.mockResolvedValueOnce({ ...catalog, installProgress: { revision: 1, active: [] } });
  await act(async () => { fireEvent.click(center.getByRole('button', { name: '刷新' })); });
  expect(center.getByRole('progressbar').getAttribute('value')).toBe('5000000');

  fireEvent.click(center.getByRole('button', { name: '查看扩展详情 歸藏设计' }));
  const detail = within(center.getByRole('article', { name: '歸藏设计' }));
  expect(detail.getByRole('progressbar').getAttribute('max')).toBe('20000000');
  act(() => emitProgress({ revision: 3, active: [{ packageKey, progress: { phase: 'verifying' } }] }));
  expect(detail.getByText('正在校验安装包')).toBeTruthy();
  expect(detail.queryByRole('progressbar')).toBeNull();
  act(() => emitProgress({ revision: 4, active: [{ packageKey, progress: { phase: 'installing' } }] }));
  expect(detail.getByText('正在安装扩展')).toBeTruthy();

  await act(async () => {
    emitProgress({ revision: 5, active: [] });
    installing.resolve({ packageKey, extensionId: 'guizang-design', installed: false, skipped: false, error: '安装包校验失败，请重试' });
  });
  expect(detail.getByText('安装包校验失败，请重试')).toBeTruthy();
  fireEvent.click(detail.getByRole('button', { name: '返回扩展中心' }));
  api.centerInstall.mockImplementationOnce(async () => {
    api.centerList.mockResolvedValue({ ...catalog, releases: catalog.releases.map(release => ({ ...release, installed: true, installedVersion: release.version })) });
    return { packageKey, extensionId: 'guizang-design', installed: true, skipped: false };
  });
  await act(async () => { fireEvent.click(center.getByRole('button', { name: '重试' })); });
  expect(api.centerInstall).toHaveBeenCalledTimes(2);
  expect(center.getByRole<HTMLButtonElement>('button', { name: '已安装' }).disabled).toBe(true);
});
