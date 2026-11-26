/**
 * 工作台 /status 快照格式化。
 * Run: node test/workbench-status.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-status-'));

const compile = createSharedCompiler(root, tmp);
const out = compile('shared/workbenchStatus.ts');
const { formatWorkbenchStatus, isVerboseStatusArg } = await import(pathToFileURL(out).href);

assert.equal(isVerboseStatusArg('v'), true);
assert.equal(isVerboseStatusArg('详细'), true);
assert.equal(isVerboseStatusArg('verbose'), true);
assert.equal(isVerboseStatusArg(''), false);
assert.equal(isVerboseStatusArg('brief'), false);

const snap = {
  workspaceName: 'Metaagent',
  workspaceCount: 2,
  agentBusy: false,
  agentSessionTitle: '修登录 bug',
  agentLastPreview: '已经改完了',
  agentMode: 'default',
  terminals: [
    {
      name: '会话气泡',
      runtime: 'claude-code',
      status: 'running',
      active: true,
      cwd: 'E:/metaagent-workbench',
      lifecycle: 'working',
      liveStatus: '改代码'
    },
    { name: 'shell', runtime: undefined, status: 'idle', active: false, cwd: 'E:/tmp' }
  ],
};

const brief = formatWorkbenchStatus(snap, 'brief');
assert.match(brief, /工作区：Metaagent/);
assert.match(brief, /调度：空闲 · 修登录 bug/);
assert.match(brief, /会话气泡 · claude-code · running/);
assert.match(brief, /当前/);
assert.doesNotMatch(brief, /E:\/metaagent-workbench/);
assert.doesNotMatch(brief, /飞书/);
assert.doesNotMatch(brief, /已经改完了/);

const verbose = formatWorkbenchStatus(snap, 'verbose');
assert.match(verbose, /E:\/metaagent-workbench/);
assert.match(verbose, /lifecycle：working/);
assert.doesNotMatch(verbose, /飞书/);
assert.match(verbose, /已经改完了/);
assert.match(verbose, /工作区数：2/);

assert.match(formatWorkbenchStatus({ ...snap, terminals: [] }, 'brief'), /终端：无/);
assert.match(formatWorkbenchStatus({ ...snap, agentBusy: true }, 'brief'), /调度：忙碌/);
assert.match(
  formatWorkbenchStatus({ ...snap, boundSession: { name: '绘画' } }, 'brief'),
  /绑定会话：绘画/
);
assert.doesNotMatch(brief, /绑定会话/);

console.log('[ok] workbench-status');
