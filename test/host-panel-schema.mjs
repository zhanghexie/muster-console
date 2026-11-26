import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-panel-schema-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { HOST_PANEL_DEFS } = await import(pathToFileURL(compile('main/capabilities/catalog/hostPanel.ts')));
  const { assertToolArguments } = await import(pathToFileURL(compile('main/capabilities/schemaValidation.ts')));
  const schema = name => HOST_PANEL_DEFS.find(def => def.name === `host.panel.${name}`).parameters;
  const valid = (name, value) => assert.doesNotThrow(() => assertToolArguments(schema(name), value, name));
  const invalid = (name, value) => assert.throws(() => assertToolArguments(schema(name), value, name), /Invalid parameters/);
  assert.deepEqual(HOST_PANEL_DEFS.map(def => def.name), ['host.panel.list', 'host.panel.open', 'host.panel.split', 'host.panel.focus', 'host.panel.close']);
  assert.ok(JSON.stringify(schema('open')).length < 2700, 'Open should share field definitions across kinds');
  for (const field of ['path', 'fileRef', 'repoPath', 'owner', 'sessionId', 'browserId']) {
    assert.ok(schema('open').properties[field], `${field} must be visible to adapters that project root fields`);
  }
  valid('list', {}); invalid('list', { workspaceId: 'spoof' });
  for (const value of [
    { kind: 'file', path: 'a.ts', line: 2 }, { kind: 'file', fileRef: { workspaceId: 'w', rootId: 'r', relativePath: 'a' } },
    { kind: 'diff', repoPath: '/repo', filePath: 'a', staged: false }, { kind: 'git', repoPath: '/repo' },
    { kind: 'review', owner: { kind: 'gui', id: 'session' } }, { kind: 'browser', browserId: 'b' },
    { kind: 'session', sessionId: 's' }, { kind: 'utility', sel: 'usage' }, { kind: 'extension', nodeId: 'n' },
    { kind: 'settings', focus: false, placement: 'center' }
  ]) valid('open', value);
  for (const value of [{ kind: 'file' }, { kind: 'file', path: 'a', line: 0 }, { kind: 'git', repoPath: '/r', unknown: true },
    { kind: 'file', path: 'a', fileRef: { workspaceId: 'w', rootId: 'r', relativePath: 'a' } },
    { kind: 'review', owner: { kind: 'unknown', id: 's' } }, { kind: 'extension' }, { kind: 'bad' },
    { kind: 'git', repoPath: '/r', filePath: 'a' }, { kind: 'settings', sessionId: 's' }, { repoPath: '/r' }]) invalid('open', value);
  valid('split', { panes: [{ kind: 'session', sessionId: 'a' }, { kind: 'utility', sel: 'usage' }], layoutId: 'halves' });
  valid('split', { placement: 'right', layoutId: 'stack', tabIds: ['a', 'b'], ratio: 0.65 });
  valid('split', { placement: 'right', layoutId: 'focus-mirror', tabIds: ['a', 'b', 'c'], ratios: [0.4, 0.6] });
  invalid('split', { layoutId: 'stack', tabIds: ['a', 'b'] });
  invalid('split', { placement: 'right', layoutId: 'stack', tabIds: ['a', 'a'] });
  invalid('split', { placement: 'right', layoutId: 'wide', tabIds: ['a', 'b'] });
  invalid('split', { placement: 'right', layoutId: 'stack', tabIds: ['a', 'b'], ratio: 0.3, ratios: [0.4, 0.6] });
  invalid('split', { placement: 'right', layoutId: 'stack', tabIds: ['a', 'b'], panes: [{ kind: 'session', sessionId: 's' }, { kind: 'utility', sel: 'usage' }] });
  invalid('split', { panes: [{ kind: 'empty' }, { kind: 'session', sessionId: 'a' }], layoutId: 'halves' });
  valid('focus', { tabId: 't' }); valid('focus', { page: 'git' }); valid('focus', { target: { kind: 'session', sessionId: 's' } });
  invalid('focus', { page: 'git', tabId: 't' }); invalid('focus', {});
  valid('close', { tabId: 't' }); valid('close', { placement: 'center', slot: 1 });
  valid('close', { placement: 'right', slot: 2 }); valid('close', { placement: 'right' });
  invalid('close', { placement: 'right', tabId: 't' }); invalid('close', { placement: 'right', slot: -1 });
  invalid('close', { placement: 'center' }); invalid('close', { tabId: 't', target: { kind: 'session', sessionId: 's' } });
  console.log('host panel schema: typed content, layout and exclusive targets passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
