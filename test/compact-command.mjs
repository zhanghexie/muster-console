/**
 * 手动上下文压缩（/compact）回归：
 * 1) 能力表 manualCompact 只对 pi 开（渲染层列命令 / Host 拒绝同源）；
 * 2) parseCompactCommand 三处调用点共用的命令解析（裸命令 / 带摘要侧重 / 大小写 / 非命令）；
 * 3) safeCompactSession 归一（旧 SDK 缺方法 / 成功字段收敛 / 引擎抛错）；
 * 4) formatCompactResult 文案分支。
 * 运行: node test/compact-command.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-command-'));
const compile = createSharedCompiler(root, tmp);

const { CHAT_RUNTIME_CAPABILITIES } = await import(
  pathToFileURL(compile('shared/agentRuntimeCapabilities.ts')).href
);
const { parseCompactCommand } = await import(
  pathToFileURL(compile('shared/compactCommand.ts')).href
);
const { safeCompactSession, formatCompactResult } = await import(
  pathToFileURL(compile('shared/piEvents.ts')).href
);

// ── 1) 能力位：pi 独有；其余 runtime 明确关闭 ──
for (const [id, caps] of Object.entries(CHAT_RUNTIME_CAPABILITIES)) {
  assert.equal(
    caps.manualCompact,
    id === 'pi',
    `${id} 的 manualCompact 应为 ${id === 'pi'}`
  );
  assert.equal(
    caps.autoCompact,
    id === 'pi',
    `${id} 的 autoCompact 应为 ${id === 'pi'}`
  );
}

// ── 2) 命令解析 ──
assert.deepEqual(parseCompactCommand('/compact'), {});
assert.deepEqual(parseCompactCommand('/Compact'), {}, '大小写不敏感');
assert.deepEqual(parseCompactCommand('  /compact  '), {}, '首尾空白容忍');
assert.deepEqual(
  parseCompactCommand('/compact 保留 API 改动与文件路径'),
  { instructions: '保留 API 改动与文件路径' },
  '携带摘要侧重'
);
assert.equal(parseCompactCommand('/compactfoo'), null, '前缀粘连不是命令');
assert.equal(parseCompactCommand('/new'), null, '其他命令不匹配');
assert.equal(parseCompactCommand('请压缩一下上下文'), null, '普通文本不匹配');

// ── 3) safeCompactSession ──
{
  const r = await safeCompactSession({}, '/compact');
  assert.equal(r.ok, false, '缺 compact 方法（旧 SDK）→ 失败');
  if (!r.ok) assert.ok(r.error.length > 0, '失败必须带可读原因');
}
{
  const r = await safeCompactSession(null);
  assert.equal(r.ok, false, '无会话 → 失败');
}
{
  const calls = [];
  const session = {
    compact: async (instructions) => {
      calls.push(instructions);
      return { summary: '摘要', tokensBefore: 90000, estimatedTokensAfter: 'n/a' };
    }
  };
  const r = await safeCompactSession(session, '只保留结论');
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['只保留结论'], 'instructions 原样透传');
  if (r.ok) {
    assert.equal(r.summary, '摘要');
    assert.equal(r.tokensBefore, 90000);
    assert.equal(r.estimatedTokensAfter, null, '非 number 收敛为 null');
  }
  await safeCompactSession(session, '   ');
  assert.deepEqual(calls[1], undefined, '空白 instructions 归一为缺省（不传空串给引擎）');
}
{
  const session = {
    compact: async () => {
      throw new Error('Nothing to compact (session too small)');
    }
  };
  const r = await safeCompactSession(session);
  assert.equal(r.ok, false, '引擎抛错 → 归一失败，不炸调用方');
  if (!r.ok) assert.match(r.error, /session too small/);
}
{
  const calls = [];
  const session = {
    isStreaming: true,
    compact: async () => {
      calls.push('compact');
      return {};
    }
  };
  const r = await safeCompactSession(session);
  assert.equal(r.ok, false, 'SDK 仍在流式 → 拒压，不盲调 compact()');
  assert.deepEqual(calls, [], '流式中不得调用 session.compact（其内部 abort 会掐死摘要）');
  if (!r.ok) assert.match(r.error, /正忙|busy/i);
}
{
  const calls = [];
  const session = {
    isCompacting: true,
    compact: async () => {
      calls.push('compact');
      return {};
    }
  };
  const r = await safeCompactSession(session);
  assert.equal(r.ok, false, 'SDK 正在压缩 → 拒后一次');
  assert.deepEqual(calls, []);
  if (!r.ok) assert.match(r.error, /正在压缩|in progress/i);
}
{
  let release;
  let started = 0;
  const session = {
    compact: () => {
      started += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    }
  };
  const p1 = safeCompactSession(session);
  const p2 = safeCompactSession(session);
  const r2 = await p2;
  assert.equal(r2.ok, false, '重叠 compact 拒后一次，避免二次 abort 掐死第一次');
  if (!r2.ok) assert.match(r2.error, /正在压缩|in progress/i);
  assert.equal(started, 1, 'session.compact 只启动一次');
  release({ summary: 'ok', tokensBefore: 10, estimatedTokensAfter: 4 });
  const r1 = await p1;
  assert.equal(r1.ok, true, '第一次仍能正常完成');
}

// ── 4) 成功文案（插值为原始数字，无千分位）──
assert.match(
  formatCompactResult({ ok: true, tokensBefore: 90000, estimatedTokensAfter: 12000 }),
  /90000/,
  '含压缩前 tokens'
);
assert.match(
  formatCompactResult({ ok: true, tokensBefore: 90000, estimatedTokensAfter: 12000 }),
  /12000/,
  '含压缩后 tokens'
);
assert.match(
  formatCompactResult({ ok: true, tokensBefore: 90000 }),
  /90000/,
  '只有压缩前时仍给出数字'
);
assert.equal(
  formatCompactResult({ ok: true }),
  '上下文已压缩',
  '无数字时是最简文案（i18n key=中文原文）'
);

console.log('compact-command: all assertions passed');
