import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-wait-host-'));
let store;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = file => import(pathToFileURL(compile(file)).href);
  const { ResumeWaitStore } = await load('main/resumeWait/store.ts');
  const { ResumeWaitService } = await load('main/resumeWait/service.ts');
  const { resumeWaitHost } = await load('main/capabilities/hosts/resumeWait.ts');
  const { runAsAgentWorkspace, runAsSchedulerTool } = await load('main/agent/agentScope.ts');
  store = new ResumeWaitStore(path.join(tmp, 'data'));
  const service = new ResumeWaitService(store, { now: () => 100, isBusy: () => false,
    deliver: async () => ({ status: 'submitted' }), alert() {} });
  const ctx = { resumeWait: service, sessions: { get: id => id === 'worker' ? { id, workspaceId: 'ws' } : undefined },
    resolveBubbleWorkspaceId: () => 'wrong-workspace' };
  const invoke = args => resumeWaitHost.waitFor(ctx, { __actorSessionId: 'worker', ...args });
  const event = invoke({ condition: { kind: 'event', source: 'gitlab' }, note: 'follow up' });
  assert.equal(event.ok, true);
  assert.deepEqual(store.get(event.id).condition, { kind: 'event', source: 'gitlab', types: [], scope: '' },
    'an optional event scope survives both host and service validation');
  assert.equal(store.get(event.id).owner, 'worker');
  assert.equal(store.get(event.id).workspaceId, 'ws');
  assert.throws(() => invoke({ subject: 'other', condition: { kind: 'mail' }, note: '' }), /only the calling session/);
  assert.throws(() => invoke({ owner: 'other', condition: { kind: 'mail' }, note: '' }), /only the calling session/);
  assert.throws(() => resumeWaitHost.waitFor(ctx, { condition: { kind: 'mail' }, note: '' }), /managed session/);
  const scheduler = await runAsAgentWorkspace('ws', () => runAsSchedulerTool(async () =>
    resumeWaitHost.waitFor(ctx, { condition: { kind: 'mail', from: 'scheduler' }, note: 'continue' })));
  assert.equal(store.get(scheduler.id).owner, 'orchestrator:ws');
  assert.deepEqual(store.get(scheduler.id).condition, { kind: 'mail', from: 'orchestrator:ws' });
} finally { store?.close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
console.log('resume-wait-host: ok');
