/**
 * X3-F11 回归：损坏静默回空低危族（守卫状态 / 工作流触发状态 / 声明信任账本 / 放行规则）
 * 补 console.warn 诊断线索——损坏（坏 JSON 或不可读）回空时 warn 一条（含文件路径与错误摘要），
 * 「从未写过」（ENOENT）保持静默；回退行为不变（仍是空/默认值）。
 * 运行: node test/x3-f11-corruption-diagnostics.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-f11-'));
const compile = createSharedCompiler(root, tmp);

const { OrchestratorGuardStateStore } = await import(
  pathToFileURL(compile('main/orchestrator/guardStateStore.ts')).href
);
const { readTriggerState } = await import(pathToFileURL(compile('main/workflow/store.ts')).href);
const {
  setDeclarationTrustUserDataDir, readDeclarationTrustBook, emptyDeclarationTrustBook
} = await import(pathToFileURL(compile('main/agent/declarationTrustStore.ts')).href);
const { AlwaysRuleStore } = await import(pathToFileURL(compile('main/capabilities/alwaysRules.ts')).href);

/** 捕获 console.warn（测试期内替换，返回 [warnings, restore]） */
function captureWarn() {
  const seen = [];
  const orig = console.warn;
  console.warn = (...args) => { seen.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')); };
  return [seen, () => { console.warn = orig; }];
}

function testGuardStateStore() {
  const dir = path.join(tmp, 'guard');
  fs.mkdirSync(dir, { recursive: true });
  const store = new OrchestratorGuardStateStore(dir);
  const file = store.filePath;

  // 缺失：正常首启，静默回空
  let [w, restore] = captureWarn();
  let state = store.read();
  restore();
  assert.deepEqual(state.fired, {}, '缺失文件按空起步');
  assert.equal(w.length, 0, 'ENOENT 不打扰');

  // 损坏：回空不变，但留诊断（含路径）
  fs.writeFileSync(file, '{"fired":');
  [w, restore] = captureWarn();
  state = store.read();
  restore();
  assert.deepEqual(state.fired, {}, '损坏回空行为不变（宁可重报不漏报）');
  assert.equal(w.length, 1, '损坏 warn 一条');
  assert.ok(w[0].includes(file), 'warn 带文件路径');
  assert.ok(w[0].length > file.length + 10, 'warn 带错误摘要');

  // 完好：正常读，无 warn
  store.write({ fired: { 'g1:x': 123 }, lastActivity: { 'g1': 456 } });
  [w, restore] = captureWarn();
  state = store.read();
  restore();
  assert.equal(state.fired['g1:x'], 123, '完好文件正常读');
  assert.equal(w.length, 0, '完好文件不 warn');
}

function testWorkflowTriggerState() {
  const ws = path.join(tmp, 'ws-trigger');
  fs.mkdirSync(path.join(ws, '.muster', 'scheduler'), { recursive: true });
  const file = path.join(ws, '.muster', 'scheduler', 'workflow-triggers.json');

  let [w, restore] = captureWarn();
  let st = readTriggerState(ws);
  restore();
  assert.deepEqual(st, {}, '缺失（新工作区）按空触发状态');
  assert.equal(w.length, 0, 'ENOENT 静默');

  fs.writeFileSync(file, 'not json at all');
  [w, restore] = captureWarn();
  st = readTriggerState(ws);
  restore();
  assert.deepEqual(st, {}, '坏 JSON 回空行为不变');
  assert.equal(w.length, 1, '损坏 warn 一条');
  assert.ok(w[0].includes(file), 'warn 带文件路径');

  fs.writeFileSync(file, JSON.stringify({ demo: { anchorAt: 5, disabled: true } }));
  [w, restore] = captureWarn();
  st = readTriggerState(ws);
  restore();
  assert.equal(st.demo.anchorAt, 5, '完好文件正常读');
  assert.equal(st.demo.disabled, true);
  assert.equal(w.length, 0, '完好文件不 warn');
}

function testDeclarationTrustBook() {
  setDeclarationTrustUserDataDir(path.join(tmp, 'trust-ud'));
  const ws = 'ws-trust';
  const file = path.join(tmp, 'trust-ud', 'declaration-trust', `${ws}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let [w, restore] = captureWarn();
  let book = readDeclarationTrustBook(ws);
  restore();
  assert.deepEqual(book, emptyDeclarationTrustBook(), '缺失（从未确认过）按空账本');
  assert.equal(w.length, 0, 'ENOENT 静默');

  fs.writeFileSync(file, '{oops');
  [w, restore] = captureWarn();
  book = readDeclarationTrustBook(ws);
  restore();
  assert.deepEqual(book, emptyDeclarationTrustBook(), '损坏回空账本行为不变（重新确认即可重建）');
  assert.equal(w.length, 1, '损坏 warn 一条');
  assert.ok(w[0].includes(file), 'warn 带文件路径');

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: {} }));
  [w, restore] = captureWarn();
  book = readDeclarationTrustBook(ws);
  restore();
  assert.deepEqual(book, { schemaVersion: 1, entries: {} }, '完好文件正常读');
  assert.equal(w.length, 0, '完好文件不 warn');
}

function testAlwaysRules() {
  const file = path.join(tmp, 'permission-always-rules.json');
  const store = new AlwaysRuleStore(file);

  let [w, restore] = captureWarn();
  assert.equal(store.size, 0, '缺失文件按空规则');
  restore();
  assert.equal(w.length, 0, 'ENOENT 静默');

  fs.writeFileSync(file, '{"version":1,"rules":[');
  // load() 首次后缓存，损坏路径须用新实例触发重读
  const corruptStore = new AlwaysRuleStore(file);
  [w, restore] = captureWarn();
  assert.equal(corruptStore.size, 0, '损坏回空规则行为不变（逐次审批即可）');
  restore();
  assert.equal(w.length, 1, '损坏 warn 一条');
  assert.ok(w[0].includes(file), 'warn 带文件路径');

  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    rules: [{ fingerprint: 'fp1', scope: 'global', scopeKey: 'global', effect: 'allow', createdAt: 1 }]
  }));
  const store2 = new AlwaysRuleStore(file);
  [w, restore] = captureWarn();
  assert.equal(store2.size, 1, '完好文件正常读');
  restore();
  assert.equal(w.length, 0, '完好文件不 warn');
}

const tests = [
  ['guardStateStore：损坏 warn/ENOENT 静默/行为不变', testGuardStateStore],
  ['workflow readTriggerState：损坏 warn/ENOENT 静默/行为不变', testWorkflowTriggerState],
  ['declarationTrustStore：损坏 warn/ENOENT 静默/行为不变', testDeclarationTrustBook],
  ['alwaysRules：损坏 warn/ENOENT 静默/行为不变', testAlwaysRules]
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
console.log(`${tests.length - failed}/${tests.length} passed`);
