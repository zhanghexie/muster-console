/**
 * P3 ui.notify：sessionId 补全；缺参一次报全。
 * Run: node test/ui-notify-args.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-notify-args-'));
const compile = createSharedCompiler(root, tmp);
const { fillNotifyFromSession, missingUiNotifyFields } = await import(
  pathToFileURL(compile('shared/uiNotifyArgs.ts')).href
);

assert.deepEqual(missingUiNotifyFields({}), ['workspaceId', 'sessionName']);
assert.deepEqual(missingUiNotifyFields({ workspaceId: 'w' }), ['sessionName']);
assert.deepEqual(missingUiNotifyFields({ workspaceId: 'w', sessionName: 's' }), []);

const filled = fillNotifyFromSession(
  { sessionId: 'abc', text: 'hi' },
  { id: 'abc', name: 'Worker 甲', workspaceId: 'ws-1' }
);
assert.equal(filled.workspaceId, 'ws-1');
assert.equal(filled.sessionName, 'Worker 甲');
assert.deepEqual(missingUiNotifyFields(filled), []);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] ui-notify-args');
