/**
 * ACP 五事件映射纯函数（T5.2）。
 * 运行: node test/acp-stream-map.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-stream-map-'));
const compile = createSharedCompiler(root, tmp);
const { createAcpStreamState, mapAcpSessionUpdate } = await import(
  pathToFileURL(compile('main/agentSession/drivers/acp/streamMap.ts')).href
);

{
  const st = createAcpStreamState();
  const ev = mapAcpSessionUpdate(st, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello' }
  });
  assert.deepEqual(ev, [{ type: 'text-delta', delta: 'hello' }]);
}

{
  const st = createAcpStreamState();
  const thought = mapAcpSessionUpdate(st, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'hmm' }
  });
  assert.deepEqual(thought, [{ type: 'thinking-delta', delta: 'hmm' }]);
}

{
  const st = createAcpStreamState();
  const start = mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'read',
    rawInput: { path: 'a.ts' }
  });
  assert.equal(start[0].type, 'tool-start');
  assert.equal(start[0].toolCallId, 't1');
  assert.equal(start[0].toolName, 'read');
  const end = mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't1',
    status: 'completed',
    rawOutput: 'ok'
  });
  assert.equal(end.length, 1);
  assert.equal(end[0].type, 'tool-result');
  assert.equal(end[0].ok, true);
  assert.equal(end[0].output, 'ok');
}

{
  // Qwen 0.27.2 emits a preparing placeholder, then the resolved call and its result.
  const st = createAcpStreamState('qwen');
  const readPath = 'E:/fixture/settings-example.txt';
  const start = mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call', toolCallId: 'read', status: 'pending',
    title: 'ReadFile', kind: 'read', rawInput: {}, locations: [],
    _meta: { toolName: 'read_file', phase: 'preparing' }
  });
  assert.equal(start[0].toolName, 'read_file');
  assert.deepEqual(start[0].input, {});
  const update = mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'in_progress',
    title: 'ReadFile: settings-example.txt', kind: 'read',
    rawInput: { file_path: readPath, limit: 2 }, locations: [{ path: readPath, line: null }],
    _meta: { toolName: 'read_file' }
  });
  assert.equal(update[0].type, 'tool-update');
  assert.equal(update[0].toolName, 'read_file');
  assert.deepEqual(update[0].displayInput, { file_path: readPath, limit: 2 });
  assert.deepEqual(update[0].input.locations, [{ path: readPath, line: null }]);
  const result = mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: '',
    content: [{ type: 'content', content: { type: 'text', text: 'fixture version: 1\nfixture color: blue\n' } }],
    _meta: { toolName: 'read_file' }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].output, 'fixture version: 1\nfixture color: blue\n');
}

{
  const st = createAcpStreamState('qwen');
  mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call', toolCallId: 'mcp', status: 'pending', title: 'ToolCall',
    rawInput: {}, locations: [], _meta: { toolName: 'tool_call', phase: 'preparing' }
  });
  const toolName = 'mcp__muster__mcp_search';
  const args = { query: 'tools' };
  const update = mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call_update', toolCallId: 'mcp', status: 'in_progress',
    title: 'mcp_search (muster MCP Server): {"query":"tools"}', rawInput: args, locations: [],
    _meta: { toolName }
  });
  assert.deepEqual(update, [{ type: 'tool-update', toolCallId: 'mcp', toolName, input: args }]);
  const result = mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call_update', toolCallId: 'mcp', status: 'completed',
    rawOutput: '{"ok":true,"result":{"total":0}}'
  });
  assert.equal(result[0].toolName, toolName);
  assert.equal(result[0].output, '{"ok":true,"result":{"total":0}}');
}

{
  const st = createAcpStreamState('qwen');
  const search = mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call', toolCallId: 'glob', status: 'completed', title: 'Glob', kind: 'search',
    rawInput: { pattern: '*.txt' }, rawOutput: 'Found 1 matching file(s)',
    content: [{ type: 'content', content: { type: 'text', text: 'Found settings-example.txt' } }]
  });
  assert.equal(search[1].output, 'Found settings-example.txt');
  const error = mapAcpSessionUpdate(st, {
    sessionUpdate: 'tool_call_update', toolCallId: 'failed-read', status: 'failed', title: 'ReadFile',
    content: [{ type: 'content', content: { type: 'text', text: 'File does not exist' } }]
  });
  assert.equal(error[1].ok, false);
  assert.equal(error[1].output, 'File does not exist');
}

{
  const st = createAcpStreamState();
  const send = (sessionUpdate, fields) => mapAcpSessionUpdate(st, { sessionUpdate, toolCallId: 'generic', ...fields });
  send('tool_call', { title: 'Working', rawInput: { obsolete: true } });
  assert.deepEqual(send('tool_call_update', { title: 'Updated' }), [
    { type: 'tool-update', toolCallId: 'generic', toolName: 'Updated', input: { obsolete: true } }
  ]);
  const [update] = send('tool_call_update', { name: 'inspect', rawInput: { locations: [] }, locations: [] });
  assert.equal(update.toolName, 'inspect');
  assert.deepEqual(update.input, { locations: [] });
  const [late, result] = send('tool_call_update', {
    status: 'completed', rawInput: ['query'], title: 'Finished',
    content: [{ type: 'content', content: { type: 'text', text: 'result text' } }]
  });
  assert.deepEqual(late.input, { input: ['query'] });
  assert.equal(late.toolName, 'inspect');
  assert.equal(late.reviewLate, true);
  assert.equal(result.output, 'result text');
}

{
  const st = createAcpStreamState();
  const cmds = mapAcpSessionUpdate(st, {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'compact', description: '压缩' }]
  });
  assert.equal(cmds[0].type, 'available-commands');
  assert.equal(cmds[0].commands[0].name, 'compact');
  const mode = mapAcpSessionUpdate(st, {
    sessionUpdate: 'current_mode_update',
    currentModeId: 'plan'
  });
  assert.deepEqual(mode, [{ type: 'current-mode', modeId: 'plan' }]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] acp-stream-map');
