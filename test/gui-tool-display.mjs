/** 流式映射保留未变工具，避免重复 stringify；输入/终态/输出/patch 更新仍立即生效。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-tool-display-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { toDisplayToolCall } = await import(pathToFileURL(compile('renderer/src/chatSurface/guiToolDisplay.ts')).href);
  const { applyGuiMessageDelta, applyGuiMessagePart } = await import(pathToFileURL(compile('shared/guiWorker.ts')).href);
  let inputReads = 0;
  const input = { get body() { inputReads += 1; return 'large tool input '.repeat(20000); } };
  const tool = { id: 't', name: 'shell', input, status: 'running' };
  let message = { id: 'm', role: 'assistant', ts: 1, parts: [{ kind: 'tool', tool }, { kind: 'text', text: 'first' }] };
  const first = toDisplayToolCall(tool);
  assert.equal(inputReads, 1);
  for (let i = 0; i < 12; i++) {
    message = applyGuiMessageDelta(message, 1, 'text', ' next');
    assert.equal(toDisplayToolCall(message.parts[0].tool), first, '正文 delta 不重映射旧工具');
  }
  assert.equal(inputReads, 1, '未变工具的 JSON 参数只串行化一次；还原缓存即红');

  const completed = { ...tool, status: 'ok', output: 'new output', patch: 'new patch' };
  const updated = applyGuiMessagePart([message], message.id, 0, { kind: 'tool', tool: completed })[0];
  const done = toDisplayToolCall(updated.parts[0].tool);
  assert.notEqual(done, first);
  assert.equal(done.status, 'ok');
  assert.equal(done.result, 'new output');
  assert.equal(done.patch, 'new patch');
  assert.equal(toDisplayToolCall(completed), done);

  // 顶层字段原位变化仍失效；input 按 renderer 不可变数据合同换对象。
  completed.input = { body: 'replaced input' };
  let next = toDisplayToolCall(completed);
  assert.notEqual(next, done);
  assert.equal(JSON.parse(next.arguments).body, 'replaced input');
  for (const [key, value] of [['status', 'error'], ['output', ''], ['patch', ''], ['id', 'new-id'], ['name', 'new-name']]) {
    const previous = next;
    completed[key] = value;
    next = toDisplayToolCall(completed);
    assert.notEqual(next, previous, `${key} 变化使映射失效`);
  }
  assert.equal(next.status, 'error');
  assert.equal(next.result, '');
  assert.equal(next.patch, undefined);
  assert.equal(next.id, 'new-id');
  assert.equal(next.name, 'new-name');
  console.log('gui-tool-display: delta reuse, one serialization, and field invalidation passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
