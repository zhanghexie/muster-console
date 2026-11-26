import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StartupStorageMaintenance, StorageMaintenanceRecoveryError } from '../../../src/main/storage/startupMaintenance';

const roots: string[] = [];
function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-startup-cleanup-'));
  roots.push(temporary);
  const userData = path.join(fs.realpathSync(temporary), 'profile');
  fs.mkdirSync(userData);
  const write = (relative: string, value: string) => {
    const file = path.join(userData, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
  };
  const open = () => new StartupStorageMaintenance(userData, userData);
  const inspect = (service = open()) => service.inspect(new Set(fs.readdirSync(userData)));
  return { userData, temporary, write, open, inspect };
}
const signal = () => new AbortController().signal;
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('queues a SQLite group, then clears the database and all sidecars before the next profile opens', async () => {
  const f = fixture();
  const paths = ['session-reminders.sqlite', 'session-reminders.sqlite-wal', 'session-reminders.sqlite-shm', 'session-reminders.sqlite-journal']
    .map(name => f.write(name, name));
  const service = f.open();
  expect(f.inspect()).toEqual([expect.objectContaining({ id: 'sessionReminders', canQueue: true, paths })]);
  expect(fs.existsSync(service.directory)).toBe(false);
  service.queue('sessionReminders');
  expect(paths.every(file => fs.existsSync(file))).toBe(true);
  expect(f.inspect()[0]).toMatchObject({ phase: 'queued', canQueue: false });
  // A live writer may publish new content at the same registered path before shutdown.
  fs.writeFileSync(paths[1], 'last writes');
  const next = f.open();
  expect(next.detachQueued()).toEqual([]);
  expect(paths.every(file => !fs.existsSync(file))).toBe(true);
  // The newly opened service may create a replacement while the isolated copy is purged.
  f.write('session-reminders.sqlite', 'new database');
  expect(await next.purgeDetached(signal())).toEqual([]);
  expect(fs.readFileSync(paths[0], 'utf8')).toBe('new database');
  expect(f.inspect()[0]).toMatchObject({ phase: undefined, paths: [paths[0]], canQueue: true });
});

it('restores earlier members when a later file is locked', () => {
  const f = fixture();
  const db = f.write('session-reminders.sqlite', 'database');
  const wal = f.write('session-reminders.sqlite-wal', 'journal');
  const service = f.open();
  service.queue('sessionReminders');
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (source === wal) throw Object.assign(new Error('held by another process'), { code: 'EBUSY' });
    rename(source, destination);
  });
  expect(f.open().detachQueued()).toEqual([expect.stringContaining('held by another process')]);
  expect(fs.readFileSync(db, 'utf8')).toBe('database');
  expect(fs.readFileSync(wal, 'utf8')).toBe('journal');
  expect(f.inspect()[0]).toMatchObject({ phase: 'failed', issue: 'held by another process', canQueue: true });
  spy.mockRestore();
  service.queue('sessionReminders');
  expect(f.open().detachQueued()).toEqual([]);
  expect(fs.existsSync(db)).toBe(false);
});

it('blocks opening a partially moved database and restores it on a later startup', async () => {
  const f = fixture(), service = f.open();
  const db = f.write('session-reminders.sqlite', 'database');
  const wal = f.write('session-reminders.sqlite-wal', 'journal');
  const staged = path.join(service.directory, 'sessionReminders.data', path.basename(db));
  service.queue('sessionReminders');
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (source === wal || source === staged) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    rename(source, destination);
  });

  expect(() => f.open().detachQueued()).toThrow(StorageMaintenanceRecoveryError);
  expect(fs.readFileSync(staged, 'utf8')).toBe('database');
  expect(fs.readFileSync(wal, 'utf8')).toBe('journal');
  expect(() => f.open().detachQueued()).toThrow(StorageMaintenanceRecoveryError);
  expect(await f.open().purgeDetached(signal())).toEqual([]);
  expect(fs.existsSync(staged)).toBe(true);

  spy.mockRestore();
  expect(f.open().detachQueued()).toEqual([]);
  expect(fs.readFileSync(db, 'utf8')).toBe('database');
  expect(fs.readFileSync(wal, 'utf8')).toBe('journal');
  expect(f.inspect()[0]).toMatchObject({ phase: 'failed', canQueue: true });
});

it('resumes a partially moved group and an interrupted background purge', async () => {
  const f = fixture(), service = f.open();
  const cache = f.write('Cache/http', 'HTTP');
  const gpu = f.write('GPUCache/render', 'shader');
  service.queue('chromiumCache');
  const isolated = path.join(service.directory, 'chromiumCache.data');
  fs.mkdirSync(isolated);
  fs.renameSync(path.dirname(cache), path.join(isolated, 'Cache'));
  const next = f.open(), cancelled = new AbortController();
  expect(next.detachQueued()).toEqual([]);
  expect(fs.existsSync(gpu)).toBe(false);
  cancelled.abort();
  expect(await next.purgeDetached(cancelled.signal)).toEqual([]);
  expect(fs.existsSync(isolated)).toBe(true);
  expect(await f.open().purgeDetached(signal())).toEqual([]);
  expect(fs.existsSync(isolated)).toBe(false);
});

it('rejects a redirected root without removing any member of the group', async () => {
  const f = fixture(), service = f.open();
  const cache = f.write('Cache/http', 'HTTP');
  const gpu = f.write('GPUCache/render', 'shader');
  service.queue('chromiumCache');
  const outside = path.join(f.temporary, 'outside');
  fs.renameSync(path.dirname(gpu), outside);
  fs.symlinkSync(outside, path.dirname(gpu), process.platform === 'win32' ? 'junction' : 'dir');
  expect(f.open().detachQueued()).toEqual([expect.stringContaining('GPUCache')]);
  expect(fs.readFileSync(cache, 'utf8')).toBe('HTTP');
  expect(fs.readFileSync(path.join(outside, 'render'), 'utf8')).toBe('shader');
  expect(await f.open().purgeDetached(signal())).toEqual([]);
  expect(f.inspect()[0]).toMatchObject({ canQueue: false, issue: expect.stringContaining('GPUCache') });
});

it('removes a nested link itself and leaves its target intact', async () => {
  const f = fixture();
  const cache = f.write('GPUCache/render', 'shader');
  const outside = path.join(f.temporary, 'outside');
  fs.mkdirSync(outside);
  const marker = path.join(outside, 'marker');
  fs.writeFileSync(marker, 'outside workbench storage');
  fs.symlinkSync(outside, path.join(path.dirname(cache), 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  f.open().queue('chromiumCache');
  const next = f.open();
  expect(next.detachQueued()).toEqual([]);
  expect(await next.purgeDetached(signal())).toEqual([]);
  expect(fs.readFileSync(marker, 'utf8')).toBe('outside workbench storage');
});

it('clears app-owned cache when Chromium uses a separate profile and ignores unregistered requests', async () => {
  const f = fixture(), foreignSessionData = path.join(f.temporary, 'external-session-data');
  const webCache = f.write('Code Cache/compiled', 'outside the application cache group');
  const appCache = f.write('cache/index', 'application cache');
  const config = f.write('config.json', 'configuration');
  const request = f.write('.storage-maintenance/config.json.json', JSON.stringify({ version: 1, phase: 'queued', path: config }));
  const service = new StartupStorageMaintenance(f.userData, foreignSessionData);
  expect(f.inspect(service)).toEqual([expect.objectContaining({ id: 'appCache', canQueue: true, paths: [path.dirname(appCache)] })]);
  expect(() => service.queue('chromiumCache')).toThrow();
  service.queue('appCache');
  expect(service.detachQueued()).toEqual([]);
  expect(await service.purgeDetached(signal())).toEqual([]);
  expect(fs.existsSync(appCache)).toBe(false);
  expect(fs.existsSync(webCache)).toBe(true);
  expect(fs.existsSync(request)).toBe(true);
  expect(fs.existsSync(config)).toBe(true);
});
