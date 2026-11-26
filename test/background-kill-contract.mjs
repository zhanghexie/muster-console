import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'background-kill-'));
try {
  const compile = createSharedCompiler(process.cwd(), fixture);
  const ipcEntry = compile('main/ipc/backgroundTasks.ts');
  fs.writeFileSync(path.join(fixture, 'main/ipc/handle.mjs'), 'export function handle(name, fn) { globalThis.bgHandlers.set(name, fn); }');
  globalThis.bgHandlers = new Map();
  const { registerBgTasksIpc } = await import(pathToFileURL(ipcEntry));
  const { buildBgTaskTools } = await import(pathToFileURL(compile('main/agentSession/tools/backgroundTasks.ts')));
  let finish, fail, calls = [];
  const ctx = { bgTasks: { kill() { throw Error('synchronous kill must not report success'); }, killAndWait(id, initiator) { calls.push([id, initiator]); return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); } } };
  registerBgTasksIpc(ctx);
  const tool = buildBgTaskTools(ctx).find(tool => tool.id === 'bgtasks.kill');
  let settled = false;
  const ipc = globalThis.bgHandlers.get('bgTasks:kill')(null, 'a'); ipc.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); finish(true); assert.equal(await ipc, true);
  const result = tool.execute({ taskId: 'b', initiator: 'user' }, {});
  const rejected = assert.rejects(result, /owner close failed/);
  await Promise.resolve(); fail(Error('owner close failed')); await rejected;
  assert.deepEqual(calls, [['a', 'user'], ['b', 'user']]);
  console.log('background-kill-contract: OK (IPC/tool wait for real owner and propagate failures)');
} finally { delete globalThis.bgHandlers; fs.rmSync(fixture, { recursive: true, force: true }); }
