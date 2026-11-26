import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-event-tasks-'));
let manager, log;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = file => import(pathToFileURL(compile(file)).href);
  const { PromptTasksManager } = await load('main/tasks/manager.ts');
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const base = { workspaceId: 'w', runtime: 'cli', prompt: 'work', schedule: { kind: 'daily', time: '09:00' }, enabled: true, createdAt: 1 };
  let persisted = [ { ...base, id: 'old', name: 'old webhook', trigger: { kind: 'webhook' } },
    { ...base, id: 'old-file', name: 'old file', trigger: { kind: 'file', pathPattern: '**' } },
    { ...base, id: 'old-phase', name: 'old phase', trigger: { kind: 'phase', phase: 'done' } },
    { ...base, id: 'time', name: 'timer', trigger: { kind: 'time' } }, { ...base, id: 'plain', name: 'plain timer' } ];
  const removed = [];
  const store = { loadPromptTasks: () => structuredClone(persisted), savePromptTasks: data => { persisted = structuredClone(data); }, loadTaskRuns: () => [], saveTaskRuns: () => {} };
  const sessions = { list: () => ['old','old-file','old-phase','time','plain'].map(serviceId => ({ type: 'scheduled', serviceId })),
    removeScheduledSession: id => removed.push(id), createScheduledTaskSession: () => {}, updateScheduledTaskSession: () => {} };
  const config = { get: () => ({ activeWorkspaceId: 'w', workspaces: [{ id: 'w', path: tmp }] }) };
  manager = new PromptTasksManager(store, config, sessions, { get: () => ({ enabled: true }) });
  assert.deepEqual(manager.list().map(t => t.id), ['time', 'plain']);
  assert.deepEqual(persisted.map(t => t.id), ['time', 'plain']);
  assert.ok(persisted.every(t => !Object.hasOwn(t, 'trigger')));
  assert.deepEqual(removed.sort(), ['old','old-file','old-phase']);
  assert.equal(manager.timers.has('time'), true);
  assert.throws(() => manager.create({ ...base, name: 'not a timer', trigger: { kind: 'webhook' } }), /Unknown task option/);
  assert.throws(() => manager.update('time', { trigger: { kind: 'file', pathPattern: '**' } }), /Unknown task option/);
  assert.equal(manager.list().length, 2, 'unknown event options never create or change a timer');
  log = new EventLog(path.join(tmp, 'events.sqlite'));
  const now = Date.now();
  const legacy = log.subscribe({subject:'task:old',workspaceId:'w',source:'gitlab',types:[],scope:'',mode:'instant',createdAt:now,expiresAt:null,launchTaskId:'old'});
  const valid = log.subscribe({subject:'session',workspaceId:'w',source:'gitlab',types:[],scope:'',mode:'instant',createdAt:now,expiresAt:null});
  const delivered = [];
  const router = new EventRouter(log, async (sub) => { delivered.push(sub.subject); });
  router.publish({source:'gitlab',type:'issue',scope:'1',receivedAt:now,summary:'issue',payload:'{}'});
  await router.replay();
  assert.deepEqual(delivered, ['session']);
  assert.equal(log.subscriptions().some(s => s.id === legacy.id), false);
  assert.equal(log.subscriptions().some(s => s.id === valid.id), true);
  router.stop();
  const legacyOnDisk = log.subscribe({subject:'task:restart',workspaceId:'w',source:'file',types:[],scope:'',mode:'instant',createdAt:now,expiresAt:null,launchTaskId:'restart'});
  log.close();
  log = new EventLog(path.join(tmp, 'events.sqlite'));
  assert.equal(log.subscriptions().some(s => s.id === legacyOnDisk.id), false, 'startup removes old task-backed subscriptions');
  assert.equal(log.subscriptions().some(s => s.id === valid.id), true, 'startup keeps ordinary event subscriptions');
  console.log('event-task-retirement: old event tasks and subscriptions removed; time tasks and event delivery preserved');
} finally {
  manager?.stop(); log?.close(); fs.rmSync(tmp, { recursive: true, force: true });
}
