/**
 * 聊天时间标签纯函数自测。
 * Run: node test/chat-time.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-time-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('shared/chatTime.ts');
const { formatChatTimeLabel, shouldShowTimeSeparator, CHAT_TIME_GAP_MS } = await import(
  pathToFileURL(outFile).href
);

// 固定「现在」= 2026-08-19 13:47 本地时区。用本地时间构造避免时区漂移。
const NOW = new Date(2026, 7, 19, 13, 47, 0).getTime();

// 1) 今天 → HH:mm
assert.equal(formatChatTimeLabel(new Date(2026, 7, 19, 9, 5, 0).getTime(), NOW), '09:05');
assert.equal(formatChatTimeLabel(new Date(2026, 7, 19, 13, 47, 0).getTime(), NOW), '13:47');

// 2) 昨天 → 昨天 HH:mm
assert.equal(formatChatTimeLabel(new Date(2026, 7, 18, 20, 30, 0).getTime(), NOW), '昨天 20:30');

// 3) 今年其它 → M月D日 HH:mm
assert.equal(formatChatTimeLabel(new Date(2026, 2, 1, 8, 15, 0).getTime(), NOW), '3月1日 08:15');

// 4) 跨年 → YYYY年M月D日 HH:mm
assert.equal(formatChatTimeLabel(new Date(2024, 11, 31, 23, 59, 0).getTime(), NOW), '2024年12月31日 23:59');

// 5) 非数字兜底空串
assert.equal(formatChatTimeLabel(Number.NaN, NOW), '');

// 6) shouldShowTimeSeparator：第一条总是 true
assert.equal(shouldShowTimeSeparator(null, NOW), true);

// 7) 间隔小于阈值不插
assert.equal(shouldShowTimeSeparator(NOW - 60_000, NOW), false);

// 8) 间隔大于阈值插
assert.equal(shouldShowTimeSeparator(NOW - CHAT_TIME_GAP_MS - 1, NOW), true);

console.log('chat-time: 8 assertions passed');
