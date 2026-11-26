/**
 * 交接 idle 防抖状态机。
 * Run: node test/handover-wait.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-wait-'));
const entry = path.join(root, 'src/shared/handoverWait.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'handoverWait.mjs');
fs.writeFileSync(out, outputText, 'utf8');
const {
  createHandoverWait,
  handoverWaitTick,
  handoverFileReady,
  handoverLooksComplete,
  HANDOVER_IDLE_DEBOUNCE_MS,
  HANDOVER_TIMEOUT_MS,
  HANDOVER_HARD_TIMEOUT_MS
} = await import(pathToFileURL(out).href);

assert.equal(handoverFileReady(''), false);
assert.equal(handoverFileReady('   \n'), false);
assert.equal(handoverFileReady(null), false);
assert.equal(handoverFileReady('# 交接\n内容'), true);

assert.equal(handoverLooksComplete(''), false);
assert.equal(
  handoverLooksComplete('## 任务背景与目标\n## 已完成与结论\n## 建议下一步\n正文'),
  true,
  '三个标题即算完整'
);
assert.equal(handoverLooksComplete('x'.repeat(400)), true, '超长正文也算完整');
assert.equal(handoverLooksComplete('短回复'), false);

const t0 = 1_000_000;
let s = createHandoverWait(t0);
let r = handoverWaitTick(s, t0 + 100, { working: false, idle: true, fileReady: true });
assert.equal(r.action, 'continue', '未见 working 时即使 idle+文件也不完成');
assert.equal(r.state.phase, 'wait-working');

r = handoverWaitTick(r.state, t0 + 200, { working: true, idle: false, fileReady: false });
assert.equal(r.state.seenWorking, true);
assert.equal(r.state.phase, 'wait-idle');

r = handoverWaitTick(r.state, t0 + 300, { working: false, idle: true, fileReady: false });
assert.equal(r.action, 'continue', '无文件不完成');
assert.equal(r.state.phase, 'wait-idle');

r = handoverWaitTick(r.state, t0 + 400, { working: false, idle: true, fileReady: true });
assert.equal(r.state.phase, 'debounce');
assert.equal(r.action, 'continue', '刚进防抖未到期');

r = handoverWaitTick(r.state, t0 + 400 + HANDOVER_IDLE_DEBOUNCE_MS - 1, {
  working: false,
  idle: true,
  fileReady: true
});
assert.equal(r.action, 'continue');

r = handoverWaitTick(r.state, t0 + 400 + HANDOVER_IDLE_DEBOUNCE_MS, {
  working: false,
  idle: true,
  fileReady: true
});
assert.equal(r.action, 'done');
assert.equal(r.state.phase, 'done');

// primed：不必等 working 边沿
s = createHandoverWait(t0, true);
r = handoverWaitTick(s, t0 + 1, { working: false, idle: true, fileReady: true });
assert.equal(r.state.phase, 'debounce');
r = handoverWaitTick(r.state, t0 + 1 + HANDOVER_IDLE_DEBOUNCE_MS, {
  working: false,
  idle: true,
  fileReady: true
});
assert.equal(r.action, 'done', 'primed 后 idle+文档即可完成');

// 防抖期间再次 working → 重置
s = createHandoverWait(t0);
r = handoverWaitTick(s, t0 + 1, { working: true, idle: false, fileReady: false });
r = handoverWaitTick(r.state, t0 + 2, { working: false, idle: true, fileReady: true });
const during = r.state.idleSince;
r = handoverWaitTick(r.state, t0 + 3, { working: true, idle: false, fileReady: true });
assert.equal(r.state.idleSince, null);
assert.notEqual(during, null);

// 仍在 working：150s 空闲超时不生效
s = createHandoverWait(t0, true);
r = handoverWaitTick(s, t0 + HANDOVER_TIMEOUT_MS, { working: true, idle: false, fileReady: false });
assert.equal(r.action, 'continue', '仍在 working 不走 150s 超时');

// 空闲无文档：150s 超时
s = createHandoverWait(t0, true);
r = handoverWaitTick(s, t0 + HANDOVER_TIMEOUT_MS, { working: false, idle: true, fileReady: false });
assert.equal(r.action, 'timeout', '空闲且无文档超时');

// 硬顶：working 太久也放弃
s = createHandoverWait(t0, true);
r = handoverWaitTick(s, t0 + HANDOVER_HARD_TIMEOUT_MS, {
  working: true,
  idle: false,
  fileReady: false
});
assert.equal(r.action, 'timeout', '10 分钟硬顶');

console.log('handover-wait: all assertions passed');
