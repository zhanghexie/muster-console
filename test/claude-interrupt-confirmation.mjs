import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareClaudeInterrupt } from '../src/main/runtime/builtins/scripts/_claude-interrupt.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interrupt-'));
try {
  const file = path.join(tmp, 'session.jsonl');
  const row = (extra = {}) => JSON.stringify({ type: 'user', sessionId: 'same', interruptedMessageId: 'response-1', timestamp: new Date().toISOString(), ...extra }) + '\n';
  fs.writeFileSync(file, row());
  const confirm = await prepareClaudeInterrupt(file, 'same');
  assert.equal(await confirm(), false);
  fs.appendFileSync(file, row({ type: 'assistant', message: { content: '[Request interrupted by user]' } }));
  assert.equal(await confirm(), false, 'model prose cannot prove stop');
  fs.appendFileSync(file, row({ sessionId: 'another' }));
  assert.equal(await confirm(), false);
  fs.appendFileSync(file, row({ timestamp: '2000-01-01T00:00:00Z' }));
  assert.equal(await confirm(), false, 'delayed old history cannot acknowledge current stop');
  fs.appendFileSync(file, row());
  assert.equal(await confirm(), true);
  fs.appendFileSync(file, row({ type: 'assistant', interruptedMessageId: undefined }));
  assert.equal(await confirm(), false, 'new execution revokes interruption evidence');
  fs.writeFileSync(file, '');
  assert.equal(await confirm(), false, 'truncation is not acknowledgement');
  console.log('claude-interrupt-confirmation: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
