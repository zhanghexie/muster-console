import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-ask-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { routeHostAsk: route, executeHostAsk } = await import(pathToFileURL(compile('shared/hostAsk.ts')));
  assert.deepEqual(route({ kind: 'confirm', title: 'Confirm', detail: 'exact scope' }),
    { tool: 'ui.confirm', args: { title: 'Confirm', detail: 'exact scope' } });
  assert.deepEqual(route({ kind: 'text', title: 'Name', multiline: false }),
    { tool: 'ui.prompt', args: { title: 'Name', multiline: false } });
  const questions = [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }];
  assert.deepEqual(route({ kind: 'choice', questions }), { tool: 'askQuestion', args: { questions } });
  for (const bad of [null, {}, { kind: 'confirm', title: ' ' }, { kind: 'text', title: 'X', multiline: 'false' },
    { kind: 'choice', questions: [] }, { kind: 'choice', questions: [{ question: '' }] },
    { kind: 'choice', questions: [{ question: 'Pick', options: [{ label: '' }] }] },
    { kind: 'choice', questions: [{ id: 'x', question: 'First' }, { id: ' x ', question: 'Second' }] },
    { kind: 'choice', questions: [{ id: 'q2', question: 'First' }, { question: 'Second' }] },
    { kind: 'choice', questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: ' A ' }] }] },
    { kind: 'confirm', title: 'X', confirmed: true }]) assert.throws(() => route(bad));
  const channels = { confirm: async () => ({ confirmed: false, cancelledBy: 'button' }),
    text: async () => ({ cancelled: true, value: null }), choice: async () => { throw new Error('question aborted'); } };
  assert.deepEqual(await executeHostAsk({ kind: 'confirm', title: 'Confirm' }, channels), { confirmed: false, cancelledBy: 'button' });
  assert.deepEqual(await executeHostAsk({ kind: 'text', title: 'Text' }, channels), { cancelled: true, value: null });
  await assert.rejects(executeHostAsk({ kind: 'choice', questions }, channels), /question aborted/);
  const { uiHost } = await import(pathToFileURL(compile('main/capabilities/hosts/misc.ts')));
  const { runAsSchedulerTool, runAsAgentSession } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const ctx = { ui: { confirm: async () => ({ confirmed: false, cancelledBy: 'button' }), prompt: async () => null },
    orchestrator: { requestUserQuestion: async () => ({ kind: 'aborted' }) } };
  await assert.rejects(uiHost['host.ask'](ctx, { kind: 'confirm', title: 'X' }), /scheduler identity/);
  await runAsAgentSession('worker', () => assert.rejects(uiHost['host.ask'](ctx, { kind: 'confirm', title: 'X' }), /own question channel/));
  await runAsSchedulerTool(async () => {
    assert.deepEqual(await uiHost['host.ask'](ctx, { kind: 'confirm', title: 'X' }), { confirmed: false, cancelledBy: 'button' });
    assert.deepEqual(await uiHost['host.ask'](ctx, { kind: 'text', title: 'X' }), { cancelled: true, value: null });
    await assert.rejects(uiHost['host.ask'](ctx, { kind: 'choice', questions }), /aborted/);
  });
  console.log('host ask: explicit kind and safe routing validation passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
