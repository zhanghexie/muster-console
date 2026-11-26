import { describe, expect, it, vi } from 'vitest';
import { isWorkspaceFileClosePending, prepareWorkspaceFileClose, prepareWorkspaceFiles, registerWorkspaceFileClose } from '../../src/renderer/src/workspaceFileClose';

describe('workspace file close preparation', () => {
  it('locks a workspace until its close transaction finishes and rejects overlap', async () => {
    let resolve!: (value: { commit(): void; rollback(): void }) => void;
    const unregister = registerWorkspaceFileClose(() => new Promise(done => { resolve = done; }));
    try {
      const pending = prepareWorkspaceFileClose('ws');
      expect(isWorkspaceFileClosePending('ws')).toBe(true);
      await expect(prepareWorkspaceFileClose('ws')).rejects.toThrow(/pending/);
      resolve({ commit: () => {}, rollback: () => {} });
      const tx = await pending;
      expect(isWorkspaceFileClosePending('ws')).toBe(true);
      tx.rollback();
      expect(isWorkspaceFileClosePending('ws')).toBe(false);
    } finally { unregister(); }
  });
  it('unlocks after preparation fails', async () => {
    const unregister = registerWorkspaceFileClose(async () => { throw new Error('save failed'); });
    try {
      await expect(prepareWorkspaceFileClose('ws')).rejects.toThrow('save failed');
      expect(isWorkspaceFileClosePending('ws')).toBe(false);
    } finally { unregister(); }
  });
  it('flushes every file before moving any dock and only removes after commit', async () => {
    const calls: string[] = [];
    const items = [{ id: 'a', identity: 'one', docked: true }, { id: 'b', identity: 'two', docked: false }];
    const transaction = await prepareWorkspaceFiles({ read: () => items, dirty: () => false,
      flush: async id => { calls.push(`flush:${id}`); },
      begin: ids => { calls.push(`begin:${ids.join(',')}`); return { ok: true, commit: () => { calls.push('commit'); return { ok: true }; }, rollback: () => { calls.push('rollback'); return { ok: true }; } }; },
      remove: () => { calls.push('remove'); } });
    expect(calls).toEqual(['flush:a', 'flush:b', 'begin:a']);
    transaction.commit();
    expect(calls).toEqual(['flush:a', 'flush:b', 'begin:a', 'commit', 'remove']);
  });
  it('rejects changed or unsaved editors before moving any surface', async () => {
    let identity = 'one';
    const begin = vi.fn();
    await expect(prepareWorkspaceFiles({ read: () => [{ id: 'a', identity, docked: true }], dirty: () => false,
      flush: async () => { identity = 'changed'; }, begin, remove: () => {} })).rejects.toThrow(/changed/);
    expect(begin).not.toHaveBeenCalled();
    await expect(prepareWorkspaceFiles({ read: () => [{ id: 'a', identity, docked: true }], dirty: () => true,
      flush: async () => {}, begin, remove: () => {} })).rejects.toThrow(/unsaved/);
    expect(begin).not.toHaveBeenCalled();
  });
  it('rolls back instead of removing files if they become dirty before commit', async () => {
    let dirty = false;
    const rollback = vi.fn(() => ({ ok: true as const })), remove = vi.fn();
    const transaction = await prepareWorkspaceFiles({ read: () => [{ id: 'a', identity: 'one', docked: true }], dirty: () => dirty,
      flush: async () => {}, begin: () => ({ ok: true, commit: () => ({ ok: true }), rollback }), remove });
    dirty = true;
    expect(() => transaction.commit()).toThrow(/changed/);
    expect(rollback).toHaveBeenCalledOnce(); expect(remove).not.toHaveBeenCalled();
  });
  it('does not move files when flushing fails', async () => {
    const begin = vi.fn();
    await expect(prepareWorkspaceFiles({ read: () => [{ id: 'a', identity: 'one', docked: true }], dirty: () => true,
      flush: async () => { throw new Error('save failed'); }, begin, remove: () => {} })).rejects.toThrow('save failed');
    expect(begin).not.toHaveBeenCalled();
  });
  it('releases the dock transaction when a later identity read fails', async () => {
    let reads = 0;
    const rollback = vi.fn(() => ({ ok: true as const }));
    await expect(prepareWorkspaceFiles({ read: () => {
      if (++reads === 3) throw new Error('identity unavailable');
      return [{ id: 'a', identity: 'one', docked: true }];
    }, dirty: () => false, flush: async () => {},
    begin: () => ({ ok: true, commit: () => ({ ok: true }), rollback }), remove: () => {} })).rejects.toThrow('identity unavailable');
    expect(rollback).toHaveBeenCalledOnce();
  });
});
