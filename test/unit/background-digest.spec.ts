import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTaskManager } from '../../src/main/agentSession/background/manager';
import type { BgTaskRecord } from '../../src/shared/backgroundTasks';
import type { AppContext } from '../../src/main/context';

const fixtures: Array<{ dir: string; manager: BackgroundTaskManager }> = [];
function record(id: string): BgTaskRecord { return { id, parentSessionId: 'parent', kind: 'shell', label: id, detail: id,
  status: 'done', createdAt: Date.now(), endedAt: Date.now(), summary: 'result', unread: true, pendingDigest: true, wake: false }; }
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-bg-digest-'));
  fs.writeFileSync(path.join(dir, 'bg-tasks.json'), JSON.stringify({ version: 1, savedAt: Date.now(), tasks: [record('one')] }));
  const manager = new BackgroundTaskManager({ getWindow: () => null, sessions: { get: () => undefined } } as unknown as AppContext, { userDataDir: dir });
  fixtures.push({ dir, manager }); return { dir, manager };
}
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.manager.shutdown(); fs.rmSync(f.dir, { recursive: true, force: true }); } });

describe('background digest delivery', () => {
  it('retains prepared results until an explicit successful-turn acknowledgement persists', () => {
    const { dir, manager } = fixture();
    const first = manager.prepareDigest('parent')!;
    expect(first.text).toContain('one');
    expect(manager.prepareDigest('parent')).toEqual(first);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'bg-tasks.json'), 'utf8')).tasks[0].pendingDigest).toBe(true);
    manager.ackDigest(first); manager.ackDigest(first);
    expect(manager.prepareDigest('parent')).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'bg-tasks.json'), 'utf8')).tasks[0]).toMatchObject({ pendingDigest: false, parentNotification: 'digested' });
  });

  it('never acknowledges new arrivals or a result modified after preparation', () => {
    const { manager } = fixture();
    const first = manager.prepareDigest('parent')!;
    const tasks = (manager as unknown as { tasks: Map<string, BgTaskRecord> }).tasks;
    tasks.get('one')!.summary = 'cleanup outcome changed'; tasks.set('two', record('two'));
    manager.ackDigest(first);
    expect(manager.prepareDigest('parent')!.entries.map(item => item.id).sort()).toEqual(['one', 'two']);
    const next = manager.prepareDigest('parent')!;
    manager.ackDigest(next);
    expect(manager.prepareDigest('parent')).toBeNull();
  });

  it('rolls back consumption when acknowledgement cannot be saved', () => {
    const { dir, manager } = fixture();
    const prepared = manager.prepareDigest('parent')!;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => manager.ackDigest(prepared)).toThrow('disk unavailable');
    expect(manager.prepareDigest('parent')).toEqual(prepared);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'bg-tasks.json'), 'utf8')).tasks[0].pendingDigest).toBe(true);
    rename.mockRestore(); warning.mockRestore(); manager.ackDigest(prepared);
    expect(manager.prepareDigest('parent')).toBeNull();
  });

  it('tracks an already included wake result without duplicating its prefix text', () => {
    const { manager } = fixture();
    const prepared = manager.prepareDigest('parent', 'one')!;
    expect(prepared.text).toBe(''); expect(prepared.entries.map(item => item.id)).toEqual(['one']);
    manager.ackDigest(prepared); expect(manager.prepareDigest('parent')).toBeNull();
  });
});
