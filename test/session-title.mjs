/**
 * 历史会话标题纯函数自测。
 * Run: node test/session-title.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('shared/sessionTitle.ts');
const { pickSessionTitle, SESSION_TITLE_MAX } = await import(pathToFileURL(outFile).href);

// 1) 自定义名优先
assert.equal(
  pickSessionTitle({ name: '我的标题', firstMessage: '你好' }),
  '我的标题',
  '自定义名应优先'
);

// 2) 无自定义名回落到首条消息
assert.equal(pickSessionTitle({ firstMessage: '你好，世界' }), '你好，世界');

// 3) 首条消息超长截断
const long = 'a'.repeat(SESSION_TITLE_MAX + 50);
assert.equal(
  pickSessionTitle({ firstMessage: long }).length,
  SESSION_TITLE_MAX,
  '首条消息应截断到上限'
);

// 4) 自定义名超长也截断
assert.equal(
  pickSessionTitle({ name: long, firstMessage: 'x' }).length,
  SESSION_TITLE_MAX,
  '自定义名应截断到上限'
);

// 5) 空白名忽略，回落首条消息
assert.equal(pickSessionTitle({ name: '   ', firstMessage: '回落' }), '回落');

// 6) 都没有：定时任务带名
assert.equal(
  pickSessionTitle({ isTask: true, taskName: '日报' }),
  '定时任务「日报」'
);

// 7) 都没有：定时任务无名
assert.equal(pickSessionTitle({ isTask: true }), '定时任务运行');

// 8) 都没有：普通会话
assert.equal(pickSessionTitle({}), '（无消息）');

// 9) name 仅空白且无首条消息且非任务 → 兜底
assert.equal(pickSessionTitle({ name: '  ' }), '（无消息）');

console.log('session-title: 9 assertions passed');
