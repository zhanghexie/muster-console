/**
 * 调度身份上下文（agentScope）：runAsSchedulerTool / isSchedulerInvocation 与
 * 既有 runAsAgentWorkspace 的行为契约。派活打标（SessionMeta.orchestrated）只认
 * 这个身份——用户 UI / ext-tool / Worker 路径不带，缺省必须为 false。
 *
 * 运行: node test/agent-scope.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scope-'));
const compile = createSharedCompiler(root, tmp);

const {
  currentAgentWorkspaceId,
  isSchedulerInvocation,
  runAsAgentWorkspace,
  runAsSchedulerTool
} = await import(pathToFileURL(compile('main/agent/agentScope.ts')).href);

// 缺省：不在任何上下文里——用户 UI / ext-tool / Worker 路径的默认态
assert.equal(isSchedulerInvocation(), false, '缺省不是调度调用');
assert.equal(currentAgentWorkspaceId(), undefined);

// 包裹内可读；await 穿透异步链（工具 handler → 派活管线全靠这条）
await runAsSchedulerTool(async () => {
  assert.equal(isSchedulerInvocation(), true, '包裹内是调度调用');
  await Promise.resolve();
  assert.equal(isSchedulerInvocation(), true, '异步链内身份保持');
});
assert.equal(isSchedulerInvocation(), false, '包裹外恢复缺省');

// 两个 ALS 互不干扰：调度身份不污染工作区上下文，反之亦然
await runAsAgentWorkspace('ws1', () =>
  runAsSchedulerTool(async () => {
    assert.equal(currentAgentWorkspaceId(), 'ws1', '工作区上下文保持');
    assert.equal(isSchedulerInvocation(), true);
  })
);
await runAsAgentWorkspace('ws2', () => {
  assert.equal(isSchedulerInvocation(), false, '仅工作区上下文不带调度身份');
});
console.log('ok: runAsSchedulerTool/isSchedulerInvocation 行为契约');

// 语义备注：上下文内调度的 setTimeout 回调**会**继承身份（Node 异步资源在调度时
// 捕获上下文）。delegate 队列 drain 丢身份的真正原因是 drain 链由槽位释放事件在
// 调度上下文**之外**发起——故 delegateQueue 仍需入队捕获旗标 + drain 重包，
// 端到端见 delegate-orchestration-flag.mjs。
await runAsSchedulerTool(
  () =>
    new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(isSchedulerInvocation(), true, '上下文内调度的定时器继承身份');
        resolve();
      }, 0);
    })
);
assert.equal(isSchedulerInvocation(), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('agent-scope: all ok');
