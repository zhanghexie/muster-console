import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-test-')));
const compiled = path.join(temp, 'compiled');
const packageDir = path.dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
const scope = path.join(compiled, 'node_modules', '@anthropic-ai');
fs.mkdirSync(scope, { recursive: true });
fs.symlinkSync(packageDir, path.join(scope, 'claude-agent-sdk'), 'junction');
const compile = createSharedCompiler(repo, compiled);
const { claudeHistoryStorageKey, deleteClaudeHistory, describeClaudeHistory } =
  await import(pathToFileURL(compile('main/agentSession/drivers/claude/nativeHistory.ts')).href);
const cwd = path.join(temp, 'project');
fs.mkdirSync(cwd, { recursive: true });
const id = randomUUID();
const configure = config => {
  const folder = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  const transcript = path.join(folder, id + '.jsonl');
  const subagents = path.join(folder, id, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, 'agent-fixture.jsonl'), '{}\n');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', uuid: randomUUID(), parentUuid: null,
    cwd, sessionId: id, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Isolated fixture' } }) + '\n');
  return { transcript, subagents };
};
try {
  const config = path.join(temp, 'config');
  const different = path.join(temp, 'other-profile');
  const expected = configure(config);
  const other = configure(different);
  const row = { runtimeResumeToken: id, nativeHistoryStorageKey: claudeHistoryStorageKey(config), cwd };
  assert.deepEqual(describeClaudeHistory(row, config)?.actions, ['delete']);
  await assert.rejects(deleteClaudeHistory(row, different), /另一个历史目录/);
  assert.ok(fs.existsSync(other.transcript));
  await deleteClaudeHistory(row, config);
  assert.ok(!fs.existsSync(expected.transcript));
  assert.ok(!fs.existsSync(expected.subagents));
  assert.ok(fs.existsSync(other.transcript));
  await deleteClaudeHistory(row, config);
  console.log('Claude SDK native history: scoped local transcript and subagent deletion passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
