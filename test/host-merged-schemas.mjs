import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-schema-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { HOST_ASK_DEF, HOST_SESSION_UPDATE_DEF } = await import(pathToFileURL(compile('main/capabilities/catalog/hostMerged.ts')));
  const Ajv = createRequire(import.meta.url)('ajv');
  const ajv = new Ajv({ allErrors: true, strictSchema: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  const ask = ajv.compile(HOST_ASK_DEF.parameters), update = ajv.compile(HOST_SESSION_UPDATE_DEF.parameters);
  for (const value of [{ kind: 'confirm', title: 'OK' }, { kind: 'text', title: 'Name', multiline: true },
    { kind: 'choice', questions: [{ question: 'Pick', options: [{ label: 'A' }] }] }]) assert.equal(ask(value), true, JSON.stringify(ask.errors));
  for (const value of [{ kind: 'confirm' }, { kind: 'choice', questions: [] }, { kind: 'text', title: 'X', questions: [] },
    { kind: 'confirm', title: 'X', confirmed: true }, { kind: 'choice', questions: [{ question: 'Pick', options: [{}] }] }]) assert.equal(ask(value), false);
  for (const value of [{ name: 'self' }, { sessionId: 'child', archived: true },
    { sessionId: 'id', name: 'Name', pinned: false, model: null, thinking: 'max' },
    { model: { providerId: 'p', modelId: 'm' }, thinking: null }]) assert.equal(update(value), true, JSON.stringify(update.errors));
  for (const value of [{}, { sessionId: 'id' }, { name: '' }, { pinned: 'yes' }, { model: { providerId: 'p' } },
    { name: 'x', injected: true }, { thinking: 'invented' }]) assert.equal(update(value), false);
  console.log('host merged schemas: discriminated inquiry and multi-field updates passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
