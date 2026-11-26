import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'session-deep-link-'));
const compile = createSharedCompiler(root, temporary);
try {
  const { parseSessionDeepLink, resolveSessionFromHash } =
    await import(pathToFileURL(compile('shared/sessionDeepLink.ts')).href);
  assert.equal(parseSessionDeepLink('http://example.test/#/session/sid/extra?focus=1'), 'sid');
  assert.equal(parseSessionDeepLink(`#/session/${encodeURIComponent('含斜杠/空格 测试')}`), '含斜杠/空格 测试');
  assert.equal(parseSessionDeepLink('#/session/%fail'), null);
  assert.equal(parseSessionDeepLink('#/session/'), null);
  assert.equal(parseSessionDeepLink('#/other'), null);
  const sessions = [{ id: 's1', workspaceId: 'w1' }, { id: 's2' }];
  assert.deepEqual(resolveSessionFromHash('#/session/s1', sessions), { sessionId: 's1', workspaceId: 'w1' });
  assert.equal(resolveSessionFromHash('#/session/s2', sessions), null);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
