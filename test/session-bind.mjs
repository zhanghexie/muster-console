/**
 * 远程工作台只在 PTY 会话就绪后写入。
 * Run: node test/session-bind.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bind-'));

const compile = createSharedCompiler(root, tmp);
const { isBoundTerminalReady } = await import(pathToFileURL(compile('shared/sessionBind.ts')).href);

assert.equal(isBoundTerminalReady({ ptyRunning: false, status: 'idle', lifecycle: 'idle' }), false);
assert.equal(
  isBoundTerminalReady({ ptyRunning: true, status: 'starting', lifecycle: 'starting' }),
  false
);
assert.equal(
  isBoundTerminalReady({ ptyRunning: true, status: 'running', lifecycle: 'starting' }),
  false
);
assert.equal(isBoundTerminalReady({ ptyRunning: true, status: 'running', lifecycle: 'exited' }), false);
assert.equal(isBoundTerminalReady({ ptyRunning: true, status: 'running', lifecycle: 'idle' }), true);
assert.equal(isBoundTerminalReady({ ptyRunning: true, status: 'running', lifecycle: 'working' }), true);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] session-bind');
