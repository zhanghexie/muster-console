import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-semantic-schema-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DESKTOP_TOOL_DEFS } = await import(pathToFileURL(compile('main/capabilities/catalog/desktop.ts')));
  const { assertToolArguments } = await import(pathToFileURL(compile('main/capabilities/schemaValidation.ts')));
  const look = DESKTOP_TOOL_DEFS.find(item => item.name === 'desktop.look').parameters;
  const act = DESKTOP_TOOL_DEFS.find(item => item.name === 'desktop.act').parameters;
  assert.doesNotThrow(() => assertToolArguments(look, { surfaceId: 'display', mode: 'semantic', windowId: 'window', snapshotId: 'snapshot', offset: 2 }, 'look'));
  assert.doesNotThrow(() => assertToolArguments(look, { surfaceId: 'display', mode: 'both', windowId: 'window' }, 'look'));
  assert.doesNotThrow(() => assertToolArguments(act, { surfaceId: 'display', requestId: 'r1', action: 'set_value',
    target: { windowId: 'window', snapshotId: 'snapshot', ref: 'ref', value: '', delivery: 'foreground' } }, 'act'));
  assert.doesNotThrow(() => assertToolArguments(act, { surfaceId: 'display', requestId: 'r2', action: 'scroll',
    target: { windowId: 'window', x: 1, y: 2, delta: 120, axis: 'horizontal' } }, 'act'));
  assert.doesNotThrow(() => assertToolArguments(act, { surfaceId: 'display', requestId: 'r3', action: 'key',
    target: { windowId: 'window', keys: ['Control', 'KeyA', 0x1b] } }, 'act'));
  assert.throws(() => assertToolArguments(act, { surfaceId: 'display', requestId: 'r4', action: 'key',
    target: { windowId: 'window', keys: ['bad key'] } }, 'act'));
  assert.throws(() => assertToolArguments(act, { surfaceId: 'display', requestId: 'r', action: 'set_value',
    target: { windowId: 'window', snapshotId: 'snapshot', ref: 'ref', value: 'x'.repeat(4097) } }, 'act'));
  assert.throws(() => assertToolArguments(look, { surfaceId: 'display', mode: 'semantic', pid: 123 }, 'look'));
  console.log('desktop semantic schema: bounded refs, values, image modes and scroll axis passed');
} finally { removeWorkspaceFixture(temp, 'desktop-semantic-schema-'); }
