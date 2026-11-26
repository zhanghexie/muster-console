import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-source-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const { PromptTasksManager } = await import(pathToFileURL(compile('main/tasks/manager.ts')).href);
const { servicesHost } = await import(pathToFileURL(compile('main/capabilities/hosts/services.ts')).href);
const { resolveSessionTarget } = await import(pathToFileURL(compile('main/sessions/targets.ts')).href);
const a = path.join(fixture, 'a'); const b = path.join(fixture, 'b'); const c = path.join(fixture, 'c');
for (const dir of [a, b, c]) fs.mkdirSync(dir);
const workspace = { id: 'multi', path: b, controlRoot: a, rootsRevision: 9, defaultRootId: 'b',
  roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
const cfg = { workspaces: [workspace, { id: 'single', path: c }], activeWorkspaceId: 'multi',
  agentRules: [{ id: 'fixture', text: 'Scheduled CLI rule', enabled: true }] };
let diskTasks = []; let diskRuns = []; const created = []; const projections = [];
let createGate; const guiPrompts = [];
const store = {
  loadPromptTasks: () => structuredClone(diskTasks), savePromptTasks: tasks => { diskTasks = structuredClone(tasks); },
  loadTaskRuns: () => structuredClone(diskRuns), saveTaskRuns: runs => { diskRuns = structuredClone(runs); }
};
const sessions = {
  list: () => [], removeScheduledSession: () => {}, touchScheduledSession: () => {},
  createScheduledTaskSession: task => { projections.push(structuredClone(task.sourceRoot)); },
  updateScheduledTaskSession: () => {}, isChatRuntime: runtime => runtime === 'pi',
  createTerminal: async input => {
    await createGate?.();
    const target = await resolveSessionTarget(cfg, input);
    const session = { id: `session-${created.length}`, runtime: input.runtime, cwd: target.cwd,
      workspaceId: target.workspaceId, sourceRoot: target.sourceRoot, prompt: input.initialPrompt };
    created.push(session); return session;
  }
};
const runtimes = { get: id => ({ id, enabled: true }) };
const config = { get: () => cfg };
const makeManager = () => {
  const manager = new PromptTasksManager(store, config, sessions, runtimes);
  manager.bindGuiHost({ send: async (id, prompt) => { guiPrompts.push({ id, prompt }); return { ok: true }; } });
  return manager;
};
const opts = { name: 'service', runtime: 'pi', prompt: 'original prompt', schedule: { kind: 'interval', intervalMinutes: 60 } };
let mgr = makeManager();
try {
  const task = mgr.create(opts);
  assert.equal(task.sourceRoot.rootId, 'b'); assert.equal(projections.at(-1).cwd, b);
  workspace.defaultRootId = 'a'; workspace.path = a; workspace.rootsRevision++;
  cfg.activeWorkspaceId = 'single';
  await mgr.runNow(task.id);
  assert.equal(created.at(-1).cwd, b); assert.equal(created.at(-1).workspaceId, 'multi');
  mgr.update(task.id, { prompt: 'edited' });
  assert.equal(task.sourceRoot.rootId, 'b');
  mgr.stop(); mgr = makeManager();
  await mgr.runNow(task.id);
  assert.equal(created.at(-1).cwd, b, 'restart and default changes must retain the persisted source');
  console.log('ok: create/update/default changes/restart pin a scheduled source');

  const before = JSON.stringify(mgr.get(task.id));
  assert.throws(() => mgr.update(task.id, { rootId: 'a', rootsRevision: 9, prompt: 'bad' }), /changed/);
  assert.equal(JSON.stringify(mgr.get(task.id)), before, 'failed retarget must not partially mutate the definition');
  const count = created.length;
  workspace.roots = workspace.roots.filter(root => root.id !== 'b');
  await assert.rejects(() => mgr.runNow(task.id), /source folder not found/);
  assert.equal(created.length, count); assert.equal(mgr.listRuns(task.id)[0].status, 'error');
  assert.throws(() => mgr.enable(task.id), /source folder not found/);
  workspace.roots.push({ id: 'b', path: b });
  const link = path.join(fixture, 'source-alias'); fs.symlinkSync(b, link, 'junction');
  workspace.roots.push({ id: 'link', path: link }); workspace.rootsRevision++;
  const linked = mgr.create({ ...opts, workspaceId: 'multi', rootId: 'link' });
  fs.unlinkSync(link); fs.symlinkSync(c, link, 'junction');
  await assert.rejects(() => mgr.runNow(linked.id), /changed or was removed/);
  assert.equal(created.length, count);
  mgr.delete(linked.id);
  console.log('ok: stale updates/removal/Junction retarget reject without creating a session');

  let release;
  createGate = () => new Promise(resolve => { release = resolve; });
  const pending = mgr.runNow(task.id);
  await Promise.resolve();
  assert.throws(() => mgr.update(task.id, { rootId: 'a' }), /is starting/);
  mgr.update(task.id, { prompt: 'next prompt', runtime: 'shell' });
  createGate = undefined; release(); await pending;
  assert.equal(created.at(-1).prompt, 'edited');
  assert.equal(guiPrompts.at(-1).prompt, 'edited', 'GUI injection uses the same captured prompt/runtime');
  mgr.update(task.id, { rootId: 'a' });
  await mgr.runNow(task.id); assert.equal(created.at(-1).cwd, a);
  console.log('ok: in-flight source changes reject and the original GUI run keeps its snapshot');

  const ctx = { tasks: mgr, runtimes, resolveBubbleWorkspaceId: () => 'multi' };
  const result = await servicesHost['automations.create'](ctx, { ...opts, schedule: undefined,
    rootId: 'b', rootsRevision: workspace.rootsRevision, delayMinutes: 60 });
  assert.equal(result.task.sourceRoot.rootId, 'b'); assert.equal(result.task.schedule.kind, 'once');
  assert.equal(result.task.delayMinutes, 60);
  await servicesHost['automations.update'](ctx, { automationId: result.task.id, rootId: 'a' });
  assert.equal(mgr.get(result.task.id).sourceRoot.rootId, 'a');
  console.log('ok: actual automation hosts forward source identity and relative schedules');

  const cliTask = mgr.create({ ...opts, workspaceId: 'multi', rootId: 'b', runtime: 'codex', prompt: 'scheduled CLI input' });
  await mgr.runNow(cliTask.id);
  assert.equal(created.at(-1).cwd, b);
  assert.match(created.at(-1).prompt, /Task: scheduled CLI input/);
  assert.match(created.at(-1).prompt, /Scheduled CLI rule/);
  assert.doesNotMatch(created.at(-1).prompt, /HOST(?:-EXT)?\.md/);

  mgr.stop();
  diskTasks = [{ ...opts, id: 'legacy-single', workspaceId: 'single', enabled: true, createdAt: 1 },
    { ...opts, id: 'legacy-multi', workspaceId: 'multi', enabled: true, createdAt: 1 }];
  mgr = makeManager();
  assert.equal(mgr.get('legacy-single').sourceRoot.rootId, 'root-single');
  assert.equal(mgr.get('legacy-multi').enabled, false);
  assert.match(mgr.get('legacy-multi').lastError, /selection required/);
  mgr.update('legacy-multi', { rootId: 'b' }); mgr.enable('legacy-multi');
  await mgr.runNow('legacy-multi'); assert.equal(created.at(-1).cwd, b);
  console.log('ok: legacy single sources migrate; ambiguous legacy tasks stay disabled until selected');
} finally {
  mgr.stop();
}
console.log('prompt-task-source: OK');
