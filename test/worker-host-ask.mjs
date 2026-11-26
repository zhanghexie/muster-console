import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-host-ask-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { executeWorkerHostAsk, buildWorkerHostAskTool } = await import(pathToFileURL(compile('main/agentSession/tools/workerHostAsk.ts')));
  let recorded, outcome = { kind: 'answered', answers: [{ id: 'host-confirm', selected: ['确认'] }] };
  const request = async (value, signal) => { recorded = { value, signal }; return outcome; };
  assert.deepEqual(await executeWorkerHostAsk({ kind: 'confirm', title: '执行？', detail: '具体范围' }, request), { confirmed: true });
  assert.equal(recorded.value.questions[0].detail, '具体范围');
  outcome = { kind: 'answered', answers: [{ id: 'host-confirm', selected: ['确认'], custom: 'but no' }] };
  assert.deepEqual(await executeWorkerHostAsk({ kind: 'confirm', title: '执行？' }, request), { confirmed: false });
  outcome = { kind: 'answered', answers: [{ id: 'host-confirm', selected: ['拒绝'] }] };
  assert.deepEqual(await executeWorkerHostAsk({ kind: 'confirm', title: '执行？' }, request), { confirmed: false });
  outcome = { kind: 'aborted' };
  assert.deepEqual(await executeWorkerHostAsk({ kind: 'confirm', title: '执行？' }, request), { confirmed: false, cancelled: true });
  outcome = { kind: 'answered', answers: [{ id: 'host-text', selected: [], custom: '  A\nB  ' }] };
  assert.deepEqual(await executeWorkerHostAsk({ kind: 'text', title: '文本', message: '说明', defaultValue: '初始', placeholder: '输入', multiline: true }, request),
    { cancelled: false, value: '  A\nB  ' });
  assert.deepEqual(recorded.value.questions[0].textInput, { defaultValue: '初始', placeholder: '输入', multiline: true });
  outcome = { kind: 'answered', answers: [{ id: 'host-text', selected: [], custom: '' }] };
  assert.deepEqual(await executeWorkerHostAsk({ kind: 'text', title: '文本' }, request), { cancelled: false, value: '' });
  outcome = { kind: 'answered', answers: [{ id: 'host-text', selected: ['unexpected'], custom: 'x' }] };
  assert.deepEqual(await executeWorkerHostAsk({ kind: 'text', title: '文本' }, request), { cancelled: true, value: null });
  const questions = [{ id: 'q', question: '哪种？', options: [{ label: 'A' }, { label: 'B' }] }];
  outcome = { kind: 'answered', answers: [{ id: 'q', selected: ['A'] }] };
  assert.deepEqual(await executeWorkerHostAsk({ kind: 'choice', questions }, request), { answers: outcome.answers });
  let asked = false;
  await assert.rejects(executeWorkerHostAsk({ kind: 'choice', questions: [
    { id: 'same', question: 'First' }, { id: ' same ', question: 'Second' }
  ] }, async () => { asked = true; return outcome; }), /unique/);
  assert.equal(asked, false, 'ambiguous questions never reach the user');
  outcome = { kind: 'aborted' };
  await assert.rejects(executeWorkerHostAsk({ kind: 'choice', questions }, request), /aborted/);
  const controller = new AbortController();
  await assert.rejects(executeWorkerHostAsk({ kind: 'confirm', title: '执行？' }, async () => {
    controller.abort(); return { kind: 'answered', answers: [{ id: 'host-confirm', selected: ['确认'] }] };
  }, controller.signal), /abort/i);
  assert.equal(buildWorkerHostAskTool('worker'), null, 'do not expose a question tool without a human channel');
  const tool = buildWorkerHostAskTool('worker', request);
  assert.equal(tool.id, 'host.ask');
  await assert.rejects(tool.execute({ kind: 'confirm', title: '执行？' }, { sessionId: 'other', cwd: '/' }), /session changed/);
  outcome = { kind: 'answered', answers: [{ id: 'host-confirm', selected: ['拒绝'] }] };
  assert.deepEqual(JSON.parse(await tool.execute({ kind: 'confirm', title: '执行？' }, { sessionId: 'worker', cwd: '/' })), { confirmed: false });
  console.log('worker host ask: explicit consent, cancellation and exact text passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
