// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import type {AppContext} from '../../../src/main/context';
const mocks = vi.hoisted(() => ({root: '', handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()}));
vi.mock('electron', () => ({app: {getPath: () => mocks.root}, ipcMain: {
  handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => mocks.handlers.set(channel, fn),
  removeHandler: (channel: string) => mocks.handlers.delete(channel)
}}));
// This suite exercises the real GUI registration and dispatcher, not the
// independent file-change feature which shares its registration module.
vi.mock('../../../src/main/turnChanges/ipc', () => ({registerTurnChangesIpc: () => {}}));
import {registerAgentSessionIpc} from '../../../src/main/ipc/agentSession';
import {invokeIpcChannel, registerScopedIpc, listIpcCapabilities, listIpcAudit, ipcPermissions} from '../../../src/main/ipc/handle';
import {LifecycleScope} from '../../../src/main/runtimeKernel/lifecycleScope';
vi.stubGlobal('window', globalThis);
const scopes: LifecycleScope[] = [], roots: string[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await scope.dispose();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});
const detailChannel = 'agentSession:injectionDetails', timelineChannel = 'agentSession:metadataTimeline';
function fixture() {
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-metadata-ipc-')); roots.push(mocks.root);
  const details = vi.fn(() => ({ok: true, snapshot: {at: 1, segments: []}}));
  const timeline = vi.fn(() => ({ok: true, page: {kind: 'injections', records: [], before: 0, total: 0, hasEarlier: false}}));
  const ctx = {agentSessions: {injectionDetails: details, metadataTimeline: timeline}} as unknown as AppContext;
  const scope = new LifecycleScope('ipc:gui-metadata'); scopes.push(scope);
  registerScopedIpc('gui-metadata', scope, () => registerAgentSessionIpc(ctx));
  return {scope, details, timeline};
}

it('uses the real scoped capability dispatcher and preserves positional metadata arguments', async () => {
  const {scope, details, timeline} = fixture();
  const ref = {key: 'a'.repeat(64)};
  await mocks.handlers.get(detailChannel)!({sender: {id: 7, isDestroyed: () => false}}, 'session', ref);
  expect(details).toHaveBeenCalledWith('session', ref);
  await invokeIpcChannel(timelineChannel, ['session', 'compactions', 240, 120]);
  expect(timeline).toHaveBeenCalledWith('session', 'compactions', 240, 120);
  for (const channel of [detailChannel, timelineChannel]) expect(listIpcCapabilities()).toContainEqual({
    id: channel, source: 'gui-metadata', permission: `ipc:${channel}`, auditTag: `gui-metadata:${channel}`
  });
  expect(JSON.stringify(listIpcAudit().slice(-2))).not.toContain(ref.key);
  await scope.dispose();
  for (const channel of [detailChannel, timelineChannel]) {
    expect(mocks.handlers.has(channel)).toBe(false);
    await expect(invokeIpcChannel(channel, [])).rejects.toThrow('无此通道');
  }
});

it('rejects disconnected callers and absent or revoked grants before reading history details', async () => {
  const {details, timeline} = fixture();
  const caller = {id: 'metadata-reader', kind: 'internal' as const, isAlive: () => true, permissions: [] as string[]};
  for (const channel of [detailChannel, timelineChannel]) {
    const args = channel === detailChannel ? ['session', {key: 'b'.repeat(64)}] : ['session', 'injections', undefined, 12];
    await expect(invokeIpcChannel(channel, args, caller)).rejects.toThrow('missing permission');
    await expect(invokeIpcChannel(channel, args, {...caller, isAlive: () => false})).rejects.toThrow('no longer connected');
    const permission = `ipc:${channel}`; ipcPermissions.revoke(permission);
    await expect(invokeIpcChannel(channel, args, {...caller, permissions: [permission]})).rejects.toThrow('not granted');
    ipcPermissions.grant(permission);
  }
  expect(details).not.toHaveBeenCalled(); expect(timeline).not.toHaveBeenCalled();
});
