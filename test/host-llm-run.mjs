import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-llm-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { buildHostLlmRun } = await import(pathToFileURL(compile('main/capabilities/catalog/hostLlmRun.ts')));
  const { resolveRunToolCall, executeRunToolCall } = await import(pathToFileURL(compile('main/capabilities/catalog/runFactory.ts')));
  const worker = buildHostLlmRun('worker'), scheduler = buildHostLlmRun('scheduler');
  assert.throws(() => buildHostLlmRun('unknown'), /Invalid/);
  assert.equal(worker.runName, 'host.llm.run');
  assert.deepEqual(worker.actions.map(action => action.action), ['quota']);
  assert.ok(scheduler.actions.some(action => action.action === 'quota'));
  assert.ok(scheduler.actions.some(action => action.action === 'upsertProvider'));
  assert.deepEqual(resolveRunToolCall(worker, { action: 'quota', params: { providerId: 'p' } }),
    { action: 'quota', targetTool: 'llm.quota', args: { providerId: 'p' } });
  assert.throws(() => resolveRunToolCall(worker, { action: 'upsertProvider', params: {} }), /Unknown action/);
  let called = false;
  await assert.rejects(executeRunToolCall(worker, { action: 'quota', params: {} }, {}, {
    checkPermission: () => ({ allowed: false, reason: 'blocked' }), execute: () => { called = true; }
  }), /blocked/);
  assert.equal(called, false);
  console.log('host llm run: quota action and role-scoped routing passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
