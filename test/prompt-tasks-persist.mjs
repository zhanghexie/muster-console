/**
 * P9：prompt-tasks 注册表同步落盘 + bak 对账。
 * 运行: node test/prompt-tasks-persist.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-'));
const compile = createSharedCompiler(root, tmp);

const { loadRegistryJson, saveRegistryJson } = await import(
  pathToFileURL(compile('main/jsonRegistry.ts')).href
);
const { PromptTasksManager } = await import(pathToFileURL(compile('main/tasks/manager.ts')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-ud-'));

function fileStore() {
  return {
    loadPromptTasks: () => loadRegistryJson(dir, 'prompt-tasks.json', []),
    savePromptTasks: (next) => saveRegistryJson(dir, 'prompt-tasks.json', next),
    loadTaskRuns: () => loadRegistryJson(dir, 'task-runs.json', []),
    saveTaskRuns: (next) => saveRegistryJson(dir, 'task-runs.json', next),
  };
}

const config = { get: () => ({ activeWorkspaceId: 'ws-a', workspaces: [{ id: 'ws-a', path: tmp }] }) };
const sessions = {
  list: () => [],
  createScheduledTaskSession: () => {},
  updateScheduledTaskSession: () => {},
  removeScheduledSession: () => {},
  touchScheduledSession: () => {},
  isChatRuntime: () => false,
  createTerminal: async () => ({ id: 'sess' })
};
const runtimes = {
  entries: { 'cursor-cli': { id: 'cursor-cli', enabled: true } },
  get(id) {
    return this.entries[id];
  }
};

const mgr1 = new PromptTasksManager(fileStore(), config, sessions, runtimes);
const created = mgr1.create({
  name: '调度巡视',
  runtime: 'cursor-cli',
  prompt: '巡视',
  schedule: { kind: 'interval', intervalMinutes: 20 },
  enabled: true,
  mode: 'terminal'
});
assert.equal(created.enabled, true);
mgr1.stop();

const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'prompt-tasks.json'), 'utf8'));
assert.equal(onDisk.length, 1);
assert.equal(onDisk[0].enabled, true);
assert.ok(fs.existsSync(path.join(dir, 'prompt-tasks.bak.json')));

const mgr2 = new PromptTasksManager(fileStore(), config, sessions, runtimes);
const listed = mgr2.list('ws-a');
assert.equal(listed.length, 1);
assert.equal(listed[0].id, created.id);
assert.equal(listed[0].enabled, true);
assert.ok(mgr2.timers.has(created.id), '重启对账后 enabled 任务必须重新 arm');
mgr2.stop();
console.log('ok: 写盘 → 新建 manager → 任务仍在且 enabled+armed');

fs.writeFileSync(path.join(dir, 'prompt-tasks.json'), '{not-json', 'utf8');
const restored = loadRegistryJson(dir, 'prompt-tasks.json', []);
assert.equal(restored.length, 1);
assert.equal(restored[0].name, '调度巡视');
console.log('ok: 主文件损坏时从 bak 恢复');
