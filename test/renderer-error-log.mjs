/**
 * P15：渲染错误落盘格式。
 * 运行: node test/renderer-error-log.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-err-'));
const compile = createSharedCompiler(root, tmp);
const { formatRendererErrorLine, RENDERER_ERROR_LOG_NAME } = await import(
  pathToFileURL(compile('shared/rendererErrorLog.ts')).href
);
const { appendRendererError } = await import(pathToFileURL(compile('main/logs/rendererError.ts')).href);

const line = formatRendererErrorLine({
  ts: 1,
  label: '聊天 foo',
  message: 'boom',
  stack: 'Error: boom',
  componentStack: 'in Chat'
});
const rec = JSON.parse(line);
assert.equal(rec.label, '聊天 foo');
assert.equal(rec.componentStack, 'in Chat');

const userData = path.join(tmp, 'ud');
const file = appendRendererError(userData, {
  ts: 2,
  label: 'Git 历史',
  message: 'Maximum update depth exceeded'
});
assert.ok(file.endsWith(RENDERER_ERROR_LOG_NAME));
const text = fs.readFileSync(file, 'utf8');
assert.match(text, /Git 历史/);
assert.match(text, /Maximum update depth/);

console.log('renderer-error-log: ok');
