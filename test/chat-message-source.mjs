/** 历史来源身份和 GUI 消息构造；当前宿主收信提醒必须保持 host 身份。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-src-'));
const compile = createSharedCompiler(root, tmp);

const src = await import(pathToFileURL(compile('shared/chatMessageSource.ts')).href);
const gui = await import(pathToFileURL(compile('shared/guiWorker.ts')).href);

{
  assert.equal(src.isSchedulerMessageSource('scheduler'), true);
  assert.equal(src.isSchedulerMessageSource(undefined), false);
}

{
  const typed = gui.createGuiUserMessage({ id: 'u', text: '你好', ts: 1 });
  assert.equal(typed.role, 'user');
  assert.equal(typed.source, undefined);
  assert.equal(typed.parts[0].text, '你好');

  const reply = gui.createGuiUserMessage({
    id: 's',
    text: '【调度回注 Worker】\n收到',
    ts: 2,
    source: 'scheduler'
  });
  assert.equal(reply.source, 'scheduler');
  assert.equal(reply.role, 'user', '引擎侧仍是 user 回合');
  assert.notEqual(typed.source, 'scheduler');
  console.log('  ✓ createGuiUserMessage：手打不标 / 注入标 scheduler');
}

console.log('ok chat-message-source');

assert.equal(gui.createGuiUserMessage({ id: 'a', text: '汇报', ts: 3, source: 'agent' }).source, 'agent');
