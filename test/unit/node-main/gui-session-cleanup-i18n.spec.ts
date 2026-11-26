import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';

vi.mock('../../../src/main/attachments/service', () => ({
  clearAttachments: () => { throw new Error('原始附件错误'); }
}));

import { GuiSessionStore } from '../../../src/main/agentSession/persist';
import { close, purgeEngine } from '../../../src/main/agentSession/host/lifecycle';

afterEach(() => { applyLocaleSetting('zh-CN'); vi.restoreAllMocks(); });

it('reports all cleanup failures in the selected language and retains their underlying details', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-cleanup-i18n-'));
  try {
    const store = new GuiSessionStore(temporary);
    vi.spyOn(store, 'loadPendingFork').mockImplementation(() => { throw new Error('原始保护错误'); });
    vi.spyOn(store, 'clearForkPoints').mockImplementation(() => { throw new Error('原始索引错误'); });
    // An existing directory at the history file path reliably rejects unlink.
    fs.mkdirSync(path.join(temporary, 'agent-sessions', 'session.json'));
    applyLocaleSetting('en');
    let message = '';
    try { store.delete('session'); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(`Could not verify the fork protection record; retained ${path.join(temporary, 'agent-fork-pending', 'session.json')}: Error: 原始保护错误`);
    expect(message).toContain('Could not clean up the fork index: Error: 原始索引错误');
    expect(message).toContain('Could not clean up session attachments: Error: 原始附件错误');
    expect(message).toContain('Could not clean up session history:');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

it('localizes a propagated engine purge failure without changing its original cause', async () => {
  applyLocaleSetting('en');
  const original = new Error('原始引擎错误');
  const purge = vi.fn(async () => { throw original; });
  const host = { drivers: new Map([['fixture', { purge }]]), entries: new Map() } as any;
  await expect(purgeEngine(host, 'session', { runtime: 'fixture' } as any, { propagateFailure: true }))
    .rejects.toThrow('Could not clean up engine data (fixture): Error: 原始引擎错误');
  expect(purge).toHaveBeenCalledOnce();
  expect(original.message).toBe('原始引擎错误');
});

it('reports both local and engine failures when deleting a closed session', async () => {
  applyLocaleSetting('en');
  const host = {
    drivers: new Map([['fixture', { purge: async () => { throw new Error('引擎原文'); } }]]),
    entries: new Map(),
    // close() 现在读 host.ctx.bgTasks 并调用 store.release；旧夹具只有 store.delete。
    ctx: {},
    store: { delete: () => { throw new Error('磁盘原文'); }, release: vi.fn(), flush: async () => {} }
  } as any;
  await expect(close(host, 'session', { purgeHistory: true, meta: { runtime: 'fixture' } as any }))
    .rejects.toThrow('Error: 磁盘原文; Error: Could not clean up engine data (fixture): Error: 引擎原文');
});
