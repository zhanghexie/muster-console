/**
 * 子代理提示词条件化：父收件人教学只对子代理出现，收发复用常驻入口。
 * 运行: node test/subagent-prompt.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(root, fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-prompt-')));
const { buildGuiWorkerSystemPrompt } = await import(
  `file://${compile('shared/guiWorkerPrompt.ts').replace(/\\/g, '/')}`
);

const prompt = extra => buildGuiWorkerSystemPrompt({
  mode: 'default',
  tools: [{ id: 'host.sessions.setStatus' }, { id: 'host.mail.send' }],
  ...extra
});

test('child delivery uses the engine name of the parent mailbox tool', () => {
  const text = prompt({ isSubagent: true, hostToolNamePrefix: 'mcp__muster__' });
  assert.match(text, /mcp__muster__host_mail_send.*Deliver to your parent \(to="parent"\)/);
  assert.doesNotMatch(text, /sessions_reportParent|sessions\.reportParent/);
});

test('parent guidance is absent for top-level sessions and when mail is unavailable', () => {
  assert.doesNotMatch(prompt({}), /to="parent"/);
  assert.doesNotMatch(prompt({ isSubagent: true, tools: [] }), /to="parent"/);
});
