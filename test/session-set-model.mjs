/**
 * P10：sessions.setModel / setThinking 决策三态。
 * 运行: node test/session-set-model.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-set-model-'));
const compile = createSharedCompiler(root, tmp);
const {
  decideSetModel,
  decideSetThinking,
  parseModelClearArgs
} = await import(pathToFileURL(compile('shared/sessionModelChange.ts')).href);

assert.deepEqual(parseModelClearArgs({}), { clearing: true, complete: true });
assert.deepEqual(parseModelClearArgs({ providerId: '', modelId: '' }), { clearing: true, complete: true });
assert.deepEqual(parseModelClearArgs({ providerId: 'p', modelId: 'm' }), {
  clearing: false,
  complete: true
});
assert.deepEqual(parseModelClearArgs({ providerId: 'p', modelId: '' }), {
  clearing: false,
  complete: false
});

const idle = decideSetModel({
  isChat: true,
  policy: 'reconnect',
  busy: false,
  hasOpenEntry: true,
  clearing: false,
  complete: true
});
assert.deepEqual(idle, { ok: true, applied: 'immediate', dropConnection: true });

const busy = decideSetModel({
  isChat: true,
  policy: 'reconnect',
  busy: true,
  hasOpenEntry: true,
  clearing: false,
  complete: true
});
assert.deepEqual(busy, { ok: true, applied: 'next-turn', dropConnection: false });

const snapReject = decideSetModel({
  isChat: true,
  policy: 'unsupported',
  busy: false,
  hasOpenEntry: true,
  clearing: false,
  complete: true
});
assert.equal(snapReject.ok, false);
assert.equal(snapReject.errorKey, 'unsupported');

const thinkHotBusy = decideSetThinking({
  isChat: true,
  policy: 'hot',
  busy: true,
  hasOpenEntry: true
});
assert.deepEqual(thinkHotBusy, { ok: true, applied: 'next-turn', dropConnection: false });

const thinkNo = decideSetThinking({
  isChat: true,
  policy: 'unsupported',
  busy: false,
  hasOpenEntry: true
});
assert.equal(thinkNo.ok, false);

console.log('session-set-model: ok');
