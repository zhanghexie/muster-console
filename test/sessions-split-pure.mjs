/**
 * sessions.ts 拆分纯函数单测（2026-09-26 sessions.ts → sessions/createTerminal.ts +
 * git/worktreeSessionOps.ts + git/worktreeIntegrate.ts 拆分的回归锁）：
 * - 多根目标解析另由 session-source-targets.mjs 覆盖（真实目录校验）
 * - shellSessionName / buildShellTerminalSession / buildAgentTerminalSession：会话行构建
 * - applyInheritMeta：GUI Worker 会话初始态落到 SessionMeta
 * - describeNestedKeep / acceptanceNoteFor：通知文案与验收备注输入（通知中心/账本合同）
 * 运行: node test/sessions-split-pure.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('module');

// .ts 即时转译（CJS）+ electron stub：与 host-split-pure 同一套路
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: filename
  });
  module._compile(outputText, filename);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => os.tmpdir(), isReady: () => true },
      ipcMain: { handle: () => {}, on: () => {} }
    };
  }
  return origLoad.apply(this, arguments);
};

const createTerminal = require(path.join(root, 'src/main/sessions/createTerminal.ts'));
const ops = require(path.join(root, 'src/main/git/worktreeSessionOps.ts'));
const integrate = require(path.join(root, 'src/main/git/worktreeIntegrate.ts'));

// ---------- shellSessionName：区内首个用标签，重名加序号 ----------
{
  assert.equal(createTerminal.shellSessionName(undefined, 0, 'Git Bash'), 'Git Bash');
  assert.equal(createTerminal.shellSessionName(undefined, 1, 'Git Bash'), 'Git Bash 2');
  assert.equal(createTerminal.shellSessionName(undefined, 9, 'PowerShell'), 'PowerShell 10');
  assert.equal(createTerminal.shellSessionName('我的会话', 5, 'Git Bash'), '我的会话', '显式命名优先');
}

// ---------- buildShellTerminalSession：字段形状与 hidden 条件展开 ----------
{
  const s = createTerminal.buildShellTerminalSession({
    id: 'id-1',
    now: 1000,
    statusToken: 'tok-1',
    inWs: 1,
    label: 'Git Bash',
    shellProfileId: 'gitbash',
    cwd: 'E:/x',
    workspaceId: 'ws-main',
    meta: { a: 'b' }
  });
  assert.equal(s.id, 'id-1');
  assert.equal(s.type, 'terminal');
  assert.equal(s.name, 'Git Bash 2');
  assert.equal(s.createdAt, 1000);
  assert.equal(s.lastUsedAt, 1000);
  assert.equal(s.launchKind, 'shell');
  assert.equal(s.shellProfileId, 'gitbash');
  assert.equal(s.cwd, 'E:/x');
  assert.equal(s.workspaceId, 'ws-main');
  assert.equal(s.status, 'starting');
  assert.equal(s.lifecycle, 'starting');
  assert.equal(s.statusToken, 'tok-1');
  assert.deepEqual(s.meta, { a: 'b' });
  assert.ok(!('hidden' in s), 'hidden 缺省不落键');

  const h = createTerminal.buildShellTerminalSession({
    id: 'id-2',
    now: 1000,
    statusToken: 'tok-2',
    inWs: 0,
    label: 'Git Bash',
    shellProfileId: 'gitbash',
    cwd: 'E:/x',
    workspaceId: 'ws-main',
    hidden: true
  });
  assert.equal(h.hidden, true, 'hidden=true 落键');
  const nh = createTerminal.buildShellTerminalSession({
    id: 'id-3',
    now: 1000,
    statusToken: 'tok-3',
    inWs: 0,
    label: 'Git Bash',
    shellProfileId: 'gitbash',
    cwd: 'E:/x',
    workspaceId: 'ws-main',
    hidden: false
  });
  assert.ok(!('hidden' in nh), 'hidden=false 与缺省同形（不落键）');
}

// ---------- buildAgentTerminalSession：worktree 字段占位 + 默认命名 ----------
{
  const s = createTerminal.buildAgentTerminalSession({
    id: 'ag-1',
    now: 2000,
    statusToken: 'tok-a',
    inWs: 2,
    runtime: 'claude-code',
    cwd: 'E:/repos/main/.worktrees/abc12345',
    workspaceId: 'ws-main'
  });
  assert.equal(s.launchKind, 'agent');
  assert.equal(s.runtime, 'claude-code');
  assert.equal(s.name, '工作面板 3', '缺省命名 = 工作面板 {{inWs+1}}');
  assert.ok('worktreePath' in s && s.worktreePath === undefined, 'worktree 字段 undefined 占位（与原字面量同形）');
  assert.ok(!('worktreeRepoSet' in s), 'repoSet 空不落键');
  assert.equal(s.status, 'starting');
  assert.equal(s.lifecycle, 'starting');

  const iso = createTerminal.buildAgentTerminalSession({
    id: 'ag-2',
    now: 2000,
    statusToken: 'tok-b',
    name: '隔离活',
    inWs: 0,
    runtime: 'pi',
    cwd: 'E:/c',
    workspaceId: 'ws-main',
    worktreePath: 'E:/repos/main/.worktrees/abc12345',
    worktreeBranch: 'ao/abc12345',
    worktreeBaseBranch: 'main',
    worktreeRepoSet: [{ path: 'Plugins/Nested', branch: 'ao/def67890' }]
  });
  assert.equal(iso.name, '隔离活');
  assert.equal(iso.worktreePath, 'E:/repos/main/.worktrees/abc12345');
  assert.equal(iso.worktreeBranch, 'ao/abc12345');
  assert.equal(iso.worktreeBaseBranch, 'main');
  assert.deepEqual(iso.worktreeRepoSet, [{ path: 'Plugins/Nested', branch: 'ao/def67890' }]);

  const emptySet = createTerminal.buildAgentTerminalSession({
    id: 'ag-3',
    now: 2000,
    statusToken: 'tok-c',
    inWs: 0,
    runtime: 'pi',
    cwd: 'E:/c',
    workspaceId: 'ws-main',
    worktreeRepoSet: []
  });
  assert.ok(!('worktreeRepoSet' in emptySet), 'repoSet=[] 同缺省（不落键）');
}

// ---------- applyInheritMeta：GUI 会话初始态（引擎按字段缺省回落） ----------
{
  const override = { providerId: 'p1', modelId: 'm1' };
  const s1 = createTerminal.buildAgentTerminalSession({
    id: 'g-1',
    now: 1,
    statusToken: 't',
    inWs: 0,
    runtime: 'pi',
    cwd: 'E:/c',
    workspaceId: 'ws-main'
  });
  createTerminal.applyInheritMeta(s1, {
    piModeId: 'mode-x',
    guiMode: 'auto',
    modelOverride: override,
    thinkingLevel: 'high'
  });
  assert.equal(s1.piModeId, 'mode-x');
  assert.equal(s1.guiMode, 'auto');
  assert.deepEqual(s1.modelOverride, { providerId: 'p1', modelId: 'm1' });
  assert.notEqual(s1.modelOverride, override, 'modelOverride 必须拷贝（防共享可变引用）');
  assert.equal(s1.thinkingLevel, 'high');

  // 部分继承 + 空串不落：未给的键保持 undefined
  const s2 = createTerminal.buildAgentTerminalSession({
    id: 'g-2',
    now: 1,
    statusToken: 't',
    inWs: 0,
    runtime: 'pi',
    cwd: 'E:/c',
    workspaceId: 'ws-main'
  });
  createTerminal.applyInheritMeta(s2, { piModeId: '', guiMode: 'default' });
  assert.equal(s2.piModeId, undefined, '空串 piModeId 不赋值');
  assert.equal(s2.guiMode, 'default');
  assert.equal(s2.modelOverride, undefined);
  assert.equal(s2.thinkingLevel, undefined);
}

// ---------- describeNestedKeep：逐仓收尾保留原因（通知文案合同） ----------
{
  assert.equal(ops.describeNestedKeep('unmerged'), '分支未合入');
  assert.equal(ops.describeNestedKeep('dirty'), '有未提交改动');
  assert.equal(ops.describeNestedKeep('error', 'exit 128'), '清理失败：exit 128');
  assert.equal(ops.describeNestedKeep('error'), '清理失败：未知');
}

// ---------- acceptanceNoteFor：approval=auto 的验收账本备注 ----------
{
  assert.deepEqual(integrate.acceptanceNoteFor({ approval: 'auto', confirmNote: '  已验  ' }), {
    acceptanceNote: '已验'
  });
  assert.deepEqual(integrate.acceptanceNoteFor({ approval: 'auto', confirmNote: '   ' }), {});
  assert.deepEqual(integrate.acceptanceNoteFor({ approval: 'auto' }), {});
}

// ---------- 常量：重试节奏与归档延时（时序合同） ----------
assert.deepEqual(ops.WORKTREE_RELEASE_DELAYS_MS, [0, 600, 1600, 3200]);
assert.equal(integrate.INTEGRATE_ARCHIVE_DELAY_MS, 2500);

console.log('[ok] sessions-split-pure');
