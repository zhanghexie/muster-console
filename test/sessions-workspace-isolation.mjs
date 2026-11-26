/**
 * sessions 列表的工作区隔离：驱动真 SessionsService.listForAgent / listByWorkspace /
 * resolveWorkspaceId（经 prototype.call），覆盖 legacy 行的唯一匹配归属与区内 active 回落。
 * 纯函数层（legacySessionWorkspaceId 歧义/区外语义）由 session-source-targets.mjs 覆盖，此处不重复。
 * 自查：把 listForAgent 的区内回落去掉、或把 legacySessionWorkspaceId 改回旧「歧义/区外回落活动区」行为，本文件应转红。
 * Run: node test/sessions-workspace-isolation.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const { SessionsService } = require(path.join(repo, 'src/main/sessions.ts'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-ws-iso-'));
try {
  const dirA = path.join(tmp, 'a');
  const dirB = path.join(tmp, 'b');
  const subA = path.join(dirA, 'sub');
  const outside = path.join(tmp, 'outside');
  for (const dir of [dirA, dirB, subA, outside]) fs.mkdirSync(dir);

  const cfg = {
    workspaces: [
      { id: 'ws-a', path: dirA, roots: [{ id: 'ra', path: dirA }] },
      { id: 'ws-b', path: dirB, roots: [{ id: 'rb', path: dirB }] }
    ]
  };

  // legacy-a 无显式 workspaceId，唯一落在 ws-a；orphan 在所有区之外（解析为 ''，不回落活动区）
  const rows = [
    { id: 't-a1', type: 'terminal', workspaceId: 'ws-a', cwd: dirA, archived: false },
    { id: 'legacy-a', type: 'terminal', cwd: subA, archived: false },
    { id: 'sch-a1', type: 'scheduled', workspaceId: 'ws-a' },
    { id: 't-b1', type: 'terminal', workspaceId: 'ws-b', cwd: dirB, archived: false },
    { id: 'sch-b1', type: 'scheduled', workspaceId: 'ws-b' },
    { id: 'orphan', type: 'terminal', cwd: outside, archived: false }
  ];

  const mgr = {
    sessions: rows,
    activeId: null,
    list: () => rows,
    get: (id) => rows.find((r) => r.id === id),
    listByWorkspace: SessionsService.prototype.listByWorkspace,
    resolveWorkspaceId: SessionsService.prototype.resolveWorkspaceId,
    config: { get: () => cfg }
  };

  const resolveWs = (cwd) => SessionsService.prototype.resolveWorkspaceId.call(mgr, cwd);
  assert.equal(resolveWs(subA), 'ws-a', 'legacy 路径唯一落在 ws-a');
  assert.equal(resolveWs(outside), '', '区外会话不归属任何工作区（含不回落活动区）');

  const a = SessionsService.prototype.listForAgent.call(mgr, 'ws-a');
  assert.deepEqual(
    a.sessions.map((s) => s.id),
    ['t-a1', 'legacy-a', 'sch-a1'],
    'ws-a 应只含本区 terminal/scheduled（legacy 行经真 resolveWorkspaceId 归队）'
  );
  assert.ok(!a.sessions.some((s) => s.id === 'orphan'), '区外行不得混入任何区');

  const b = SessionsService.prototype.listForAgent.call(mgr, 'ws-b');
  assert.deepEqual(
    b.sessions.map((s) => s.id),
    ['t-b1', 'sch-b1']
  );

  // global active 在 B 区时，A 区 activeId 应回落 A 内首个未归档 terminal
  mgr.activeId = 't-b1';
  assert.equal(
    SessionsService.prototype.listForAgent.call(mgr, 'ws-a').activeId,
    't-a1',
    'global active 不在区内 → 回落区内首个 terminal'
  );
  assert.equal(SessionsService.prototype.listForAgent.call(mgr, 'ws-b').activeId, 't-b1', 'global active 在本区内 → 原样返回');

  // global active 是 legacy 行（无显式 workspaceId）时，经真 resolveWorkspaceId 判区后原样返回
  mgr.activeId = 'legacy-a';
  assert.equal(
    SessionsService.prototype.listForAgent.call(mgr, 'ws-a').activeId,
    'legacy-a',
    'legacy active 解析入区后应原样返回'
  );

  // View dismissal never removes/archives a session or overwrites a newer selection.
  let persisted = 0, broadcasts = 0;
  const view = { activeId: 't-a1', sessions: rows, config: { get: () => ({ activeWorkspaceId: 'ws-a' }) },
    lastActiveByWs: new Map([['ws-a', 't-a1'], ['ws-b', 't-b1']]),
    persist: () => persisted++, broadcast: () => broadcasts++ };
  assert.equal(SessionsService.prototype.deselect.call(view, 't-b1'), false);
  assert.equal(view.activeId, 't-a1'); assert.equal(persisted, 0);
  const before = JSON.stringify(rows);
  assert.equal(SessionsService.prototype.deselect.call(view, 't-a1'), true);
  assert.equal(view.activeId, null); assert.equal(view.lastActiveByWs.has('ws-a'), false);
  assert.equal(view.lastActiveByWs.get('ws-b'), 't-b1');
  assert.equal(JSON.stringify(rows), before); assert.equal(persisted, 1); assert.equal(broadcasts, 1);
  assert.equal(SessionsService.prototype.deselect.call(view, 't-a1'), false);
  assert.equal(broadcasts, 1);
  console.log('sessions-workspace-isolation: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
