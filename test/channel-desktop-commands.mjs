import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-desktop-commands-'));
try {
  const compile = createSharedCompiler(root, temporary);
  const { buildSlashItems, isUnsupportedSlash } = await import(pathToFileURL(compile('renderer/src/components/agentComposer/composerHelpers.ts')).href);
  for (const gui of [false, true]) {
    const items = buildSlashItems([], '', gui, undefined, false, key => key);
    assert.ok(!items.some(item => item.id === 'cmd:bind' || item.id === 'cmd:unbind'));
    assert.ok(items.some(item => item.id === 'cmd:new'));
  }
  // Typed remote commands remain recognized so the desktop can explain the Channel route.
  assert.equal(isUnsupportedSlash('/bind demo'), false);
  assert.equal(isUnsupportedSlash('/unbind'), false);
  console.log('channel-desktop-commands: passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
