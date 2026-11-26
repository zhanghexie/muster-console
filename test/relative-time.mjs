/**
 * 相对时间纯函数自测。
 * Run: node test/relative-time.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relative-time-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('shared/relativeTime.ts');
const { formatRelativeTime, formatRelativeTimeShort } = await import(pathToFileURL(outFile).href);

const NOW = Date.parse('2026-08-19T05:47:00.000Z');

// 1) 刚刚（<1分钟）
assert.equal(formatRelativeTime(NOW, { now: NOW }), '刚刚');
assert.equal(formatRelativeTime(NOW - 30_000, { now: NOW }), '刚刚');

// 2) 分钟
assert.equal(formatRelativeTime(NOW - 60_000, { now: NOW }), '1分钟前');
assert.equal(formatRelativeTime(NOW - 5 * 60_000, { now: NOW }), '5分钟前');
assert.equal(formatRelativeTime(NOW - 59 * 60_000, { now: NOW }), '59分钟前');

// 3) 小时
assert.equal(formatRelativeTime(NOW - 60 * 60_000, { now: NOW }), '1小时前');
assert.equal(formatRelativeTime(NOW - 3 * 60 * 60_000, { now: NOW }), '3小时前');
assert.equal(formatRelativeTime(NOW - 23 * 60 * 60_000, { now: NOW }), '23小时前');

// 4) 天
assert.equal(formatRelativeTime(NOW - 24 * 60 * 60_000, { now: NOW }), '1天前');
assert.equal(formatRelativeTime(NOW - 5 * 24 * 60 * 60_000, { now: NOW }), '5天前');
assert.equal(formatRelativeTime(NOW - 29 * 24 * 60 * 60_000, { now: NOW }), '29天前');

// 5) 个月
assert.equal(formatRelativeTime(NOW - 30 * 24 * 60 * 60_000, { now: NOW }), '1个月前');
assert.equal(formatRelativeTime(NOW - 90 * 24 * 60 * 60_000, { now: NOW }), '3个月前');
assert.equal(formatRelativeTime(NOW - 300 * 24 * 60 * 60_000, { now: NOW }), '10个月前');

// 6) 年
assert.equal(formatRelativeTime(NOW - 365 * 24 * 60 * 60_000, { now: NOW }), '1年前');
assert.equal(formatRelativeTime(NOW - 800 * 24 * 60 * 60_000, { now: NOW }), '2年前');

// 7) 未来时间兜底
assert.equal(formatRelativeTime(NOW + 10_000, { now: NOW }), '刚刚');

// 8) 非数字兜底空串
assert.equal(formatRelativeTime(Number.NaN, { now: NOW }), '');

// 9) 紧凑格式：now / m / h / d / mo / y
assert.equal(formatRelativeTimeShort(NOW, { now: NOW }), 'now');
assert.equal(formatRelativeTimeShort(NOW - 30_000, { now: NOW }), 'now');
assert.equal(formatRelativeTimeShort(NOW + 10_000, { now: NOW }), 'now');
assert.equal(formatRelativeTimeShort(NOW - 60_000, { now: NOW }), '1m');
assert.equal(formatRelativeTimeShort(NOW - 59 * 60_000, { now: NOW }), '59m');
assert.equal(formatRelativeTimeShort(NOW - 60 * 60_000, { now: NOW }), '1h');
assert.equal(formatRelativeTimeShort(NOW - 23 * 60 * 60_000, { now: NOW }), '23h');
assert.equal(formatRelativeTimeShort(NOW - 24 * 60 * 60_000, { now: NOW }), '1d');
assert.equal(formatRelativeTimeShort(NOW - 29 * 24 * 60 * 60_000, { now: NOW }), '29d');
assert.equal(formatRelativeTimeShort(NOW - 30 * 24 * 60 * 60_000, { now: NOW }), '1mo');
assert.equal(formatRelativeTimeShort(NOW - 300 * 24 * 60 * 60_000, { now: NOW }), '10mo');
assert.equal(formatRelativeTimeShort(NOW - 365 * 24 * 60 * 60_000, { now: NOW }), '1y');
assert.equal(formatRelativeTimeShort(NOW - 800 * 24 * 60 * 60_000, { now: NOW }), '2y');
assert.equal(formatRelativeTimeShort(Number.NaN, { now: NOW }), '');

console.log('relative-time: 22 assertions passed');
