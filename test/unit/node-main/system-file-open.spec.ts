import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ stat: vi.fn(), mkdir: vi.fn(), openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() }));
vi.mock('node:fs/promises', () => ({ default: { stat: mocks.stat, mkdir: mocks.mkdir } }));
vi.mock('electron', () => ({ shell: { openPath: mocks.openPath, openExternal: mocks.openExternal, showItemInFolder: mocks.showItemInFolder } }));
import { openSystemPath, revealPath } from '../../../src/main/shell/reveal';
import { normalizeShellPath } from '../../../src/main/shell/pathStat';
import { defaultProductWorktreesRoot } from '../../../src/main/runtimeKernel/storageRootResolver';

describe('system file open', () => {
  const file = path.resolve('fixture directory', '报告 #1.pdf');
  beforeEach(() => { vi.clearAllMocks(); mocks.stat.mockResolvedValue({}); mocks.openPath.mockResolvedValue(''); });
  it('opens a validated absolute file using Electron on the current platform', async () => {
    expect(await openSystemPath(file)).toEqual({ ok: true });
    expect(mocks.stat).toHaveBeenCalledWith(file);
    expect(mocks.openPath).toHaveBeenCalledWith(file);
  });
  it('rejects relative, empty and invalid paths before starting an application', async () => {
    for (const input of ['relative/report.pdf', '', `${file}\0suffix`]) {
      expect((await openSystemPath(input)).ok).toBe(false);
    }
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
  it('returns filesystem and desktop failures to the caller', async () => {
    mocks.stat.mockRejectedValueOnce(new Error('permission denied'));
    expect(await openSystemPath(file)).toEqual({ ok: false, error: 'permission denied' });
    mocks.openPath.mockResolvedValueOnce('no application');
    expect(await openSystemPath(file)).toEqual({ ok: false, error: 'no application' });
    mocks.openPath.mockRejectedValueOnce(new Error('desktop unavailable'));
    expect(await openSystemPath(file)).toEqual({ ok: false, error: 'desktop unavailable' });
  });
});

describe('reveal in the file manager', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.openPath.mockResolvedValue(''); });
  it.each(['C:\\Users\\me\\worktree', '/Users/me/worktree', '/home/me/worktree'])('opens an existing directory through Electron: %s', async input => {
    mocks.stat.mockResolvedValue({ isDirectory: () => true });
    expect(await revealPath(input)).toEqual({ ok: true });
    expect(mocks.openPath).toHaveBeenCalledWith(normalizeShellPath(input));
  });
  it('reveals an existing file in its parent folder', async () => {
    const file = path.resolve('fixture-directory', 'file.txt');
    mocks.stat.mockResolvedValue({ isDirectory: () => false });
    expect(await revealPath(file)).toEqual({ ok: true });
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(file);
  });
  it('distinguishes missing paths from access and desktop failures', async () => {
    const input = path.resolve('fixture-directory');
    mocks.stat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await revealPath(input)).toEqual({ ok: false, error: '路径不存在' });
    expect(mocks.mkdir).not.toHaveBeenCalled();
    mocks.stat.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    expect(await revealPath(input)).toEqual({ ok: false, error: 'permission denied' });
    mocks.stat.mockResolvedValueOnce({ isDirectory: () => true });
    mocks.openPath.mockResolvedValueOnce('desktop unavailable');
    expect(await revealPath(input)).toEqual({ ok: false, error: 'desktop unavailable' });
  });

  it('creates the default worktree directory before opening it on a fresh installation', async () => {
    const root = defaultProductWorktreesRoot();
    mocks.stat.mockImplementationOnce(async () => {
      if (!mocks.mkdir.mock.calls.length) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isDirectory: () => true };
    });
    await expect(revealPath(root)).resolves.toEqual({ ok: true });
    expect(mocks.mkdir).toHaveBeenCalledWith(root, { recursive: true });
    expect(mocks.openPath).toHaveBeenCalledWith(root);
  });

  it('reports a blocked default worktree directory and leaves the file manager closed', async () => {
    const root = defaultProductWorktreesRoot();
    mocks.mkdir.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    const result = await revealPath(root);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('permission denied') });
    expect(result.error).toContain('选择其他目录');
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
});
