/**
 * session-status 推送帧纯函数测试（T1.2）：解析矩阵 + 触发类词表守卫。
 * 帧构造在主进程（server.ts，拼 label），本文件只测 shared 侧契约：
 * 畸形帧/未知推送类型静默丢弃、多余字段不透传、phase 只认触发类三词。
 * Run: node test/web-push.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-push-'));

const entry = path.join(root, 'src', 'shared', 'webPush.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'webPush.mjs');
fs.writeFileSync(out, outputText, 'utf8');
const { isSessionStatusPushPhase, parseSessionStatusPush } = await import(pathToFileURL(out));

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
}

/* ── 触发类词表 ── */
ok(isSessionStatusPushPhase('needs_you'), 'needs_you 是触发类');
ok(isSessionStatusPushPhase('done'), 'done 是触发类');
ok(isSessionStatusPushPhase('error'), 'error 是触发类');
ok(!isSessionStatusPushPhase('waiting'), 'BoardStatus waiting 不是推送 phase（推导态全集不进帧）');
ok(!isSessionStatusPushPhase('blocked'), 'BoardStatus blocked 不进帧（总线已归并为 needs_you）');
ok(!isSessionStatusPushPhase('active'), 'active 不触发推送');
ok(!isSessionStatusPushPhase(undefined), 'undefined 拒绝');
ok(!isSessionStatusPushPhase(1), '非字符串拒绝');

/* ── 解析：合法帧 ── */
const frame = {
  t: 'push',
  type: 'session-status',
  sessionId: 'sess-1',
  phase: 'needs_you',
  label: '修登录 bug · 需要你'
};
const parsed = parseSessionStatusPush(frame);
ok(parsed !== null, '合法帧解析成功');
assert.deepEqual(parsed, {
  type: 'session-status',
  sessionId: 'sess-1',
  phase: 'needs_you',
  label: '修登录 bug · 需要你'
});
ok(parsed.t === undefined, '传输信封字段（t）不透传');
passed++;

/* sessionId/label 首尾空白裁剪 */
assert.deepEqual(
  parseSessionStatusPush({ type: 'session-status', sessionId: ' s ', phase: 'done', label: ' x ' }),
  { type: 'session-status', sessionId: 's', phase: 'done', label: 'x' }
);
passed++;

/* ── 解析：拒绝矩阵（畸形帧静默丢弃，shim 不炸） ── */
const rejects = [
  [null, 'null'],
  [undefined, 'undefined'],
  ['session-status', '裸字符串'],
  [42, '数字'],
  [[], '数组'],
  [{}, '空对象（缺全部字段）'],
  [{ type: 'other-push', sessionId: 's', phase: 'done', label: 'x' }, '未知推送类型'],
  [{ type: 'session-status', phase: 'done', label: 'x' }, '缺 sessionId'],
  [{ type: 'session-status', sessionId: '', phase: 'done', label: 'x' }, 'sessionId 空串'],
  [{ type: 'session-status', sessionId: '  ', phase: 'done', label: 'x' }, 'sessionId 纯空白'],
  [{ type: 'session-status', sessionId: 7, phase: 'done', label: 'x' }, 'sessionId 非字符串'],
  [{ type: 'session-status', sessionId: 's', label: 'x' }, '缺 phase'],
  [{ type: 'session-status', sessionId: 's', phase: 'waiting', label: 'x' }, 'phase 越词表（推导态混入）'],
  [{ type: 'session-status', sessionId: 's', phase: null, label: 'x' }, 'phase null'],
  [{ type: 'session-status', sessionId: 's', phase: 'done' }, '缺 label'],
  [{ type: 'session-status', sessionId: 's', phase: 'done', label: '' }, 'label 空串'],
  [{ type: 'session-status', sessionId: 's', phase: 'done', label: '   ' }, 'label 纯空白'],
  [{ type: 'session-status', sessionId: 's', phase: 'done', label: { text: 'x' } }, 'label 非字符串']
];
for (const [raw, label] of rejects) {
  ok(parseSessionStatusPush(raw) === null, `拒绝：${label}`);
}

/* 多余字段不透传（未来扩展字段不悄悄漏进 UI） */
const extra = parseSessionStatusPush({
  type: 'session-status',
  sessionId: 's',
  phase: 'error',
  label: 'x',
  ts: 123,
  workspaceId: 'w'
});
ok(extra !== null && extra.ts === undefined && extra.workspaceId === undefined, '多余字段不透传');

console.log(`web-push: ${passed} 项断言全部通过`);
