/**
 * 崩溃现场证据的纯逻辑层：exitCode 语义翻译、console 环形缓冲、
 * render-process-gone / child-process-gone 日志条目拼装。
 * 还原补强（死因行去掉现场快照 / exitCode 注解 / 环形缓冲容量淘汰）时本文件应转红。
 * 运行: node test/crash-context.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-ctx-'));
const compile = createSharedCompiler(root, tmp);
const {
  CrashConsoleRing,
  CRASH_CONSOLE_DUMP_MAX,
  CRASH_CONSOLE_LINE_MAX,
  describeExitCode,
  buildRenderGoneEntry,
  formatChildGoneLine
} = await import(pathToFileURL(compile('shared/crashContext.ts')).href);

// ── exitCode 语义翻译 ──
assert.match(describeExitCode(143), /^143 \[sigterm-like/);
assert.match(describeExitCode(134), /sigabrt-like/);
assert.match(describeExitCode(3221225477), /access-violation/); // 0xC0000005 无符号形态
assert.match(describeExitCode(-1073741819), /access-violation/); // 同上的有符号形态
assert.match(describeExitCode(3221226505), /fail-fast/); // 0xC0000409（V8 OOM/CHECK 常见落点）
assert.match(describeExitCode(3221225725), /stack-overflow/); // 0xC00000FD
assert.match(describeExitCode(3221225780), /ntstatus 0xC0000134/); // 未收录的 NTSTATUS → hex
assert.equal(describeExitCode(1), '1'); // 普通小数值原样

// ── console 环形缓冲：容量淘汰 / 单条截断 / 空白折叠 / 空行忽略 ──
const ring = new CrashConsoleRing(8, 20);
ring.push('');
ring.push('  多行\n消息\t折叠  ');
ring.push('x'.repeat(30));
for (let i = 0; i < 5; i++) ring.push(`line-${i}`);
assert.deepEqual(ring.latest(20), ['多行 消息 折叠', `${'x'.repeat(20)}…`, 'line-0', 'line-1', 'line-2', 'line-3', 'line-4']);
ring.push('line-5');
ring.push('line-6'); // 超容量：最早的「多行」被挤出，只剩 8 条
assert.equal(ring.latest(20).length, 8);
assert.equal(ring.latest(20)[0], `${'x'.repeat(20)}…`);
assert.deepEqual(ring.latest(2), ['line-5', 'line-6']);
assert.deepEqual(new CrashConsoleRing().latest(3), []);

// ── render-process-gone 条目：首行可 grep 契约 + 现场快照 + console 截取 ──
const entry = buildRenderGoneEntry({
  reason: 'crashed',
  exitCode: 143,
  decisionNote: 'reload 1/2 in 60s window',
  url: 'file:///D:/app/out/renderer/index.html',
  mainRssBytes: 100 * 1048576,
  consoleLines: Array.from({ length: CRASH_CONSOLE_DUMP_MAX + 5 }, (_, i) => `console[i] msg-${i}`)
});
const entryLines = entry.split('\n');
assert.match(entryLines[0], /^\[renderer gone\] reason=crashed exitCode=143 \[sigterm-like external kill\] -> reload 1\/2/);
assert.equal(entryLines[1], '  ctx url=file:///D:/app/out/renderer/index.html mainRss=100MB');
assert.equal(entryLines.length, 2 + CRASH_CONSOLE_DUMP_MAX);
assert.equal(entryLines[2], `  console[i] msg-${5}`); // 只取最近 20 条
assert.equal(entryLines[entryLines.length - 1], `  console[i] msg-${CRASH_CONSOLE_DUMP_MAX + 4}`);

// 缺省字段：无内存 / 无 console 时条目不留空字段
const minimal = buildRenderGoneEntry({ reason: 'oom', exitCode: 0, decisionNote: 'note', url: '' });
assert.equal(minimal.split('\n').length, 2);
assert.equal(minimal.split('\n')[1], '  ctx url=(unknown)');
assert.ok(!minimal.includes('mainRss'));

// ── child-process-gone 单行：GPU/utility 死亡，name 可选 ──
const child = formatChildGoneLine({ type: 'GPU', reason: 'crashed', exitCode: 3221225477 });
assert.match(child, /^\[child gone\] type=GPU reason=crashed exitCode=3221225477 \[access-violation\]$/);
const util = formatChildGoneLine({ type: 'Utility', name: 'Audio Service', reason: 'killed', exitCode: 143 });
assert.match(util, /type=Utility name=Audio Service reason=killed exitCode=143 \[sigterm-like/);
assert.equal(CRASH_CONSOLE_LINE_MAX, 500);

console.log('crash-context: ok');
