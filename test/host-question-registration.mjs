import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const scratch = path.join(process.cwd(), '.tmp');
fs.mkdirSync(scratch, { recursive: true });
const tmp = fs.mkdtempSync(path.join(scratch, 'host-question-registration-'));
const compile = createSharedCompiler(process.cwd(), tmp);
try {
  const { buildPiCustomTools } = await import(pathToFileURL(compile('main/agentSession/drivers/pi/customTools.ts')));
  const ctx = { sessionId: 's', cwd: process.cwd() };
  const ask = async () => ({ kind: 'aborted' });
  assert.deepEqual(buildPiCustomTools([], ctx, ask), [], 'question channel alone cannot register the old name');
  const tool = { id: 'host.ask', label: 'Ask', description: 'Ask', parameters: { type: 'object', properties: {} }, execute: async () => '{}' };
  assert.deepEqual(buildPiCustomTools([tool], ctx, ask).map(item => item.name), ['host_ask']);
  const { buildClaudeMcpServer } = await import(pathToFileURL(compile('main/agentSession/drivers/claude/hostTools.ts')));
  const result = await buildClaudeMcpServer({ sdk: {}, input: { hostTools: [], requestUserQuestion: ask } });
  assert.equal(result, undefined, 'Claude cannot register an implicit old question tool');
  console.log('host-question-registration: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
