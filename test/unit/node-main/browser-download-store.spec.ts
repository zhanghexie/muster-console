import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserDownloadStore } from '../../../src/main/browser/downloadStore';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-downloads-test-'));
  roots.push(root);
  return { root, store: new BrowserDownloadStore(root) };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('keeps simultaneous same-name downloads independent and persists completed receipts', () => {
  const { root, store } = fixture();
  const a = store.begin('same.txt'), b = store.begin('same.txt');
  expect(a.id).not.toBe(b.id);
  expect(a.file).not.toBe(b.file);
  fs.writeFileSync(a.file, 'first'); fs.writeFileSync(b.file, 'second');
  store.finish(a.id, 'completed');
  expect(store.status(a.file)).toBe('verified');
  expect(store.status(b.file)).toBe('active');
  store.finish(b.id, 'interrupted');
  const restarted = new BrowserDownloadStore(root);
  expect(restarted.status(a.file)).toBe('verified');
  expect(restarted.status(b.file)).toBe('verified');
  restarted.remove(a.file, restarted.snapshotIdentity(a.file));
  expect(fs.existsSync(a.file)).toBe(false);
  expect(fs.readFileSync(b.file, 'utf8')).toBe('second');
});

it('uses a cross-platform safe bounded filename for the unique download', () => {
  const { store } = fixture(), download = store.begin(`${'中'.repeat(150)}:bad. `);
  const name = path.basename(download.file);
  expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(217);
  expect(name).not.toMatch(/[\\/:*?"<>|\x00-\x1f]|[. ]$/);
  fs.writeFileSync(download.file, 'safe');
  store.finish(download.id, 'completed');
  expect(store.status(download.file)).toBe('verified');
});

it('does not delete a replacement inserted after validation and restores it safely', () => {
  const { root, store } = fixture(), download = store.begin('race.txt');
  fs.writeFileSync(download.file, 'original'); store.finish(download.id, 'completed');
  const snapshot = store.snapshotIdentity(download.file), original = path.join(root, 'original');
  expect(() => store.remove(download.file, snapshot, { beforeRename: () => {
    fs.renameSync(download.file, original);
    fs.writeFileSync(download.file, 'replacement');
  } })).toThrow();
  expect(fs.readFileSync(original, 'utf8')).toBe('original');
  expect(fs.readFileSync(download.file, 'utf8')).toBe('replacement');
  expect(store.status(download.file)).toBe('unknown');
});

it('does not delete a new file created at the original path after isolation', () => {
  const { store } = fixture(), download = store.begin('race.txt');
  fs.writeFileSync(download.file, 'original'); store.finish(download.id, 'completed');
  store.remove(download.file, store.snapshotIdentity(download.file), { afterRename: () => fs.writeFileSync(download.file, 'new file') });
  expect(fs.readFileSync(download.file, 'utf8')).toBe('new file');
  expect(store.status(download.file)).toBe('unknown');
});

it('preserves a substituted file in quarantine if its original path becomes occupied', () => {
  const { root, store } = fixture(), download = store.begin('race.txt');
  fs.writeFileSync(download.file, 'original'); store.finish(download.id, 'completed');
  const expected = store.snapshotIdentity(download.file), original = path.join(root, 'original');
  expect(() => store.remove(download.file, expected, {
    beforeRename: () => { fs.renameSync(download.file, original); fs.writeFileSync(download.file, 'replacement'); },
    afterRename: () => fs.writeFileSync(download.file, 'new occupant')
  })).toThrow(/隔离位置/);
  expect(fs.readFileSync(original, 'utf8')).toBe('original');
  expect(fs.readFileSync(download.file, 'utf8')).toBe('new occupant');
  const quarantine = fs.readdirSync(path.dirname(download.file)).find(name => name.startsWith('.cleanup-'))!;
  expect(fs.readFileSync(path.join(path.dirname(download.file), quarantine, 'item'), 'utf8')).toBe('replacement');
});

it('treats missing or invalid persisted receipts as unknown', () => {
  const { root, store } = fixture(), download = store.begin('receipt.txt');
  fs.writeFileSync(download.file, 'data'); store.finish(download.id, 'completed');
  const receipt = path.join(root, 'browser-download-receipts', `${download.id}.json`);
  fs.writeFileSync(receipt, '{invalid');
  expect(new BrowserDownloadStore(root).status(download.file)).toBe('unknown');
  expect(() => store.remove(download.file, store.snapshotIdentity(download.file))).toThrow();
  expect(fs.readFileSync(download.file, 'utf8')).toBe('data');
});

it('reports an occupied or inaccessible file without deleting it', () => {
  const { store } = fixture(), download = store.begin('locked.txt');
  fs.writeFileSync(download.file, 'keep'); store.finish(download.id, 'completed');
  const expected = store.snapshotIdentity(download.file);
  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    const error = new Error('permission denied') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  });
  try { expect(() => store.remove(download.file, expected)).toThrow('permission denied'); }
  finally { rename.mockRestore(); }
  expect(fs.readFileSync(download.file, 'utf8')).toBe('keep');
  expect(store.status(download.file)).toBe('verified');
  expect(fs.readdirSync(path.dirname(download.file)).some(name => name.startsWith('.cleanup-'))).toBe(false);
});
