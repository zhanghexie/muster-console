/**
 * 会话历史格式化、截断与只读。
 * 运行: node test/chat-tail.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tail-'));
const compile = createSharedCompiler(root, tmp);

const { clampChatTailN, guiChatTailLine, tailChatLines, CHAT_TAIL_DEFAULT_N, CHAT_TAIL_MAX_N } = await import(
  pathToFileURL(compile('shared/chatTail.ts')).href
);

assert.equal(clampChatTailN(undefined), CHAT_TAIL_DEFAULT_N);
assert.equal(clampChatTailN(0), 1);
assert.equal(clampChatTailN(999), CHAT_TAIL_MAX_N);

const source = [
  { role: 'user', text: 'aaa', ts: 1 },
  { role: 'assistant', text: 'bbb', ts: 2 },
  { role: 'user', text: 'ccc', ts: 3 }
];
const frozen = JSON.stringify(source);
const tail = tailChatLines(source, 2);
assert.equal(tail.length, 2);
assert.equal(tail[0].text, 'bbb');
assert.equal(tail[1].text, 'ccc');
assert.equal(JSON.stringify(source), frozen, '只读：不改源数组');

const long = [{ role: 'user', text: 'x'.repeat(5000) }];
const clipped = tailChatLines(long, 1, 100);
assert.ok(clipped[0].text.length <= 101);
assert.ok(clipped[0].text.endsWith('…'));

const failedMessage = { id: 'failed', role: 'assistant', parts: [], ts: 4, error: 'OpenAI API error (402): Insufficient Balance' };
assert.equal(guiChatTailLine(failedMessage).text, `[error] ${failedMessage.error}`, '零正文 provider 失败不能投影成空 assistant');
const partialMessage = { ...failedMessage, parts: [{ kind: 'text', text: '部分输出' }] };
assert.equal(guiChatTailLine(partialMessage).text, `部分输出\n[error] ${failedMessage.error}`);
assert.equal(guiChatTailLine({ ...failedMessage, error: undefined, aborted: true }).text, '[aborted]');
assert.equal(guiChatTailLine({ ...partialMessage, error: undefined }).text, '部分输出', '正常回复仍是纯正文');
assert.ok(tailChatLines([guiChatTailLine(failedMessage)], 1, 20)[0].text.startsWith('[error]'), '错误同样遵守截断预算');

const { readSessionHistory } = await import(pathToFileURL(compile('main/sessions/history.ts')).href);
const rows = Array.from({ length: 10000 }, (_, i) => ({ id: `m${i}`, role: 'user', parts: [{kind: 'text', text: String(i)}], ts: i }));
rows.push({ id: 'shell', role: 'assistant', parts: [] }, { id: 'abort', role: 'assistant', parts: [], aborted: true });
const reads = [];
const ctx = { sessions: { resolveSessionRef: () => ({id: 's'}), get: () => ({id: 's', name: 'test', runtime: 'pi-gui'}), isChatRuntime: () => true },
  agentSessions: { getHistory() { throw new Error('full history forbidden'); }, getHistoryRange(_id, before, limit) {
    reads.push({before, limit}); const end = Math.min(before ?? rows.length, rows.length), start = Math.max(0, end-limit);
    return {messages: rows.slice(start, end), before: start, total: rows.length, hasEarlier: start > 0};
  } } };
const observed = await readSessionHistory(ctx, {sessionId: 's', n: 3});
assert.deepEqual(observed.messages.map(m => m.text), ['9998', '9999', '[aborted]']);
assert.deepEqual(reads, [{before: undefined, limit: 3}, {before: 9999, limit: 3}]);
assert.equal(observed.selected, false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] chat-tail');
