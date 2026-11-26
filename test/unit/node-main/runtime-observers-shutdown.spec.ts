// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
vi.stubGlobal('window', globalThis);
const mocks = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock('../../../src/main/messages/deliver', () => ({ deliverAgentMessage: mocks.deliver }));
import { WatcherLifetime } from '../../../src/main/watcherLifetime';
import { WorkspaceFsWatcher } from '../../../src/main/workspaceFsWatcher';
import { OrchestratorEventPump } from '../../../src/main/orchestrator/events';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); mocks.deliver.mockReset(); for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true}); });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise,resolve}; }
function fakeWatcher() { return Object.assign(new EventEmitter(), {close: vi.fn()}) as unknown as fs.FSWatcher; }

it('awaits native close even for reconfigured watchers, retaining failed close for retry', async () => {
  const owner = new WatcherLifetime(), watcher = fakeWatcher(); owner.own(watcher);
  owner.retire(watcher); let done = false;
  const closing = owner.shutdown().then(() => {done = true;});
  await Promise.resolve(); expect(done).toBe(false);
  expect(watcher.close).toHaveBeenCalledOnce(); watcher.emit('close'); await closing;
  const failed = fakeWatcher(); owner.own(failed);
  vi.mocked(failed.close).mockImplementationOnce(() => { throw new Error('native close failed'); });
  await expect(owner.shutdown()).rejects.toThrow('Native file watchers failed');
  vi.mocked(failed.close).mockImplementationOnce(() => { failed.emit('close'); });
  await owner.shutdown(); expect(failed.close).toHaveBeenCalledTimes(2);
});

it('waits for in-flight workspace stat and native close without publishing a late change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-watch-shutdown-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'data');
  let changed!: (event: string, file: string) => void;
  const native = fakeWatcher();
  vi.spyOn(fs, 'watch').mockImplementation(((_root: unknown, _opts: unknown, callback: typeof changed) => { changed = callback; return native; }) as typeof fs.watch);
  const send = vi.fn(), notify = vi.fn();
  const ctx = {config:{get:()=>({workspaces:[{id:'w',path:root,roots:[{id:'r',path:root}]}]})},getWindow:()=>({isDestroyed:()=>false,webContents:{send}})} as unknown as AppContext;
  const watcher = new WorkspaceFsWatcher(ctx); watcher.onChanged = notify; watcher.syncFromConfig();
  const stat = deferred<fs.Stats>(); const checking = vi.spyOn(fs.promises, 'stat').mockImplementationOnce(() => stat.promise as never);
  changed('change', 'a.txt'); await vi.waitFor(() => expect(checking).toHaveBeenCalled());
  let stopped = false; const shutdown = watcher.shutdown().then(() => {stopped = true;});
  await Promise.resolve(); expect(stopped).toBe(false); expect(() => watcher.ensure('w')).toThrow('stopping');
  native.emit('close'); await Promise.resolve(); expect(stopped).toBe(false);
  stat.resolve(fs.statSync(root)); await shutdown;
  expect(send).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
});

it('drains an accepted event delivery and rejects late scheduling and taps after shutdown', async () => {
  const delivery = deferred(); mocks.deliver.mockImplementation(() => delivery.promise);
  const timers = vi.fn(() => 0 as never), tap = vi.fn(), situation = vi.fn();
  const ctx = {config:{get:()=>({workspaces:[{id:'w',path:'/workspace'}]})},sessions:{get:()=>undefined,list:()=>[]},orchestrator:{isBusy:()=>false}} as unknown as AppContext;
  const pump = new OrchestratorEventPump({ctx,setTimeout:timers,clearTimeout:()=>{},onSituationChange:situation});
  pump.addTap(tap); pump.enqueue({kind:'merge_blocked',workspaceId:'w',detail:'test'});
  const sending = pump.flush('w'); await vi.waitFor(() => expect(mocks.deliver).toHaveBeenCalledOnce());
  let stopped = false; const shutdown = pump.shutdown().then(() => {stopped = true;});
  const count = timers.mock.calls.length, taps = tap.mock.calls.length; situation.mockClear();
  pump.enqueue({kind:'merge_blocked',workspaceId:'w',detail:'late'}); pump.onOrchestratorIdle('w');
  expect(await pump.flush('w')).toBe('skip'); expect(stopped).toBe(false);
  delivery.resolve(); await sending; await shutdown;
  expect(timers).toHaveBeenCalledTimes(count); expect(tap).toHaveBeenCalledTimes(taps);
  expect(pump.peek('w')).toEqual([]); expect(() => pump.addTap(tap)).toThrow('stopping');
  expect(situation).not.toHaveBeenCalled(); expect(() => pump.start()).toThrow('stopping');
});
