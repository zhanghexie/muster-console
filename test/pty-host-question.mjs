import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-question-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { requestPtyHostQuestion } = await import(pathToFileURL(compile('main/agentSession/tools/ptyHostQuestion.ts')));
  const calls = [], choices = ['option-1', ['option-0', 'custom'], 'custom text', null];
  const ui = { select: async args => { calls.push(args); return choices.shift(); },
    multiSelect: async args => { calls.push(args); return choices.shift(); },
    prompt: async args => { calls.push(args); return choices.shift(); } };
  const request = { questions: [
    { id: 'a', question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'b', question: 'Second?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] }
  ] };
  const result = await requestPtyHostQuestion(ui, 'Worker 1', request);
  assert.deepEqual(result, { kind: 'answered', answers: [
    { id: 'a', selected: ['B'] }, { id: 'b', selected: ['X'], custom: 'custom text' }
  ] });
  assert.match(calls[0].title, /Worker 1/);
  assert.equal((await requestPtyHostQuestion(ui, 'Worker 1', { questions: [{ id: 'c', question: 'Cancel?' }] })).kind, 'aborted');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestPtyHostQuestion(ui, 'Worker 1', request, controller.signal), /abort/i);
  await assert.rejects(requestPtyHostQuestion(ui, 'Worker 1', { questions: [{ id: 'long', question: 'x'.repeat(501) }] }), /too long/i);
  console.log('PTY host question: session label, choices, custom input and cancellation passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
