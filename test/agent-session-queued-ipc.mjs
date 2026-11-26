/**
 * X4-F04：agentSession:cancelQueued/editQueued/reorderQueued 通道合同 = {ok,error?}。
 * - 宿主未就绪（ctx.agentSessions 空）：三通道必须回 {ok:false,error}（带「未就绪」文案），
 *   不得返回裸 false（false 三义混淆：未就绪/消息不在队/被拒不可区分，渲染层无从反馈）。
 * - 宿主就绪：host 布尔结果包进 {ok:...}，false（消息已不在队/顺序未变等良性场景）不带 error。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-session-queued-ipc-'));
const handlers = new Map();
const originalLoad = Module._load;
const originalTsLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  });
  module._compile(outputText, filename);
};
Module._load = function (name) {
  if (name === 'electron') return {
    app: { getPath: () => profile },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
  };
  return originalLoad.apply(this, arguments);
};

try {
  const { registerAgentSessionIpc } = require('../src/main/ipc/agentSession.ts');
  const ctx = { agentSessions: undefined };
  registerAgentSessionIpc(ctx);
  const event = { sender: { id: 1, isDestroyed: () => false } };
  const cases = [
    ['cancelQueued', { sessionId: 's1', messageId: 'm1' }, ['s1', 'm1']],
    ['editQueued', { sessionId: 's1', messageId: 'm1', text: 'x' }, ['s1', 'm1', 'x']],
    ['reorderQueued', { sessionId: 's1', orderedIds: ['m2', 'm1'] }, ['s1', ['m2', 'm1']]]
  ];
  for (const [method, args, expectedArgs] of cases) {
    const channel = `agentSession:${method}`;
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} 已注册`);

    ctx.agentSessions = undefined;
    assert.deepEqual(await handler(event, args), { ok: false, error: 'GUI 会话宿主未就绪' }, channel);

    for (const ok of [true, false]) {
      ctx.agentSessions = { [method]: (...received) => {
        assert.deepEqual(received, expectedArgs, channel);
        return ok;
      } };
      assert.deepEqual(await handler(event, args), { ok }, channel);
    }
  }
  console.log('agent-session-queued-ipc: 排队三通道 {ok,error?} 合同全部通过');
} finally {
  Module._load = originalLoad;
  if (originalTsLoader) require.extensions['.ts'] = originalTsLoader;
  else delete require.extensions['.ts'];
  fs.rmSync(profile, { recursive: true, force: true });
}
