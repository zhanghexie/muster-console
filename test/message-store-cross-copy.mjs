/**
 * 回归：生产构建会把 messageStore 打进多个副本（index.ts 与 resumeWait/messages 的
 * import 边界各一份）。曾出现「index.ts 注入了副本 A、attachResumeWait.scanMail 读副本 B」，
 * B 抛「[messageStore] userData 目录未注入」→ 整条启动链中断 → 所有 IPC handler 未注册，
 * 窗口出来却是空壳。注入目录必须是进程级单例，跨副本可见。
 *
 * 运行: node test/message-store-cross-copy.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'message-store-cross-copy-'));
let resetMessageStoreChainsForTest = () => {};
try {
  const compile = createSharedCompiler(repo, tmp);
  const url = pathToFileURL(compile('main/metaAgent/messageStore.ts')).href;
  // 同一份编译产物按不同 URL 加载两次 = 两个互不相通的模块实例，等价于打包里的两个副本。
  const writer = await import(url);
  const reader = await import(`${url}?copy=2`);
  resetMessageStoreChainsForTest = writer.resetMessageStoreChainsForTest;

  const dir = path.join(tmp, 'userData');
  writer.setAgentMessagesUserDataDir(dir);
  await writer.appendAgentMessageToStore(dir, 'ws-a', {
    id: 'm-1', from: 'host', to: 'scheduler', kind: 'notice', text: 'seed', ts: 1, receipt: 'stored'
  });

  assert.deepEqual(reader.listAgentMessageWorkspaceIds(), ['ws-a'],
    '另一个模块副本必须看到同一份 userData 注入');
  assert.equal(reader.agentMessagesFilePath('ws-a').startsWith(dir), true,
    '另一个模块副本的路径解析必须落在同一目录');
  console.log('message-store-cross-copy: ok');
} finally {
  resetMessageStoreChainsForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
}
