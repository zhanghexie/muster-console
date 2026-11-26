import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ExtensionsManager } from '../../src/renderer/src/panels/ExtensionsManager';

beforeEach(() => dismissTip());

it('uses one tab row and groups global extensions by their install source', () => {
  const entry = { workspaceId: 'ws', directory: '/extensions', status: 'installed' as const };
  const onCenterOpen = vi.fn();
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目甲" onCenterOpen={onCenterOpen}
    listing={{
      global: [{ ...entry, id: 'downloaded-package', sourceKind: 'center' }, { ...entry, id: 'local-package', sourceKind: 'local' }, { ...entry, id: 'daily-report', bundled: true }],
      project: [{ ...entry, id: 'project-package' }], problems: [], issues: [],
    }} setEnabled={async () => {}} />);

  const tablist = screen.getByRole('tablist', { name: '扩展管理' });
  expect(screen.getAllByRole('tablist')).toEqual([tablist]);
  const [global, project, center] = within(tablist).getAllByRole('tab');
  expect(global.textContent).toMatch(/^全局扩展.*3$/);
  expect(project.textContent).toMatch(/^项目扩展.*1$/);
  expect(center.textContent).toBe('扩展中心');
  const downloaded = within(screen.getByRole('heading', { name: '下载的扩展' }).parentElement!);
  const local = within(screen.getByRole('heading', { name: '本地扩展' }).parentElement!);
  expect(downloaded.getByText('downloaded-package')).toBeTruthy();
  expect(downloaded.queryByText('local-package')).toBeNull();
  expect(local.getByText('daily-report')).toBeTruthy();
  expect(local.getByText('local-package')).toBeTruthy();
  expect(within(screen.getByRole('tabpanel', { name: /^全局扩展/ })).queryByText('当前项目：项目甲')).toBeNull();

  act(() => global.focus());
  fireEvent.keyDown(global, { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(center);
  expect(global.getAttribute('aria-selected')).toBe('true');
  expect(onCenterOpen).not.toHaveBeenCalled();
  fireEvent.keyDown(center, { key: 'Home' });
  expect(document.activeElement).toBe(global);
  fireEvent.click(project);
  expect(screen.getByText('当前项目：项目甲')).toBeTruthy();
  const projectPanel = screen.getByRole('tabpanel', { name: /^项目扩展/ });
  expect(within(projectPanel).getByText('project-package')).toBeTruthy();
  expect(screen.getAllByRole('tabpanel')).toEqual([projectPanel]);
  fireEvent.click(center);
  expect(onCenterOpen).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('tabpanel', { name: '扩展中心' })).toBeTruthy();
});

it('shows the global package once with its current review decision and source details', () => {
  const directory = 'C:/user/extensions/global/bookshelf';
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目"
    listing={{ global: [{ id: 'bookshelf', workspaceId: 'ws', directory, fingerprint: 'package-extension:abc', status: 'rejected', reason: 'fixture review decision' }], project: [], problems: [], issues: [] }}
    setEnabled={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /bookshelf.*审核未通过/ }));
  expect(screen.getAllByText(directory)).toHaveLength(1);
  expect(screen.getByText('package-extension:abc')).toBeTruthy();
  expect(screen.queryByText(/fixture review decision/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
  expect(getTipSnapshot()?.text).toBe('fixture review decision');
});

it('offers a global workspace-wide activation action', async () => {
  const setEnabledAll = vi.fn(async () => {});
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目"
    listing={{ global: [{ id: 'bookshelf', workspaceId: 'ws', directory: '/extensions/bookshelf', status: 'approved', enabled: false, fingerprint: 'package-extension:abc' }], project: [], problems: [], issues: [] }}
    setEnabled={async () => {}} setEnabledAll={setEnabledAll} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '全部工作区启用 bookshelf' })); });
  expect(setEnabledAll).toHaveBeenCalledWith('bookshelf', true);
});

it('shows activation for installed packages and uninstalls only after confirmation', async () => {
  const uninstallGlobal = vi.fn(async () => {});
  const setEnabledAll = vi.fn(async () => {});
  const fingerprint = `package-extension:${'a'.repeat(64)}`;
  const entry = { workspaceId: 'ws', directory: '/extensions', fingerprint, status: 'installed' as const, enabled: false };
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目"
    listing={{ global: [{ ...entry, id: 'daily-report', bundled: true, enabled: true }, { ...entry, id: 'gomoku' }, { ...entry, id: 'library', enabledInAnyWorkspace: true }], project: [], problems: [], issues: [] }}
    setEnabled={async () => {}} setEnabledAll={setEnabledAll} uninstallGlobal={uninstallGlobal} />);
  expect(screen.getAllByText('已禁用')).toHaveLength(2);
  expect(screen.queryByText('待审核')).toBeNull();
  expect(screen.queryByRole('button', { name: '卸载 daily-report' })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '卸载 library' }).disabled).toBe(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '全部工作区关闭 library' })); });
  expect(setEnabledAll).toHaveBeenCalledWith('library', false);
  fireEvent.click(screen.getByRole('button', { name: '卸载 gomoku' }));
  const confirm = screen.getByRole('dialog', { name: '卸载「gomoku」？' });
  expect(uninstallGlobal).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '移到回收站' })); });
  expect(uninstallGlobal).toHaveBeenCalledWith('gomoku', fingerprint);
});

it('starts a local extension installation from the management page', async () => {
  const installLocal = vi.fn(async () => ({ extensionId: 'local-bookshelf' }));
  const onRefresh = vi.fn();
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目"
    listing={{ global: [], project: [], problems: [], issues: [] }} setEnabled={async () => {}} installLocal={installLocal} onRefresh={onRefresh} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '安装本地扩展' })); });
  expect(installLocal).toHaveBeenCalledTimes(1);
  expect(onRefresh).not.toHaveBeenCalled();
});

it('browses the local extension center and installs a release', async () => {
  const installCenter = vi.fn(async () => {});
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目"
    listing={{ global: [], project: [], problems: [], issues: [] }} setEnabled={async () => {}}
    centerCatalog={{ source: 'file', releases: [{ packageKey: 'muster/bookshelf', publisherId: 'muster', extensionId: 'bookshelf', name: '图书馆', version: '1.2.0', fingerprint: 'abc', sourceKind: 'center', installed: false }] }}
    installCenter={installCenter} />);
  fireEvent.click(screen.getByRole('tab', { name: '扩展中心' }));
  expect(screen.getByText('本地扩展目录')).toBeTruthy();
  expect(screen.getByText('图书馆')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '安装' })); });
  expect(installCenter).toHaveBeenCalledWith('muster/bookshelf');
});

it('offers an update when the center has a newer release', async () => {
  const installCenter = vi.fn(async () => {});
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目"
    listing={{ global: [], project: [], problems: [], issues: [] }} setEnabled={async () => {}}
    centerCatalog={{ source: 'github', releases: [{ packageKey: 'muster/bookshelf', publisherId: 'muster', extensionId: 'bookshelf', name: '图书馆', version: '1.3.0', installedVersion: '1.2.0', fingerprint: 'next', sourceKind: 'center', installed: true }] }}
    installCenter={installCenter} />);
  fireEvent.click(screen.getByRole('tab', { name: '扩展中心' }));
  expect(screen.getByText('有更新')).toBeTruthy();
  expect(screen.getByText(/当前版本 v1\.2\.0/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新' })); });
  expect(installCenter).toHaveBeenCalledWith('muster/bookshelf');
});

it('offers uninstall for an installed center release', async () => {
  const uninstallCenter = vi.fn(async () => {});
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目"
    listing={{ global: [], project: [], problems: [], issues: [] }} setEnabled={async () => {}}
    centerCatalog={{ source: 'github', releases: [{ packageKey: 'muster/bookshelf', publisherId: 'muster', extensionId: 'bookshelf', name: '图书馆', version: '1.2.0', installedVersion: '1.2.0', fingerprint: 'next', sourceKind: 'center', installed: true }] }}
    installCenter={async () => {}} uninstallCenter={uninstallCenter} />);
  fireEvent.click(screen.getByRole('tab', { name: '扩展中心' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '卸载' })); });
  expect(uninstallCenter).toHaveBeenCalledWith('muster/bookshelf');
});

it('opens a VS Code style center detail view and returns to the catalog', async () => {
  render(<ExtensionsManager workspaceId="ws" sourceRootId="root" projectLabel="项目"
    listing={{ global: [], project: [], problems: [], issues: [] }} setEnabled={async () => {}}
    centerCatalog={{ source: 'github', releases: [{ packageKey: 'muster/bookshelf', publisherId: 'muster', publisherName: 'Muster', extensionId: 'bookshelf', name: '图书馆', version: '1.2.0', fingerprint: 'package-extension:abc', sha256: 'a'.repeat(64), sourceKind: 'center', installed: false, description: '本地阅读器', category: 'reading', releaseNotes: '首发版本', readme: '# 图书馆\n\n阅读本地书籍。' }] }}
    installCenter={async () => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: '扩展中心' }));
  expect(screen.getByText('GitHub 扩展中心')).toBeTruthy();
  expect(screen.getByRole('heading', { name: '阅读' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '查看扩展详情 图书馆' }));
  expect(screen.getByRole('article', { name: '图书馆' })).toBeTruthy();
  expect(screen.getAllByText('GitHub 扩展中心')).toHaveLength(2);
  expect(screen.getByText('package-extension:abc')).toBeTruthy();
  expect(screen.getByText('首发版本')).toBeTruthy();
  expect(screen.getByText(/# 图书馆/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回扩展中心' }));
  expect(screen.getByRole('button', { name: '查看扩展详情 图书馆' })).toBeTruthy();
});
