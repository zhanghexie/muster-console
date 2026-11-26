import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-continuation-runtime-'));
let log, detach, source;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = file => import(pathToFileURL(compile(file)).href);
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const { attachResumeWait } = await load('main/resumeWait/runtime.ts');
  const { DesktopContinuationSources } = await load('main/resumeWait/desktopSources.ts');
  const mailStore = await load('main/metaAgent/messageStore.ts');
  const data = path.join(temp, 'data');
  mailStore.setAgentMessagesUserDataDir(data);
  const worker = { id: 'worker', type: 'terminal', launchKind: 'agent', runtime: 'codex-gui', workspaceId: 'ws', lifecycle: 'idle' };
  const gui = [], scheduler = [];
  const ctx = {
    config: { get: () => ({}) },
    workspaces: { list: () => [{ id: 'ws', path: data }] }, desktopTurns: () => ({}),
    desktopEpochs: { currentBinding: () => ({ epoch: 'trusted-task', generation: 1 }) },
    sessions: { get: id => id === 'worker' ? worker : undefined, isChatRuntime: () => true,
      onLifecycle: () => () => {}, onPhaseFlip: () => () => {}, onSessionRemoved: () => () => {} },
    agentSessions: { isBusy: () => false, isOpen: () => true,
      getDriver: () => ({}),
      async send(id, text, _images, opts) { gui.push({ id, text, opts }); return { ok: true }; } },
    orchestrator: { isBusy: () => false, onEvent: () => () => {}, getHumanWait: () => null,
      async send(_text, _ws, _images, opts) {
        if (!opts.beforeStart()) { opts.onSkipped?.(); return; }
        const batch = await opts.notification.prepare();
        scheduler.push({ batch, delivery: opts.notification });
        await opts.notification.accepted(batch);
      } },
    notify: { push() {} }, pty: { getBufferTail() {} }
  };
  const attach = () => { log = new EventLog(data); ctx.eventRouter = new EventRouter(log, async () => {}); detach = attachResumeWait(ctx, data); };
  attach();
  const condition = { kind: 'time', at: '2026-01-01T00:00:00Z' };
  const first = ctx.resumeWait.arm('worker', 'ws', { condition, note: 'worker one' });
  const second = ctx.resumeWait.arm('worker', 'ws', { condition, note: 'worker two' });
  const sched = ctx.resumeWait.arm('orchestrator:ws', 'ws', { condition, note: 'scheduler wait' });
  source = new DesktopContinuationSources(path.join(data, 'desktop', 'continuation-sources.sqlite'));
  const guiOrigin = { owner: 'worker', workspaceId: 'ws', stopGeneration: 2 };
  const schedulerOrigin = { owner: 'orchestrator:ws', workspaceId: 'ws', stopGeneration: 2 };
  source.record(first, guiOrigin); source.record(second, guiOrigin); source.record(sched, schedulerOrigin);
  // Simulate a host restart before the waits fire: the source and queue are durable.
  detach(); detach = undefined; log.close(); log = undefined; source.close(); source = undefined;
  attach();
  await ctx.resumeWait.tick();
  assert.equal(gui.length, 1, 'same-owner waits share one GUI wake');
  assert.match(gui[0].text, /worker one/);
  assert.match(gui[0].text, /worker two/);
  assert.equal(gui[0].opts.desktopContinuation.allows(guiOrigin), true);
  assert.equal(gui[0].opts.desktopContinuation.allows({ ...guiOrigin, stopGeneration: 3 }), false);
  assert.equal(scheduler.length, 1);
  assert.equal(scheduler[0].delivery.desktopContinuation.allows(schedulerOrigin), true,
    'scheduler receives the same private guard outside the model text');
  assert.equal(scheduler[0].delivery.desktopContinuation.allows(guiOrigin), false);
  const db = new DatabaseSync(path.join(data, 'event-log.sqlite'));
  db.prepare('UPDATE resume_waits SET note=? WHERE id=?').run('tampered', second.id); db.close();
  assert.equal(gui[0].opts.desktopContinuation.allows(guiOrigin), false, 'one changed item freezes the full delivered batch');
  console.log('desktop continuation runtime: durable GUI/scheduler batch source forwarding passed');
} finally {
  detach?.(); source?.close(); log?.close();
  removeWorkspaceFixture(temp, 'desktop-continuation-runtime-');
}
