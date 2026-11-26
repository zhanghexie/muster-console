/**
 * 主进程文件日志（黑匣子）：格式、落盘、轮转、console 接管、失败静默。
 * 还原修复（appendMainLog 去掉 rotate/静默，或 console 接管不落盘）时本文件应转红。
 * 运行: node test/main-log.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'main-log-'));
const compile = createSharedCompiler(root, tmp);
const { formatMainLogLine, MAIN_LOG_NAME, MAIN_LOG_MAX_BYTES } = await import(
  pathToFileURL(compile('shared/mainLog.ts')).href
);
const { appendMainLog, formatConsoleArgs, installMainConsoleCapture } = await import(
  pathToFileURL(compile('main/logs/mainLog.ts')).href
);

// ── 格式：ISO 时间戳 + 级别 + 文本（尾部换行修剪） ──
const line = formatMainLogLine(Date.UTC(2026, 8, 25, 5, 0, 13), 'error', 'boom\n');
assert.equal(line, '2026-09-25T05:00:13.000Z [error] boom');

// ── 落盘：两条进同一个 main.log，每行一条 ──
const userData = path.join(tmp, 'ud');
appendMainLog(userData, 'log', '[boot] window shown');
appendMainLog(userData, 'warn', 'watch out', MAIN_LOG_MAX_BYTES);
const file = path.join(userData, 'logs', MAIN_LOG_NAME);
const text = fs.readFileSync(file, 'utf8');
const lines = text.trim().split('\n');
assert.equal(lines.length, 2);
assert.match(lines[0], /\[log\] \[boot\] window shown$/);
assert.match(lines[1], /\[warn\] watch out$/);

// ── 轮转：超阈值滚到 .old，新文件只剩后写的行 ──
const ud2 = path.join(tmp, 'ud2');
appendMainLog(ud2, 'log', 'x'.repeat(80), 64);
appendMainLog(ud2, 'log', 'fresh after rotate', 64);
assert.ok(fs.existsSync(path.join(ud2, 'logs', `${MAIN_LOG_NAME}.old`)), '旧文件应滚为 .old');
assert.ok(fs.readFileSync(path.join(ud2, 'logs', MAIN_LOG_NAME), 'utf8').includes('fresh after rotate'));

// ── console 参数格式化：util.format 语义（占位符 + inspect + Error 栈） ──
const formatted = formatConsoleArgs(['agent failed:', { code: 7 }, new Error('stack-marker')]);
assert.ok(formatted.startsWith('agent failed:'), formatted);
assert.ok(formatted.includes("code: 7"), formatted);
assert.ok(formatted.includes('stack-marker'), formatted);

// ── console 接管：调用 console.warn 即落盘（原 stdout 仍走） ──
const ud3 = path.join(tmp, 'ud3');
const origWarn = console.warn;
installMainConsoleCapture(ud3);
console.warn('captured via console');
console.warn = origWarn;
assert.ok(fs.readFileSync(path.join(ud3, 'logs', MAIN_LOG_NAME), 'utf8').includes('captured via console'));

// ── 失败静默：userData 指到一个文件上（必然 mkdir/写失败）也不许抛 ──
const blocked = path.join(tmp, 'not-a-dir');
fs.writeFileSync(blocked, 'occupied', 'utf8');
assert.doesNotThrow(() => appendMainLog(blocked, 'error', 'must not throw'));

console.log('main-log: ok');
