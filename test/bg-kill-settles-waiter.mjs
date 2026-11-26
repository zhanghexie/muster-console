import { installFakeOwnedBackground } from './helpers/background-pty.mjs';
/**
 * bgtasks kill 解套回归（审计 background-tasks F-01，2026-10-26 修复）：
 * runShellWithTimeout 等待期间被 kill（面板「终止」）时，工具 Promise 必须以
 * 明确终止语义 settle（ok:false+文案），不得永挂让模型回合卡死。
 * 真实子进程等待 + kill 竞速断言。还原修复即红（Promise 3 秒不落定）。
 * 运行: node test/bg-kill-settles-waiter.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-kill-'));
const compile = createSharedCompiler(root, tmp);
const load = (rel) => import(pathToFileURL(compile(rel)).href);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { BackgroundTaskManager } = await load('main/agentSession/background/manager.ts');
  const userDir = path.join(tmp, 'ud');
  fs.mkdirSync(userDir, { recursive: true });
  // 假 pty（与 test/bg-tasks.mjs 的 shellTask 段同款）：kill 摘回调的语义走真实 shellTask 实现
  const exitListeners = new Set();
  const fakeCtx = {
    getWindow: () => null,
    config: { get: () => ({ workspaces: [{ id: 'w', path: userDir }], activeWorkspaceId: 'w', shell: { bgShellMode: 'auto' } }) },
    sessions: { get: (id) => ({ id, name: 'kill fixture', workspaceId: 'w', cwd: userDir }) },
    pty: {
      addExitListener: (fn) => { exitListeners.add(fn); return () => exitListeners.delete(fn); },
      spawn: () => undefined,
      getBuffer: () => '',
      killAndWait: async () => undefined,
      kill: () => undefined
    },
    agentSessions: undefined
  };
  installFakeOwnedBackground(fakeCtx.pty);
  const mgr = new BackgroundTaskManager(fakeCtx, { userDataDir: userDir });

  const p = mgr.runShellWithTimeout('s1', userDir, 'echo waiting', 'kill-wait', false, undefined, 25000);

  // 等任务进入 running（Windows 拉起有延迟）
  let taskId = null;
  for (let i = 0; i < 100 && !taskId; i++) {
    await delay(100);
    taskId = mgr.listFor('s1').find((t) => t.status === 'running')?.id ?? null;
  }
  assert.ok(taskId, '任务应进入 running');

  const ok1 = mgr.kill(taskId, 'user');
  assert.equal(ok1, true, 'kill 成功');

  const loser = delay(3000).then(() => { throw new Error('等待中的工具 Promise 在 kill 后 3 秒仍未落定（永挂）'); });
  const result = await Promise.race([p, loser]);
  assert.equal(result.ok, false, 'kill 后必须以失败语义收口（不伪造成功）');
  assert.match(result.error, /终止/, `错误文案含终止语义，实际: ${result.error}`);
  console.log('bg-kill-settles-waiter: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
