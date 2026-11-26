import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageInventory, measureStorage, type StorageInventoryDependencies } from '../../../src/main/storage/inventory';
import { BrowserDownloadStore } from '../../../src/main/browser/downloadStore';
import type { SessionMeta } from '../../../src/shared/types';
import type { AppSnapshot } from '../../../src/shared/agentApps';
import { MAX_LOCAL_STORAGE_SELECTION } from '../../../src/shared/localStorage';
import { planLocalStorageCleanup } from '../../../src/shared/localStoragePlan';
import { StartupStorageMaintenance } from '../../../src/main/storage/startupMaintenance';

const roots: string[] = [];
const sid = '11111111-1111-4111-8111-111111111111';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metaagent-storage-test-')); roots.push(root);
  const userData = path.join(root, 'userdata'); fs.mkdirSync(userData);
  const write = (relative: string, content: string) => { const file = path.join(userData, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const rows: SessionMeta[] = [{ id: sid, type: 'terminal', name: 'Saved chat', createdAt: 1, workspaceId: 'ws', archived: true, status: 'exited' }];
  const app = { definition: { id: 'custom-app', name: 'Custom app', version: 1 }, enabled: true, installedAt: 1 };
  let apps = { workspaceId: 'ws', apps: [app], operations: [], connections: [], errors: [] } as unknown as AppSnapshot;
  write(`agent-sessions/${sid}.json`, '12345');
  write(`agent-sessions/${sid}/ui/widget.html`, '123');
  write(`conversation-attachments/${hash(`gui:${sid}`).slice(0, 20)}/a.txt`, '1234567');
  write(`session-handovers/${sid}/history.md`, '1234');
  write('themes/custom.json', '123456');
  write(`agent-apps/${hash('ws')}.sqlite`, '123456789');
  const removeSession = vi.fn(async (_id: string) => {}), cleanupWorktree = vi.fn(async () => ({ ok: true })), clearAttachments = vi.fn(), removeHandover = vi.fn(async () => {}), uninstallApp = vi.fn(async () => ({})), removeTheme = vi.fn(() => ({ ok: true }));
  const deps: StorageInventoryDependencies = {
    userData, workspaces: () => [{ id: 'ws', name: 'Workspace' }], sessions: () => structuredClone(rows),
    themes: () => [{ id: 'custom', name: 'Custom theme', appearance: 'dark', builtin: false, preview: { bg: '', ink: '', accent: '' } }], extensions: () => [{ id: 'ext', name: 'My extension' }],
    apps: async () => structuredClone(apps), builtinAppIds: new Set(['builtin']), removeSession, cleanupWorktree, clearAttachments, removeHandover, uninstallApp, removeTheme
  };
  return { root, userData, write, rows, app, deps, setApps: (next: AppSnapshot) => { apps = next; }, removeSession, cleanupWorktree, clearAttachments, removeHandover, uninstallApp, removeTheme, service: new StorageInventory(deps) };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('attributes known session files without counting shared app data as app-specific bytes', async () => {
  const f = fixture();
  f.write(`agent-session-events/${sid}.ndjson`, 'events');
  f.write(`agent-sessions/${sid}.json.ranges`, 'ranges');
  const snapshot = await f.service.scan();
  const session = snapshot.items.find(item => item.category === 'sessions' && item.sessionId === sid)!;
  const attachment = snapshot.items.find(item => item.category === 'attachments')!;
  const handover = snapshot.items.find(item => item.category === 'handovers')!;
  const app = snapshot.items.find(item => item.name === 'Custom app')!;
  expect(session).toMatchObject({ bytes: 20, action: 'session', workspaceId: 'ws' });
  expect(attachment).toMatchObject({ bytes: 7, action: 'attachment', sessionId: sid });
  expect(handover).toMatchObject({ bytes: 4, action: 'handover', sessionId: sid });
  expect(app).toMatchObject({ bytes: null, action: 'app' });
  expect(snapshot.items.find(item => item.name === 'agent-apps')?.bytes).toBe(9);
  expect(snapshot.items.find(item => item.name === 'My extension')).toMatchObject({ category: 'extensions', bytes: null, workspaceId: 'ws', reason: 'shared' });
});

it('attributes app database, WAL and image files to their workspace without double counting', async () => {
  const f = fixture();
  f.write(`agent-apps/${hash('ws')}.sqlite-wal`, '12');
  f.write(`agent-apps/${hash('ws')}.sqlite-shm`, '345');
  f.write(`agent-app-assets/${hash('ws')}/asset/original`, '6789');
  f.write('agent-apps/unowned.sqlite', 'abcde');
  const snapshot = await f.service.scan();
  const files = snapshot.items.filter(item => item.category === 'apps' && item.paths.length);
  expect(files.find(item => item.name === 'agent-apps' && item.workspaceId === 'ws')).toMatchObject({ bytes: 14, reason: 'shared' });
  expect(files.find(item => item.name === 'agent-app-assets' && item.workspaceId === 'ws')).toMatchObject({ bytes: 4, reason: 'shared' });
  expect(files.find(item => item.name === 'agent-apps' && !item.workspaceId)).toMatchObject({ bytes: 5, reason: 'shared' });
  expect(files.reduce((sum, item) => sum + (item.bytes ?? 0), 0)).toBe(23);
  expect(snapshot.items.find(item => item.name === 'Custom app')).toMatchObject({ bytes: null, sizeKind: 'shared' });
  expect(snapshot.items.find(item => item.name === 'My extension')).toMatchObject({ bytes: null, sizeKind: 'shared' });
});

it('attributes extension workspace data while counting global and unowned data only once', async () => {
  const f = fixture();
  f.write('extension/registry.json', '12');
  f.write(`extension/data/workspaces/${hash('ws')}/global/ext/settings.json`, '12345');
  f.write('extension/data/shared/global/ext/settings.json', '123');
  f.write('extension/data/workspaces/unowned/global/ext/settings.json', '1234');
  const snapshot = await f.service.scan();
  const files = snapshot.items.filter(item => item.category === 'extensions' && item.paths.length);
  expect(files.find(item => item.workspaceId === 'ws')).toMatchObject({ bytes: 5, reason: 'shared' });
  expect(files.find(item => !item.workspaceId)).toMatchObject({ bytes: 9, reason: 'shared' });
  expect(files.reduce((sum, item) => sum + (item.bytes ?? 0), 0)).toBe(14);
});

it('does not follow a redirected extension workspace data directory', async () => {
  const f = fixture(), outside = path.join(f.root, 'outside-extension');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside bytes');
  const link = path.join(f.userData, 'extension', 'data', 'workspaces', hash('ws'));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const snapshot = await f.service.scan();
  expect(snapshot.items.find(item => item.category === 'extensions' && item.workspaceId === 'ws' && item.paths.length))
    .toMatchObject({ bytes: 0, partial: true, reason: 'shared' });
});

it('keeps unselected snapshot items usable after cleanup while consuming selected IDs once', async () => {
  const f = fixture(), snapshot = await f.service.scan();
  const theme = snapshot.items.find(item => item.action === 'theme')!;
  const app = snapshot.items.find(item => item.action === 'app')!;
  expect((await f.service.clean(snapshot.id, [{ id: theme.id }]))[0].status).toBe('completed');
  expect((await f.service.clean(snapshot.id, [{ id: app.id }]))[0].status).toBe('completed');
  expect((await f.service.clean(snapshot.id, [{ id: theme.id }]))[0].status).toBe('failed');
  expect(f.removeTheme).toHaveBeenCalledTimes(1);
  expect(f.uninstallApp).toHaveBeenCalledTimes(1);
});

it('requires every session referencing a worktree and keeps the worktree available after deleting just its owner', async () => {
  const f = fixture();
  const treePath = path.join(f.root, 'tree');
  fs.mkdirSync(treePath); f.rows[0].worktreePath = treePath;
  f.rows.push({ id: 'borrower', type: 'terminal', name: 'Borrower', createdAt: 2, workspaceId: 'other', cwd: path.join(treePath, 'nested'), archived: true });
  f.removeSession.mockImplementation(async (id: string) => {
    if (id === sid) f.rows[0].retainedWorktreeOnly = true;
    else f.rows.splice(f.rows.findIndex(row => row.id === id), 1);
  });
  const snapshot = await f.service.scan();
  const tree = snapshot.items.find(item => item.action === 'worktree')!;
  const owner = snapshot.items.find(item => item.category === 'sessions' && item.sessionId === sid)!;
  const borrower = snapshot.items.find(item => item.category === 'sessions' && item.sessionId === 'borrower')!;
  expect(snapshot.dependencies).toEqual(expect.arrayContaining([
    { dependentId: owner.id, prerequisiteId: tree.id },
    { dependentId: borrower.id, prerequisiteId: tree.id }
  ]));
  expect(planLocalStorageCleanup(snapshot.items, snapshot.dependencies!, [owner.id]).recommended).toEqual([]);
  await expect(f.service.clean(snapshot.id, [{ id: tree.id }])).rejects.toThrow('缺少必删项目');
  expect((await f.service.clean(snapshot.id, [{ id: owner.id }]))[0].status).toBe('started');
  expect(f.cleanupWorktree).not.toHaveBeenCalled();
  expect((await f.service.clean(snapshot.id, [{ id: tree.id }, { id: borrower.id }])).map(result => result.status)).toEqual(['started', 'completed']);
  expect(f.removeSession.mock.calls.flat()).toEqual([sid, 'borrower']);
  expect(f.cleanupWorktree).toHaveBeenCalledWith(sid, false);
});

it('blocks the whole worktree deletion when a required owner has unavailable storage', async () => {
  const f = fixture(), outside = path.join(f.root, 'outside-session');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.userData, 'agent-sessions', sid, 'ui', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  f.rows[0].worktreePath = path.join(f.root, 'tree'); fs.mkdirSync(f.rows[0].worktreePath);
  f.cleanupWorktree.mockImplementation(async () => { delete f.rows[0].worktreePath; return { ok: true }; });
  const snapshot = await f.service.scan();
  const tree = snapshot.items.find(item => item.action === 'worktree')!;
  const session = snapshot.items.find(item => item.category === 'sessions' && item.sessionId === sid)!;
  expect(session).toMatchObject({ reason: 'unavailable', partial: true });
  const results = await f.service.clean(snapshot.id, [{ id: tree.id }, { id: session.id }]);
  expect(results.map(result => result.status)).toEqual(['failed', 'failed']);
  expect(f.removeSession).not.toHaveBeenCalled();
  expect(f.cleanupWorktree).not.toHaveBeenCalled();
});

it('rechecks cross-workspace resume paths added during preflight before deleting any conversation', async () => {
  const f = fixture(), treePath = path.join(f.root, 'tree');
  fs.mkdirSync(treePath); f.rows[0].worktreePath = treePath;
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(treePath, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.deps.preflightWorktree = async () => {
    f.rows.push({ id: 'late', type: 'terminal', name: 'Late user', createdAt: 2, workspaceId: 'other', archived: true, terminalResumeScope: { runtime: 'cli', cwd: alias } });
    return { ok: true };
  };
  const snapshot = await f.service.scan();
  const ids = snapshot.items.filter(item => item.action === 'worktree' || item.action === 'session').map(item => ({ id: item.id }));
  const result = await f.service.clean(snapshot.id, ids);
  expect(result).toHaveLength(2);
  expect(result.every(item => item.status === 'failed' && item.error?.includes('依赖已变化'))).toBe(true);
  expect(f.removeSession).not.toHaveBeenCalled();
  expect(f.cleanupWorktree).not.toHaveBeenCalled();
});

it('keeps a worktree when a selected dependent cannot be stopped', async () => {
  const f = fixture(), treePath = path.join(f.root, 'tree');
  fs.mkdirSync(treePath); f.rows[0].worktreePath = treePath;
  f.removeSession.mockRejectedValueOnce(new Error('runtime is still open'));
  const snapshot = await f.service.scan();
  const ids = snapshot.items.filter(item => item.action === 'worktree' || item.action === 'session').map(item => ({ id: item.id }));
  const result = await f.service.clean(snapshot.id, ids);
  expect(result).toEqual([
    { id: ids[0].id, status: 'failed', error: 'runtime is still open' },
    { id: ids[1].id, status: 'failed', error: '必删项目未能清理，已保留此项目。' }
  ]);
  expect(f.cleanupWorktree).not.toHaveBeenCalled();
});

it('invalidates related unselected assets after session deletion is started', async () => {
  const f = fixture(), snapshot = await f.service.scan();
  const session = snapshot.items.find(item => item.category === 'sessions' && item.sessionId === sid)!;
  const attachment = snapshot.items.find(item => item.category === 'attachments')!;
  expect((await f.service.clean(snapshot.id, [{ id: session.id }]))[0].status).toBe('started');
  expect((await f.service.clean(snapshot.id, [{ id: attachment.id }]))[0].status).toBe('failed');
  expect(f.clearAttachments).not.toHaveBeenCalled();
});

it('reserves an item before awaiting cleanup so overlapping calls cannot execute it twice', async () => {
  const f = fixture();
  f.rows[0].retainedWorktreeOnly = true;
  f.rows[0].worktreePath = path.join(f.root, 'tree'); fs.mkdirSync(f.rows[0].worktreePath);
  let finish!: () => void;
  f.cleanupWorktree.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
  const snapshot = await f.service.scan(), tree = snapshot.items.find(item => item.action === 'worktree')!;
  const first = f.service.clean(snapshot.id, [{ id: tree.id }]);
  await vi.waitFor(() => expect(f.cleanupWorktree).toHaveBeenCalledOnce());
  expect((await f.service.clean(snapshot.id, [{ id: tree.id }]))[0].status).toBe('failed');
  finish();
  expect((await first)[0].status).toBe('completed');
  expect(f.cleanupWorktree).toHaveBeenCalledOnce();
});

it('lists transitive descendant dependencies and stops live conversations when confirmed', async () => {
  const f = fixture();
  f.rows.push({ id: 'child', type: 'terminal', name: 'Child', parentSessionId: sid, createdAt: 2, workspaceId: 'ws', status: 'running' });
  f.rows.push({ id: 'grandchild', type: 'terminal', name: 'Grandchild', parentSessionId: 'child', createdAt: 3, workspaceId: 'ws', archived: true });
  const snapshot = await f.service.scan();
  const all = snapshot.items.filter(item => item.action === 'session');
  const parent = all.find(item => item.sessionId === sid)!;
  const child = all.find(item => item.sessionId === 'child')!;
  const grandchild = all.find(item => item.sessionId === 'grandchild')!;
  expect(child).toMatchObject({ action: 'session', stopsSession: true });
  expect(planLocalStorageCleanup(all, snapshot.dependencies!, [parent.id]).required).toEqual([grandchild.id, child.id]);
  await expect(f.service.clean(snapshot.id, [{ id: parent.id }, { id: child.id }])).rejects.toThrow('缺少必删项目');
  f.removeSession.mockImplementation(async (id: string) => { f.rows.splice(f.rows.findIndex(row => row.id === id), 1); });
  const result = await f.service.clean(snapshot.id, all.map(item => ({ id: item.id })));
  expect(result.map(item => item.status)).toEqual(['started', 'started', 'started']);
  expect(f.removeSession.mock.calls.flat()).toEqual(['grandchild', 'child', sid]);
});

it('rechecks a worktree owner before invoking the non-forced cleanup service', async () => {
  const f = fixture(); f.rows[0].worktreePath = path.join(f.root, 'tree'); fs.mkdirSync(f.rows[0].worktreePath);
  f.rows[0].retainedWorktreeOnly = true;
  const first = await f.service.scan(), tree = first.items.find(item => item.category === 'worktrees')!;
  expect((await f.service.clean(first.id, [{ id: tree.id }]))[0].status).toBe('completed');
  expect(f.cleanupWorktree).toHaveBeenCalledWith(sid, false);
  const second = await f.service.scan(), next = second.items.find(item => item.category === 'worktrees')!;
  f.rows[0].worktreeBranch = 'changed';
  expect((await f.service.clean(second.id, [{ id: next.id }]))[0].status).toBe('failed');
  expect(f.cleanupWorktree).toHaveBeenCalledTimes(1);
});

it('allows archived missing worktree roots to enter safe cleanup, but rechecks that they remain missing', async () => {
  const f = fixture(), tree = path.join(f.root, 'removed-tree');
  f.rows[0].worktreePath = tree; f.rows[0].retainedWorktreeOnly = true;
  const first = await f.service.scan(), item = first.items.find(entry => entry.category === 'worktrees')!;
  expect(item).toMatchObject({ bytes: null, partial: false, action: 'worktree', pathStatuses: [{ path: tree, status: 'missing' }] });
  expect((await f.service.clean(first.id, [{ id: item.id }]))[0].status).toBe('completed');
  expect(f.cleanupWorktree).toHaveBeenCalledOnce();
  const second = await f.service.scan(), next = second.items.find(entry => entry.category === 'worktrees')!;
  fs.mkdirSync(tree);
  expect((await f.service.clean(second.id, [{ id: next.id }]))[0].status).toBe('failed');
  expect(f.cleanupWorktree).toHaveBeenCalledOnce();
});

it('rejects a worktree directory that disappears after the scan', async () => {
  const f = fixture(), tree = path.join(f.root, 'tree');
  fs.mkdirSync(tree); f.rows[0].worktreePath = tree; f.rows[0].retainedWorktreeOnly = true;
  const snapshot = await f.service.scan(), item = snapshot.items.find(entry => entry.category === 'worktrees')!;
  expect(item.pathStatuses).toEqual([{ path: tree, status: 'available' }]);
  fs.rmdirSync(tree);
  expect((await f.service.clean(snapshot.id, [{ id: item.id }]))[0]).toMatchObject({ status: 'failed', error: '存储项目已变化，请重新扫描。' });
  expect(f.cleanupWorktree).not.toHaveBeenCalled();
});

it('offers missing worktrees through the cascade and does not treat permission errors as missing', async () => {
  const f = fixture(), tree = path.join(f.root, 'inaccessible-tree');
  f.rows[0].worktreePath = tree; f.rows[0].archived = false;
  const first = await f.service.scan(), active = first.items.find(item => item.category === 'worktrees')!;
  expect(active).toMatchObject({ action: 'worktree', pathStatuses: [{ path: tree, status: 'missing' }] });
  f.rows[0].archived = true;
  const original = fs.promises.lstat.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (file: fs.PathLike) => {
    if (String(file) === tree) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return original(file);
  }) as typeof fs.promises.lstat);
  try {
    const second = await f.service.scan(), inaccessible = second.items.find(item => item.category === 'worktrees')!;
    expect(inaccessible).toMatchObject({ reason: 'unavailable', partial: true, pathStatuses: [{ path: tree, status: 'unavailable' }] });
    expect(inaccessible.action).toBeUndefined();
  } finally { spy.mockRestore(); }
});

it('preserves both available and missing identities when a task has multiple worktree roots', async () => {
  const f = fixture(), existing = path.join(f.root, 'existing-tree'), missing = path.join(f.root, 'missing-tree');
  fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'file.txt'), '1234');
  f.rows[0].retainedWorktreeOnly = true;
  f.rows[0].worktreeGroups = { version: 1, primaryGroupId: 'a', groups: [{ id: 'a', path: existing, repos: [] }, { id: 'b', path: missing, repos: [] }] };
  const snapshot = await f.service.scan(), tree = snapshot.items.find(item => item.category === 'worktrees')!;
  expect(tree).toMatchObject({ bytes: 4, action: 'worktree', pathStatuses: [{ path: existing, status: 'available' }, { path: missing, status: 'missing' }] });
  fs.mkdirSync(missing);
  expect((await f.service.clean(snapshot.id, [{ id: tree.id }]))[0].status).toBe('failed');
  expect(f.cleanupWorktree).not.toHaveBeenCalled();
});

it('exposes a long-running cleanup as a pollable job and rejects overlapping jobs', async () => {
  const f = fixture(); f.rows[0].worktreePath = path.join(f.root, 'tree'); fs.mkdirSync(f.rows[0].worktreePath);
  f.rows[0].retainedWorktreeOnly = true;
  let finish!: () => void;
  f.cleanupWorktree.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
  const first = await f.service.scan(), tree = first.items.find(item => item.category === 'worktrees')!;
  const job = f.service.startCleanup(first.id, [{ id: tree.id }]);
  expect(f.service.cleanupStatus(job.id)).toMatchObject({ done: false, total: 1, results: [] });
  expect(() => f.service.startCleanup(first.id, [{ id: tree.id }])).toThrow();
  finish();
  await vi.waitFor(() => expect(f.service.cleanupStatus(job.id)).toMatchObject({ done: true, results: [{ id: tree.id, status: 'completed' }] }));
});

it('rechecks state at cleanup and does not delete an attachment twice with its session', async () => {
  const f = fixture(), first = await f.service.scan();
  const session = first.items.find(item => item.category === 'sessions' && item.sessionId === sid)!;
  const attachment = first.items.find(item => item.category === 'attachments')!;
  const results = await f.service.clean(first.id, [{ id: session.id }, { id: attachment.id }]);
  expect(results.map(r => r.status)).toEqual(['started', 'skipped']);
  expect(f.removeSession).toHaveBeenCalledWith(sid); expect(f.clearAttachments).not.toHaveBeenCalled();
  expect((await f.service.clean(first.id, [{ id: session.id }]))[0].status).toBe('failed');
  const second = await f.service.scan(), secondAttachment = second.items.find(item => item.category === 'attachments')!;
  f.rows[0].archived = false;
  expect(await f.service.clean(second.id, [{ id: secondAttachment.id }])).toEqual([expect.objectContaining({ status: 'failed' })]);
  expect(f.clearAttachments).not.toHaveBeenCalled();
});

it('delegates related attachments only after the selected session cleanup starts', async () => {
  const f = fixture();
  f.removeSession.mockRejectedValueOnce(new Error('session deletion failed'));
  const first = await f.service.scan();
  const session = first.items.find(item => item.category === 'sessions' && item.sessionId === sid)!;
  const attachment = first.items.find(item => item.category === 'attachments')!;
  const results = await f.service.clean(first.id, [{ id: attachment.id }, { id: session.id }]);
  expect(results).toEqual([
    expect.objectContaining({ id: session.id, status: 'failed', error: 'session deletion failed' }),
    expect.objectContaining({ id: attachment.id, status: 'completed' })
  ]);
  expect(f.clearAttachments).toHaveBeenCalledOnce();

  const second = await f.service.scan();
  const nextSession = second.items.find(item => item.category === 'sessions' && item.sessionId === sid)!;
  const nextAttachment = second.items.find(item => item.category === 'attachments')!;
  const delegated = await f.service.clean(second.id, [{ id: nextAttachment.id }, { id: nextSession.id }]);
  expect(delegated).toEqual([
    expect.objectContaining({ id: nextSession.id, status: 'started' }),
    expect.objectContaining({ id: nextAttachment.id, status: 'skipped' })
  ]);
  expect(f.clearAttachments).toHaveBeenCalledOnce();
});

it('processes more than 200 selected items and rejects batches beyond the shared limit', async () => {
  const f = fixture();
  for (let i = 0; i < 224; i++) f.rows.push({ id: `saved-${i}`, type: 'terminal', name: `Saved ${i}`, createdAt: i, workspaceId: 'ws', archived: true, status: 'exited' });
  const snapshot = await f.service.scan();
  const selections = snapshot.items.filter(item => item.action === 'session').map(item => ({ id: item.id }));
  expect(selections).toHaveLength(225);
  await expect(f.service.clean(snapshot.id, selections)).resolves.toHaveLength(225);
  expect(f.removeSession).toHaveBeenCalledTimes(225);

  const next = await f.service.scan();
  const tooMany = Array.from({ length: MAX_LOCAL_STORAGE_SELECTION + 1 }, (_, i) => ({ id: `item-${i}` }));
  await expect(f.service.clean(next.id, tooMany)).rejects.toThrow('存储项目选择无效');
  expect(f.removeSession).toHaveBeenCalledTimes(225);
});

it('rejects an attachment directory redirected after the scan', async () => {
  const f = fixture(), snapshot = await f.service.scan(), attachment = snapshot.items.find(item => item.category === 'attachments')!;
  const original = path.join(f.userData, 'conversation-attachments'), moved = path.join(f.root, 'old-attachments'), outside = path.join(f.root, 'outside');
  fs.renameSync(original, moved); fs.mkdirSync(outside);
  fs.symlinkSync(outside, original, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.service.clean(snapshot.id, [{ id: attachment.id }]);
  expect(result[0].status).toBe('failed'); expect(f.clearAttachments).not.toHaveBeenCalled();
});

it('forwards the explicit app-data choice and rejects an app changed since review', async () => {
  const f = fixture(), first = await f.service.scan(), app = first.items.find(item => item.action === 'app')!;
  expect((await f.service.clean(first.id, [{ id: app.id, deleteAppData: true }]))[0].status).toBe('completed');
  expect(f.uninstallApp).toHaveBeenCalledWith('ws', 'custom-app', true);
  const second = await f.service.scan(), next = second.items.find(item => item.action === 'app')!;
  f.setApps({ workspaceId: 'ws', apps: [{ ...f.app, enabled: false }], operations: [], connections: [], errors: [] } as unknown as AppSnapshot);
  expect((await f.service.clean(second.id, [{ id: next.id }]))[0].status).toBe('failed');
  expect(f.uninstallApp).toHaveBeenCalledTimes(1);
});

it('bounds scans and reports a partial result', async () => {
  const f = fixture();
  const result = await measureStorage([f.userData], { seen: new Set(), budget: { remaining: 1 } });
  expect(result.partial).toBe(true);
});

it('does not inspect the host private directory while measuring a worktree', async () => {
  const f = fixture(), tree = path.join(f.root, 'tree');
  fs.mkdirSync(path.join(tree, '.muster'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'visible.txt'), '1234');
  const result = await measureStorage([tree], { seen: new Set(), budget: { remaining: 100 } });
  expect(result).toMatchObject({ bytes: 4, partial: true });
});


it('identifies only the browser partition and reports cleanup failures without claiming success', async () => {
  const f = fixture();
  f.write('Partitions/browser/Cookies', 'cookies');
  f.write('Partitions/another/other', 'other');
  f.deps.browserStoragePath = path.join(f.userData, 'Partitions', 'browser');
  f.deps.clearBrowserData = vi.fn().mockRejectedValueOnce(new Error('locked cache'));
  const snapshot = await f.service.scan();
  const browser = snapshot.items.find(item => item.action === 'browserData')!;
  expect(browser).toMatchObject({ bytes: 7, category: 'browser' });
  expect(browser.modifiedAt).toBeGreaterThan(0);
  expect(snapshot.items.find(item => item.name === 'another')).toMatchObject({ reason: 'shared', bytes: 5 });
  expect(await f.service.clean(snapshot.id, [{ id: browser.id }])).toMatchObject([{ status: 'failed', error: 'locked cache' }]);
  expect(f.deps.clearBrowserData).toHaveBeenCalledOnce();
});

it('cleans finished downloads only and detects a download starting after scanning', async () => {
  const f = fixture(), store = new BrowserDownloadStore(f.userData);
  const { id, file } = store.begin('file.txt');
  fs.writeFileSync(file, 'download');
  f.deps.downloadStatus = file => store.status(file);
  f.deps.downloadIdentity = file => store.snapshotIdentity(file);
  f.deps.removeDownload = (file, expected) => store.remove(file, expected);
  expect((await f.service.scan()).items.find(item => item.paths.includes(file))?.reason).toBe('active');
  store.finish(id, 'completed');
  const snapshot = await f.service.scan();
  const download = snapshot.items.find(item => item.action === 'download')!;
  fs.writeFileSync(file, 'changed after scan');
  expect((await f.service.clean(snapshot.id, [{ id: download.id }]))[0].status).toBe('failed');
  expect(fs.existsSync(file)).toBe(true);
  expect((await f.service.scan()).items.find(item => item.paths.includes(file))?.reason).toBe('unknownDownload');
});

it('keeps unrecorded browser files read-only', async () => {
  const f = fixture(), file = f.write('browser-downloads/unrecorded.txt', 'user data');
  const store = new BrowserDownloadStore(f.userData);
  f.deps.downloadStatus = file => store.status(file);
  const item = (await f.service.scan()).items.find(entry => entry.paths.includes(file))!;
  expect(item).toMatchObject({ reason: 'unknownDownload' });
  expect(item.action).toBeUndefined();
});

it('cleans only recognized standalone artifacts and refuses a substituted file', async () => {
  const f = fixture(), log = f.write('logs/main.log.old', 'fixture log'), capture = f.write('browser-captures/shot-1784300000-abc123.png', 'fixture shot');
  const unknown = f.write('browser-captures/manual-save.png', 'unknown file');
  const snapshot = await f.service.scan();
  expect(snapshot.items.find(item => item.paths.includes(unknown))).toMatchObject({ reason: 'unknown' });
  const artifacts = snapshot.items.filter(item => item.action === 'artifact');
  expect(artifacts).toHaveLength(2);
  fs.writeFileSync(capture, 'changed capture');
  const results = await f.service.clean(snapshot.id, artifacts.map(item => ({ id: item.id })));
  expect(results.find(item => item.id === artifacts.find(asset => asset.paths[0] === log)!.id)?.status).toBe('completed');
  expect(results.find(item => item.id === artifacts.find(asset => asset.paths[0] === capture)!.id)?.status).toBe('failed');
  expect(fs.existsSync(log)).toBe(false);
  expect(fs.readFileSync(capture, 'utf8')).toBe('changed capture');
  expect(fs.existsSync(unknown)).toBe(true);
});

it('offers commonly occupied Other data as actionable groups and keeps queued bytes visible until restart', async () => {
  const f = fixture(), otherFiles = [
    'Cache/cache.bin', 'Code Cache/js/tool',
    'GPUCache/shader.bin', 'Local Storage/leveldb/000003.log',
    'Network/Cookies', 'Crashpad/reports/report.dmp',
    'process-monitor-captures/process.cpuprofile',
    'harness-model-catalogs.json', 'provider-model-catalogs.json',
    'trim-cache/conversation/output.txt', 'evidence/session/index.json', 'desktop-captures/s1/frame.png',
    'usage-stats.json', 'usage-tool-failures.json', 'capability-usage.json',
    'session-reminders.sqlite', 'session-reminders.sqlite-wal', 'waiting-tips.json',
    'bg-tasks.json', 'bg-outputs/task.log'
  ];
  for (const relative of otherFiles) f.write(relative, 'data');
  const configuration = f.write('config.json', 'workspace configuration');
  const maintenance = new StartupStorageMaintenance(f.userData, f.userData);
  f.deps.maintenance = maintenance;
  const snapshot = await f.service.scan();
  const actionable = snapshot.items.filter(item => item.category === 'other' && item.action === 'startupCleanup');
  expect(actionable).toHaveLength(13);
  expect(actionable.reduce((sum, item) => sum + item.paths.length, 0)).toBe(otherFiles.length);
  expect(actionable.reduce((sum, item) => sum + (item.bytes ?? 0), 0)).toBe(otherFiles.length * 4);
  expect(snapshot.items.find(item => item.paths.includes(configuration))?.action).toBeUndefined();
  const cache = actionable.find(item => item.maintenanceId === 'chromiumCache')!;
  expect(await f.service.clean(snapshot.id, [{ id: cache.id }])).toEqual([{ id: cache.id, status: 'scheduled' }]);
  expect(cache.paths.every(file => fs.existsSync(file))).toBe(true);
  const queued = await f.service.scan();
  expect(queued.items.find(item => item.maintenanceId === 'chromiumCache')).toMatchObject({ reason: 'restartPending', bytes: cache.bytes });
  expect(queued.items.find(item => item.maintenanceId === 'workbenchWebData')?.action).toBe('startupCleanup');
  expect(maintenance.detachQueued()).toEqual([]);
  expect(await maintenance.purgeDetached(new AbortController().signal)).toEqual([]);
  expect(cache.paths.every(file => !fs.existsSync(file))).toBe(true);
  expect(fs.readFileSync(configuration, 'utf8')).toBe('workspace configuration');
});

it('requires every active workspace to disable an extension before uninstalling its package', async () => {
  const f = fixture(), directory = path.dirname(f.write('extensions/global/example/extension.json', 'fixture'));
  const pkg = { id: 'example', name: 'Example', directory, fingerprint: 'test-version', builtin: false, enabledWorkspaceIds: ['ws', 'closed'] };
  f.deps.extensionPackages = () => [structuredClone(pkg)];
  f.deps.verifyExtension = vi.fn(async () => {});
  f.deps.disableExtension = vi.fn(async (workspaceId) => { pkg.enabledWorkspaceIds = pkg.enabledWorkspaceIds.filter(id => id !== workspaceId); });
  f.deps.uninstallExtension = vi.fn(async () => { expect(pkg.enabledWorkspaceIds).toEqual([]); });
  const scan = await f.service.scan();
  const source = scan.items.find(item => item.action === 'extension')!;
  const activations = scan.items.filter(item => item.action === 'extensionActivation');
  expect(source).toMatchObject({ paths: [directory], bytes: 7 });
  expect(activations).toHaveLength(2);
  expect(planLocalStorageCleanup(scan.items, scan.dependencies!, [activations[0].id]).recommended).toEqual([]);
  await expect(f.service.clean(scan.id, [{ id: source.id }])).rejects.toThrow('缺少必删项目');
  const result = await f.service.clean(scan.id, [source, ...activations].map(item => ({ id: item.id })));
  expect(result.map(item => item.status)).toEqual(['completed', 'completed', 'completed']);
  expect(f.deps.disableExtension).toHaveBeenCalledTimes(2);
  expect(f.deps.uninstallExtension).toHaveBeenCalledWith('example', 'test-version');
});
