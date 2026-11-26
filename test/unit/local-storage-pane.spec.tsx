import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocalStoragePane } from '../../src/renderer/src/components/settings/LocalStoragePane';
import { SettingsContent } from '../../src/renderer/src/components/settings/SettingsContent';
import { applyLocaleSetting } from '../../src/shared/i18n';
import type { LocalStorageSnapshot } from '../../src/shared/localStorage';
import { MAX_LOCAL_STORAGE_SELECTION } from '../../src/shared/localStorage';
import { currentApiMock } from './helpers/api-mock';

beforeEach(() => dismissTip());

const snapshot: LocalStorageSnapshot = { id: 'scan-1', partial: false, workspaces: [{ id: 'ws', name: 'Workspace' }], items: [
  { id: 's', category: 'sessions', name: 'Archived chat', sessionId: 's1', workspaceId: 'ws', paths: ['C:/data/s.json'], bytes: 4096, partial: false, action: 'session' },
  { id: 'a', category: 'attachments', name: 'Archived chat', sessionId: 's1', workspaceId: 'ws', paths: ['C:/data/a'], bytes: 2048, partial: false, action: 'attachment' },
  { id: 'w', category: 'worktrees', name: 'Active task', workspaceId: 'ws', paths: ['C:/tree'], bytes: 8192, partial: false, reason: 'worktree' },
  { id: 'm', category: 'worktrees', name: 'Missing task', workspaceId: 'ws', paths: ['C:/missing'], pathStatuses: [{ path: 'C:/missing', status: 'missing' }], bytes: null, partial: false, action: 'worktree' },
  { id: 'p', category: 'apps', name: 'Custom app', workspaceId: 'ws', paths: [], bytes: null, partial: false, action: 'app' },
  { id: 'extension', category: 'extensions', name: 'extension', workspaceId: 'ws', paths: [], bytes: null, partial: false, reason: 'shared' },
  { id: 'shared', category: 'other', name: 'config.json', paths: ['C:/data/config.json'], bytes: 128, partial: false, reason: 'shared' }
] };
function mount() {
  const api = currentApiMock();
  let chosen: Array<{ id: string }> = [];
  api.override('localStorage.scan', () => Promise.resolve(structuredClone(snapshot)));
  api.override('localStorage.startCleanup', (_id, selection) => { chosen = selection; return Promise.resolve({ id: 'job-1' }); });
  api.override('localStorage.cleanupStatus', () => Promise.resolve({ id: 'job-1', total: chosen.length, done: true, results: chosen.map(item => ({ id: item.id, status: item.id === 's' ? 'started' : 'completed' })) }));
  render(<div className="settings-page"><SettingsContent><LocalStoragePane /></SettingsContent></div>);
  return api;
}
async function beginScan(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '开始扫描' }));
  await screen.findByRole('navigation', { name: '存储类别' });
}
afterEach(() => act(() => applyLocaleSetting('zh-CN')));

it('waits for an explicit scan and shows the brand loader only while scanning', async () => {
  const api = mount(), user = userEvent.setup();
  let finish!: (value: LocalStorageSnapshot) => void;
  api.override('localStorage.scan', () => new Promise<LocalStorageSnapshot>(resolve => { finish = resolve; }));
  expect(api.mockOf('localStorage.scan')).not.toHaveBeenCalled();
  expect(screen.getByText('尚未扫描')).toBeTruthy();
  expect((screen.getByRole('button', { name: '选择存储范围' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: '开始扫描' }));
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
  const status = screen.getByText('正在扫描本机存储…').closest('[role="status"]');
  expect(status?.querySelector('svg.brand-loader .brand-loader-orbit')).toBeTruthy();
  expect((screen.getByRole('button', { name: '重新扫描' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish(structuredClone(snapshot)));
  expect(await screen.findByRole('navigation', { name: '存储类别' })).toBeTruthy();
  expect(screen.queryByText('正在扫描本机存储…')).toBeNull();
  expect(document.querySelector('.local-storage .brand-loader')).toBeNull();
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(2);
  await act(async () => finish(structuredClone(snapshot)));
});

it('shows a scan failure and retries only after another user action', async () => {
  const api = mount(), user = userEvent.setup();
  api.mockOf('localStorage.scan').mockRejectedValueOnce(new Error('scan failed')).mockResolvedValueOnce(structuredClone(snapshot));
  await user.click(screen.getByRole('button', { name: '开始扫描' }));
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('scan failed'));
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.local-storage .brand-loader')).toBeNull();
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  expect(await screen.findByRole('navigation', { name: '存储类别' })).toBeTruthy();
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(2);
});

it('keeps partial sizes visible without adding overview notices above the list', async () => {
  const api = mount(), user = userEvent.setup();
  const partialSnapshot = structuredClone(snapshot);
  partialSnapshot.partial = true;
  partialSnapshot.items.find(item => item.id === 'w')!.partial = true;
  api.override('localStorage.scan', async () => partialSnapshot);
  await beginScan(user);
  expect(document.querySelector('.local-storage-notices')).toBeNull();
  expect(document.querySelector('.local-storage-summary strong')?.textContent).toContain('≥');
  await user.click(screen.getByRole('button', { name: /Active task/ }));
  expect(screen.getByText('此项目的大小未完整统计。')).toBeTruthy();
  expect(screen.queryByText(/显示文件逻辑大小/)).toBeNull();
  expect(screen.queryByText(/部分项目未能完整统计/)).toBeNull();
});

it('shows missing worktrees as reviewable records with the explanation next to the selected item', async () => {
  const api = mount(), user = userEvent.setup();
  await beginScan(user);
  const row = await screen.findByRole('button', { name: /Missing task/ });
  expect(row.textContent).toContain('目录不存在');
  expect(screen.getByRole('button', { name: /Active task/ }).textContent).toContain('涉及任务 worktree');
  await user.click(row);
  const details = row.parentElement?.nextElementSibling?.querySelector('.local-storage-inspection') as HTMLElement;
  expect(details).toBeTruthy();
  expect((within(details).getByDisplayValue('C:/missing') as HTMLInputElement).readOnly).toBe(true);
  expect(within(details).getByText('目录不存在')).toBeTruthy();
  expect(within(details).queryByRole('button', { name: '打开位置' })).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: '选择 Missing task' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/重新检查 Git 登记和任务分支/)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(api.mockOf('localStorage.startCleanup')).toHaveBeenCalledWith('scan-1', [{ id: 'm', deleteAppData: false }]));
});

it('shows a reveal failure beside the specific item and retains it until a rescan', async () => {
  const api = mount(), user = userEvent.setup();
  api.override('shell.revealPath', async () => ({ ok: false, error: '路径不存在' }));
  await beginScan(user);
  await user.click(await screen.findByRole('button', { name: /Active task/ }));
  const details = document.querySelector<HTMLElement>('.local-storage-inspection')!;
  expect((within(details).getByDisplayValue('C:/tree') as HTMLInputElement).readOnly).toBe(true);
  await user.click(within(details).getByRole('button', { name: '打开位置' }));
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('路径不存在'));
  expect(details.textContent).not.toContain('路径不存在');
  expect(document.querySelector('.local-storage-notices [role="alert"]')).toBeNull();
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  await screen.findByRole('navigation', { name: '存储类别' });
  expect(document.querySelector('.local-storage-inspection [role="alert"]')).toBeNull();
});

it('reviews a selected conversation before starting cleanup and reports the asynchronous result', async () => {
  const api = mount(), user = userEvent.setup();
  await beginScan(user);
  await screen.findByRole('button', { name: /^会话/ });
  expect((screen.getByRole('checkbox', { name: '选择 Active task' }) as HTMLInputElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: /^会话/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Archived chat' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.closest('.local-storage-confirm-mask')).toBeTruthy();
  expect(within(dialog).getByText(/永久删除会话记录/)).toBeTruthy();
  expect(api.mockOf('localStorage.startCleanup')).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(api.mockOf('localStorage.startCleanup')).toHaveBeenCalledWith('scan-1', [{ id: 's', deleteAppData: false }]));
  expect(await screen.findByText('已发起 1 项')).toBeTruthy();
  expect(screen.getByRole('navigation', { name: '存储类别' })).toBeTruthy();
  expect((screen.getByRole('checkbox', { name: '选择 Archived chat' }) as HTMLInputElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: /^聊天附件/ }));
  expect((screen.getByRole('checkbox', { name: '选择 Archived chat' }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/关联清理正在后台进行/)).toBeTruthy();
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
  api.mockOf('localStorage.scan').mockRejectedValueOnce(new Error('scan failed'));
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('scan failed'));
  expect(screen.getByText('已发起 1 项')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  await screen.findByRole('navigation', { name: '存储类别' });
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(3);
  expect(screen.queryByText('已发起 1 项')).toBeNull();
});

it('queues Other data without removing its bytes and restarts only on request', async () => {
  const api = mount(), user = userEvent.setup();
  const scanned = structuredClone(snapshot);
  const label = '工作台网页和图形缓存';
  scanned.items.push({ id: 'cache', category: 'other', name: label, maintenanceId: 'chromiumCache', bytes: 1024 ** 2,
    paths: ['C:/data/Cache', 'C:/data/GPUCache'], partial: false, action: 'startupCleanup' });
  api.override('localStorage.scan', async () => structuredClone(scanned));
  api.override('localStorage.cleanupStatus', async () => ({ id: 'job-1', total: 1, done: true, results: [{ id: 'cache', status: 'scheduled' }] }));
  await beginScan(user);
  await user.click(within(screen.getByRole('navigation', { name: '存储类别' })).getByRole('button', { name: /^其他数据/ }));
  const sizeBefore = document.querySelector('.local-storage-summary strong')?.textContent;
  const choice = screen.getByRole('checkbox', { name: `选择 ${label}` }) as HTMLInputElement;
  await user.click(choice);
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('下次启动时清理');
  expect(dialog.textContent).toContain('下次使用时按需重建');
  await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
  expect(await screen.findByText('1 项等待重启清理')).toBeTruthy();
  expect(api.mockOf('localStorage.startCleanup')).toHaveBeenCalledWith('scan-1', [{ id: 'cache', deleteAppData: false }]);
  expect(choice.disabled).toBe(true);
  expect(document.querySelector('.local-storage-summary strong')?.textContent).toBe(sizeBefore);
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
  expect(api.mockOf('app.relaunch')).not.toHaveBeenCalled();

  const queued = scanned.items.find(item => item.id === 'cache')!;
  delete queued.action;
  queued.reason = 'restartPending';
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  expect((await screen.findByRole('checkbox', { name: `选择 ${label}` }) as HTMLInputElement).disabled).toBe(true);
  const restart = screen.getByRole('button', { name: '重启并清理' });
  api.mockOf('app.relaunch').mockRejectedValueOnce(new Error('restart failed'));
  await user.click(restart);
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('下次手动启动时仍会处理清理队列'));
  await user.click(restart);
  expect(api.mockOf('app.relaunch')).toHaveBeenCalledTimes(2);
});

it.each(['startCleanup', 'cleanupStatus'])('does not rescan automatically if %s fails', async stage => {
  const api = mount(), user = userEvent.setup();
  await beginScan(user);
  api.override(`localStorage.${stage}`, () => Promise.reject(new Error('connection lost')));
  await user.click(screen.getByRole('button', { name: /^会话/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Archived chat' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(getTipSnapshot()?.text).toContain(stage === 'cleanupStatus' ? '清理结果暂未确认' : 'connection lost'));
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('navigation', { name: '存储类别' })).toBeTruthy();
  expect((screen.getByRole('checkbox', { name: '选择 Archived chat' }) as HTMLInputElement).disabled).toBe(true);
});

it('retains the selected workspace scope across cleanup and the next manual scan', async () => {
  const api = mount(), user = userEvent.setup();
  await beginScan(user);
  await user.click(screen.getByRole('button', { name: '选择存储范围' }));
  await user.click(screen.getByRole('option', { name: 'Workspace' }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Missing task' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认清理' }));
  expect(await screen.findByText('已完成 1 项')).toBeTruthy();
  expect(screen.getByRole('button', { name: '选择存储范围' }).textContent).toContain('Workspace');
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '重新扫描' }));
  await screen.findByRole('navigation', { name: '存储类别' });
  expect(screen.getByRole('button', { name: '选择存储范围' }).textContent).toContain('Workspace');
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(2);
});

it('returns the detail pane to the top when changing category or scope', async () => {
  mount(); const user = userEvent.setup();
  await beginScan(user);
  await screen.findByRole('button', { name: /^会话/ });
  const detail = () => document.querySelector<HTMLElement>('.local-storage-detail')!;
  detail().scrollTop = 150;
  await user.click(screen.getByRole('button', { name: /^会话/ }));
  expect(detail().scrollTop).toBe(0);
  detail().scrollTop = 150;
  await user.click(screen.getByRole('button', { name: '选择存储范围' }));
  await user.click(screen.getByRole('option', { name: '跨工作区及未知归属' }));
  expect(detail().scrollTop).toBe(0);
});

it('includes an explicit app-data deletion choice in confirmation', async () => {
  const api = mount(), user = userEvent.setup();
  await beginScan(user);
  await user.click(await screen.findByRole('button', { name: /手机应用/ }));
  await user.click(screen.getByRole('button', { name: /Custom app/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Custom app' }));
  await user.click(screen.getByRole('checkbox', { name: '卸载时同时删除此工作区的应用数据' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/删除其业务记录/)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(api.mockOf('localStorage.startCleanup')).toHaveBeenCalledWith('scan-1', [{ id: 'p', deleteAppData: true }]));
});

it('keeps app data by default when uninstalling', async () => {
  const api = mount(), user = userEvent.setup();
  await beginScan(user);
  await user.click(await screen.findByRole('button', { name: /手机应用/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Custom app' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/保留业务数据/)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(api.mockOf('localStorage.startCleanup')).toHaveBeenCalledWith('scan-1', [{ id: 'p', deleteAppData: false }]));
});

it('shows progress while a cleanup job is running', async () => {
  const api = mount(), user = userEvent.setup(); let reads = 0;
  api.override('localStorage.cleanupStatus', () => Promise.resolve(++reads === 1
    ? { id: 'job-1', total: 1, done: false, results: [] }
    : { id: 'job-1', total: 1, done: true, results: [{ id: 's', status: 'started' }] }));
  await beginScan(user);
  await user.click(await screen.findByRole('button', { name: /^会话/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Archived chat' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认清理' }));
  const progress = await screen.findByText('正在处理 0 / 1 项…');
  expect(progress.nextElementSibling?.classList.contains('local-storage-actions')).toBe(true);
  expect((screen.getByRole('button', { name: '检查清理影响' }) as HTMLButtonElement).disabled).toBe(true);
  expect(await screen.findByText('已发起 1 项')).toBeTruthy();
});

it('filters the measured proportions and clears selection when changing scope', async () => {
  mount(); const user = userEvent.setup();
  await beginScan(user);
  await user.click(await screen.findByRole('button', { name: /^会话/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Archived chat' }));
  const bar = document.querySelector('.local-storage-bar')!;
  expect(bar.children.length).toBe(4);
  screen.getByRole('button', { name: '选择存储范围' }).focus();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('listbox', { name: '选择存储范围' })).toBeTruthy();
  await user.keyboard('{ArrowDown}{Enter}');
  expect(bar.children.length).toBe(1);
  expect((screen.getByRole('button', { name: '检查清理影响' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('当前范围没有此类数据。')).toBeTruthy();
});

it('updates the page and confirmation in English without translating user names', async () => {
  mount(); const user = userEvent.setup();
  await beginScan(user);
  await screen.findByRole('button', { name: /^会话/ });
  act(() => applyLocaleSetting('en'));
  expect(screen.getByRole('searchbox', { name: 'Search storage items' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Filter storage items' }).textContent).toContain('All items');
  expect(screen.getByRole('button', { name: 'Sort storage items' }).textContent).toContain('Largest first');
  expect(screen.getByRole('checkbox', { name: 'Select all cleanable items in these results' })).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: /^Session/ }));
  await user.click(screen.getByRole('checkbox', { name: 'Select Archived chat' }));
  await user.click(screen.getByRole('button', { name: 'Review cleanup' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/Permanently delete the conversation/)).toBeTruthy();
  expect(within(dialog).getByText(/Archived chat/)).toBeTruthy();
});

it('preserves an extension name even when it matches a managed folder name', async () => {
  mount(); const user = userEvent.setup();
  await beginScan(user);
  await screen.findByRole('button', { name: /扩展/ });
  act(() => applyLocaleSetting('en'));
  await user.click(await screen.findByRole('button', { name: /Extension/ }));
  expect(screen.getByRole('button', { name: /extension/ })).toBeTruthy();
});

it('filters, searches and sorts a category while selecting only matching cleanable items', async () => {
  const api = mount(), user = userEvent.setup(), items = structuredClone(snapshot);
  items.items.push(
    { id: 'alpha', category: 'sessions', name: 'Alpha', workspaceId: 'ws', paths: ['C:/alpha'], bytes: 10, partial: false, action: 'session' },
    { id: 'beta', category: 'sessions', name: 'Beta', workspaceId: 'ws', paths: ['C:/special-path/beta'], bytes: 9000, partial: false, action: 'session' },
    { id: 'blocked', category: 'sessions', name: 'Blocked', workspaceId: 'ws', paths: [], bytes: 10000, partial: false, reason: 'active' },
    { id: 'unknown', category: 'sessions', name: 'Unknown size', workspaceId: 'ws', paths: [], bytes: null, partial: false, action: 'session' }
  );
  api.override('localStorage.scan', async () => items);
  await beginScan(user);
  await user.click(screen.getByRole('checkbox', { name: '选择 Missing task' }));
  await user.click(screen.getByRole('button', { name: /^会话/ }));
  const rowNames = () => [...document.querySelectorAll('.local-storage-row-button')].map(row => row.textContent ?? '');
  expect(rowNames().map(value => value.split('Workspace')[0])).toEqual(['Blocked', 'Beta', 'Archived chat', 'Alpha', 'Unknown size']);

  await user.click(screen.getByRole('button', { name: '筛选存储项目' }));
  await user.click(screen.getByRole('option', { name: '仅可清理' }));
  expect(screen.queryByRole('checkbox', { name: '选择 Blocked' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '排序存储项目' }));
  await user.click(screen.getByRole('option', { name: '名称升序' }));
  expect(rowNames().map(value => value.split('Workspace')[0])).toEqual(['Alpha', 'Archived chat', 'Beta', 'Unknown size']);

  const search = screen.getByRole('searchbox', { name: '搜索存储项目' });
  await user.type(search, 'special-path');
  expect(rowNames()).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: '选择 Beta' })).toBeTruthy();
  await user.click(screen.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }));
  expect(screen.getByText(/已选择 2 项/)).toBeTruthy();
  await user.clear(search);
  expect((screen.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }) as HTMLInputElement).indeterminate).toBe(true);
  await user.click(screen.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }));
  expect(screen.getByText(/已选择 5 项/)).toBeTruthy();
  await user.click(screen.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }));
  expect(screen.getByText(/已选择 1 项/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^任务 worktree/ }));
  expect((screen.getByRole('checkbox', { name: '选择 Missing task' }) as HTMLInputElement).checked).toBe(true);
});

it('selects and submits more than 200 matching items, including rows beyond the first page', async () => {
  const api = mount(), user = userEvent.setup(), items = structuredClone(snapshot);
  for (let i = 0; i < 225; i++) items.items.push({ id: `bulk-${i}`, category: 'sessions', name: `Batch ${i}`, workspaceId: 'ws', paths: [], bytes: 1, partial: false, action: 'session' });
  api.override('localStorage.scan', async () => items);
  await beginScan(user);
  await user.click(screen.getByRole('button', { name: /^会话/ }));
  expect(screen.queryByRole('checkbox', { name: '选择 Batch 224' })).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }));
  expect(screen.getByText(/已选择 226 项/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/Batch 224/)).toBeTruthy();
  expect((dialog.querySelector('.confirm-detail')?.textContent?.match(/永久删除会话记录/g) ?? [])).toHaveLength(1);
  await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(api.mockOf('localStorage.startCleanup')).toHaveBeenCalled());
  const [, chosen] = api.mockOf('localStorage.startCleanup').mock.calls[0] as [string, Array<{ id: string }>];
  expect(chosen).toHaveLength(226);
  expect(chosen.some(item => item.id === 'bulk-224')).toBe(true);
});

it('bounds a bulk selection and allows clearing the selected portion at the limit', async () => {
  const api = mount(), user = userEvent.setup(), items = structuredClone(snapshot);
  for (let i = 0; i < MAX_LOCAL_STORAGE_SELECTION; i++) items.items.push({ id: `limit-${i}`, category: 'sessions', name: `Limit ${i}`, workspaceId: 'ws', paths: [], bytes: 1, partial: false, action: 'session' });
  api.override('localStorage.scan', async () => items);
  await beginScan(user);
  await user.click(screen.getByRole('button', { name: /^会话/ }));
  const selectAll = screen.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }) as HTMLInputElement;
  await user.click(selectAll);
  expect(screen.getByText('每次最多处理 1000 项。')).toBeTruthy();
  expect(screen.getByText(/已选择 1000 项/)).toBeTruthy();
  expect(selectAll.indeterminate).toBe(true);
  expect(selectAll.disabled).toBe(false);
  await user.click(selectAll);
  expect(screen.getByText('尚未选择项目')).toBeTruthy();
});

it('resets the app data deletion choice when the selection is cleared', async () => {
  mount(); const user = userEvent.setup();
  await beginScan(user);
  await user.click(screen.getByRole('button', { name: /手机应用/ }));
  await user.click(screen.getByRole('button', { name: /Custom app/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Custom app' }));
  const removeData = screen.getByRole('checkbox', { name: '卸载时同时删除此工作区的应用数据' }) as HTMLInputElement;
  await user.click(removeData);
  expect(removeData.checked).toBe(true);
  await user.click(screen.getByRole('button', { name: '清空选择' }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Custom app' }));
  expect(removeData.checked).toBe(false);
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  expect(within(screen.getByRole('dialog')).getByText(/保留业务数据/)).toBeTruthy();
});

it('keeps item details collapsed while selecting and opens them only on row activation', async () => {
  mount(); const user = userEvent.setup();
  await beginScan(user);
  expect(document.querySelector('.local-storage-inspection')).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: '选择 Missing task' }));
  expect(document.querySelector('.local-storage-inspection')).toBeNull();
  await user.click(screen.getByRole('button', { name: /Missing task/ }));
  expect(document.querySelector('.local-storage-inspection')).toBeTruthy();
  expect((screen.getByRole('checkbox', { name: '选择 Missing task' }) as HTMLInputElement).checked).toBe(true);
  const row = screen.getByRole('button', { name: /Missing task/ });
  expect(row.getAttribute('aria-expanded')).toBe('true');
  await user.click(row);
  expect(row.getAttribute('aria-expanded')).toBe('false');
  await user.click(row);
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('项目详情')).toBeTruthy();
  await user.click(row);
  expect(row.getAttribute('aria-expanded')).toBe('false');
  await waitFor(() => expect(document.querySelector('.local-storage-inspection')).toBeNull());
  expect((screen.getByRole('checkbox', { name: '选择 Missing task' }) as HTMLInputElement).checked).toBe(true);
});

it('keeps the remaining inventory usable after cleanup without rescanning', async () => {
  const api = mount(), user = userEvent.setup();
  await beginScan(user);
  await user.click(screen.getByRole('checkbox', { name: '选择 Missing task' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 Missing task' })).toBeNull());
  expect(screen.getByRole('navigation', { name: '存储类别' })).toBeTruthy();
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('请重新扫描以更新存储信息。')).toBeNull();
  await user.click(screen.getByRole('button', { name: /^手机应用/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Custom app' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(api.mockOf('localStorage.startCleanup')).toHaveBeenCalledTimes(2));
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
});

it('offers the shared worktree after the last other conversation has been deleted', async () => {
  const api = mount(), user = userEvent.setup(), value = structuredClone(snapshot);
  value.items.push({ id: 'other', name: 'Sharing chat', category: 'sessions', action: 'session', paths: [], bytes: null, partial: false, stopsSession: true });
  value.dependencies = [{ dependentId: 's', prerequisiteId: 'm' }, { dependentId: 'other', prerequisiteId: 'm' }];
  api.override('localStorage.scan', async () => value);
  api.override('localStorage.cleanupStatus', async () => ({
    id: 'job-1', total: 1, done: true, results: [{ id: 'other', status: 'started' }]
  }));
  await beginScan(user);
  await user.click(screen.getByRole('button', { name: /^会话/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Sharing chat' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  expect(within(screen.getByRole('dialog')).queryByText('建议一并清理')).toBeNull();
  expect(within(screen.getByRole('dialog')).getByText(/停止并永久删除会话/)).toBeTruthy();
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认清理' }));
  await screen.findByText('已发起 1 项');
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '选择 Sharing chat' }).disabled).toBe(true);
  await user.click(screen.getByRole('checkbox', { name: '选择 Archived chat' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByRole('button', { name: '取消' })).toBe(document.activeElement);
  const suggestion = dialog.getByRole<HTMLInputElement>('checkbox', { name: /同时清理 Missing task/ });
  expect(suggestion.checked).toBe(false);
  await user.click(suggestion);
  await user.click(dialog.getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(api.mockOf('localStorage.startCleanup')).toHaveBeenLastCalledWith('scan-1', [
    { id: 's', deleteAppData: false }, { id: 'm', deleteAppData: false }
  ]));
  expect(api.mockOf('localStorage.scan')).toHaveBeenCalledTimes(1);
});

it('includes every required session when deleting a worktree and sends only an explicit discard choice', async () => {
  const api = mount(), user = userEvent.setup(), value = structuredClone(snapshot);
  value.items.find(item => item.id === 'm')!.canDiscardWorktree = true;
  value.items.push({ id: 'other', name: 'Sharing chat', category: 'sessions', action: 'session', paths: [], bytes: null, partial: false });
  value.dependencies = [{ dependentId: 's', prerequisiteId: 'm' }, { dependentId: 'other', prerequisiteId: 'm' }];
  api.override('localStorage.scan', async () => value);
  await beginScan(user);
  await user.click(screen.getByRole('checkbox', { name: '选择 Missing task' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByRole('heading', { name: '必须一并清理' })).toBeTruthy();
  expect(dialog.getByText(/Sharing chat.*Archived chat/)).toBeTruthy();
  const options = dialog.getAllByRole<HTMLInputElement>('checkbox');
  expect(options).toHaveLength(1);
  expect(options[0].checked).toBe(false);
  await user.click(dialog.getByRole('checkbox', { name: /丢弃 Missing task/ }));
  await user.click(dialog.getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(api.mockOf('localStorage.startCleanup')).toHaveBeenCalledWith('scan-1', [
    { id: 'm', deleteAppData: false, discardWorktree: true }, { id: 'other', deleteAppData: false }, { id: 's', deleteAppData: false }
  ]));
});

it('shows zero for an empty category and identifies shared logical storage', async () => {
  const api = mount(), user = userEvent.setup(), value = structuredClone(snapshot);
  Object.assign(value.items.find(item => item.id === 'p')!, { sizeKind: 'shared' });
  api.override('localStorage.scan', async () => value);
  await beginScan(user);
  expect(screen.getByRole('button', { name: /^浏览器/ }).textContent).toContain('0 B');
  await user.click(screen.getByRole('button', { name: /^手机应用/ }));
  expect(screen.getByRole('button', { name: /Custom app/ }).textContent).toContain('共享存储');
});

it('shows zero measured bytes when every worktree directory is known to be missing', async () => {
  const api = mount(), user = userEvent.setup(), value = structuredClone(snapshot);
  value.items = value.items.filter(item => item.id !== 'w');
  api.override('localStorage.scan', async () => value);
  await beginScan(user);
  expect(screen.getByRole('button', { name: /^任务 worktree/ }).textContent).toContain('0 B');
  expect(screen.getByRole('button', { name: /Missing task/ }).textContent).toContain('目录不存在');
});

it('summarizes batch results and shows failed items first', async () => {
  const api = mount(), user = userEvent.setup();
  api.override('localStorage.cleanupStatus', async () => ({ id: 'job-1', total: 2, done: true, results: [
    { id: 's', status: 'started' }, { id: 'm', status: 'failed', error: 'tree busy' }
  ] }));
  await beginScan(user);
  await user.click(screen.getByRole('checkbox', { name: '选择 Missing task' }));
  await user.click(screen.getByRole('button', { name: /^会话/ }));
  await user.click(screen.getByRole('checkbox', { name: '选择 Archived chat' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认清理' }));
  await screen.findByText(/未完成 1 项/);
  const results = document.querySelector('.local-storage-results')!;
  expect(results.textContent).toContain('已发起 1 项');
  expect(results.textContent).toContain('未完成 1 项');
  expect(document.querySelector('.local-storage-result-list')).toBeNull();
  await user.click(screen.getByRole('button', { name: '查看未完成项目' }));
  expect(document.querySelector('.local-storage-result-list')?.textContent).toContain('Missing task');
  const list = document.querySelector<HTMLElement>('.local-storage-result-list')!;
  expect(list.textContent).not.toContain('tree busy');
  await user.click(within(list).getByRole('button', { name: '查看详情' }));
  expect(getTipSnapshot()?.text).toBe('tree busy');
});


it('shows browser source, last update and irreversible cross-workspace impact before cleaning', async () => {
  const api = mount(), user = userEvent.setup();
  const data = structuredClone(snapshot);
  data.items.push({ id: 'browser', category: 'browser', name: 'browser-site-data', paths: ['C:/data/Partitions/browser'], bytes: 1024, partial: false, modifiedAt: 1700000000000, action: 'browserData' });
  api.override('localStorage.scan', async () => data);
  await beginScan(user);
  await user.click(screen.getByRole('button', { name: /^浏览器/ }));
  await user.click(screen.getByRole('button', { name: /浏览器站点数据/ }));
  expect(screen.getByText(/来源：内置浏览器/)).toBeTruthy();
  expect(screen.getByText(/最近观测更新：/).textContent).not.toContain('未知');
  await user.click(screen.getByRole('checkbox', { name: '选择 浏览器站点数据' }));
  await user.click(screen.getByRole('button', { name: '检查清理影响' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/高风险.*不可恢复.*Cookie/)).toBeTruthy();
  expect(api.mockOf('localStorage.startCleanup')).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
  await waitFor(() => expect(api.mockOf('localStorage.startCleanup')).toHaveBeenCalledWith('scan-1', [{ id: 'browser', deleteAppData: false }]));
});

it('explains that browser downloads without a verified receipt cannot be cleaned', async () => {
  const api = mount(), user = userEvent.setup();
  const data = structuredClone(snapshot);
  data.items.push({ id: 'unknown-download', category: 'browser', name: 'old-file.txt', paths: ['C:/data/browser-downloads/old-file.txt'], bytes: 10, partial: false, reason: 'unknownDownload' });
  api.override('localStorage.scan', async () => data);
  await beginScan(user);
  await user.click(screen.getByRole('button', { name: /^浏览器/ }));
  expect(screen.getByRole('button', { name: /old-file.txt/ }).textContent).toContain('下载来源或完成记录未知，不可清理。');
  expect((screen.getByRole('checkbox', { name: '选择 old-file.txt' }) as HTMLInputElement).disabled).toBe(true);
});
