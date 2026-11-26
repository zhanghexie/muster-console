/** Real legacy session close must surface both cleanup failures in the chosen language. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cleanup-notify-'));
const originalLoader = Module._load, originalTs = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => temporary, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  if (request === './git/worktreeSessionOps') return { cleanupSessionWorktreeOnClose: async () => { throw new Error('Git 原始错误'); } };
  if (request === './workspaceRootUses') return { holdPendingSource: () => () => {} };
  if (request === './handover/paths') return { deleteSessionHandover: async () => {} };
  if (request === './turnChanges/cleanup') return { purgeTurnChangesForSessions: async () => {} };
  if (request === './turnChanges/runtime') return { turnChangesDir: () => temporary };
  return originalLoader.apply(this, arguments);
};
try {
  const { SessionsService } = require(path.join(root, 'src/main/sessions.ts'));
  const { GuiSessionDataCleanupError } = require(path.join(root, 'src/main/agentSession/cleanupError.ts'));
  const { applyLocaleSetting } = require(path.join(root, 'src/shared/i18n/index.ts'));
  const notices = [], row = { id: 'session', name: 'Session', type: 'terminal', runtime: 'pi', archived: true,
    cwd: temporary, workspaceId: 'ws', worktreePath: path.join(temporary, 'tree') };
  const service = Object.create(SessionsService.prototype);
  Object.assign(service, { sessions: [row], config: { get: () => ({ activeWorkspaceId: 'ws', workspaces: [{ id: 'ws', path: temporary }] }) },
    notify: { push: notice => notices.push(notice) }, isChatRuntime: () => true,
    chatBridge: { close: async () => { throw new GuiSessionDataCleanupError('原始历史错误'); } },
    rememberEnded() {}, notifySessionRemoved() {}, persist() {}, broadcast() {}, worktreeCtx: () => ({}),
    launchTasks: new Map(), launchGen: new Map(), classifyBySession: new Map(), ptyWorkingSince: new Map(), notifyBus: { clearSession() {} } });
  applyLocaleSetting('en');
  service.closeOne('session');
  const deadline = Date.now() + 3000;
  while (!notices.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].text, 'The session was removed from the list, but some data could not be cleaned up: 原始历史错误; worktree cleanup failed: Git 原始错误');
  applyLocaleSetting('zh-CN');
  notices.length = 0; service.sessions = [row];
  service.closeOne('session');
  const chineseDeadline = Date.now() + 3000;
  while (!notices.length && Date.now() < chineseDeadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(notices[0]?.text, '会话已从列表移除，但部分数据清理失败：原始历史错误；worktree 清理失败：Git 原始错误');
  console.log('session cleanup notification i18n: real close path retained both errors');
} finally {
  Module._load = originalLoader; require.extensions['.ts'] = originalTs;
  assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
}
