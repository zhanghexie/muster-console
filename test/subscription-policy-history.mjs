/**
 * subscription-policy 补遗回归（可靠性专项 P3）：
 * - X3-F05：history JSONL 超 256KB 先滚动 .old 再追加（轮转后继续记账，不无界增长）；
 * - sub-policy F-02：history 追加失败时 write 返回 historyError（通知文案可转述，
 *   回滚材料缺失对用户可见）；策略本体不受影响照常写入；
 * - i18n：失败转述词条存在于 en 词条表（fragments/memory.ts 经 en.ts spread 合并）。
 * 运行: node test/subscription-policy-history.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-policy-history-'));
const compile = createSharedCompiler(root, tmp);

const { SubscriptionPolicyStore } = await import(
  pathToFileURL(compile('main/orchestrator/subscriptionPolicyStore.ts')).href
);
const { emptySubscriptionPolicy } = await import(
  pathToFileURL(compile('shared/subscriptionPolicy.ts')).href
);
const { en } = await import(pathToFileURL(compile('shared/i18n/locales/en.ts')).href);

const store = new SubscriptionPolicyStore();
function newWs(name) {
  const ws = path.join(tmp, name);
  fs.mkdirSync(path.join(ws, '.muster', 'scheduler'), { recursive: true });
  return ws;
}
const policyWithRule = (id) => ({
  ...emptySubscriptionPolicy(),
  rules: [{ id, match: { kind: 'phase' }, action: 'wake' }]
});

function testHistoryRotation() {
  const ws = newWs('rotation');
  const hist = store.historyPath(ws);
  // 预置超过 256KB 的历史账
  fs.writeFileSync(hist, 'x'.repeat(256 * 1024 + 1));
  const res = store.write(ws, policyWithRule('r1'), { by: 'tester', reason: '轮转', now: 1700000000000 });
  assert.equal(res.historyError, undefined, '轮转+追加成功无失败信号');
  assert.ok(fs.existsSync(`${hist}.old`), '超限历史滚动为 .old');
  const rotated = fs.readFileSync(`${hist}.old`, 'utf8');
  assert.equal(rotated.length, 256 * 1024 + 1, '.old 保留原账全文');
  const cur = fs.readFileSync(hist, 'utf8').trim().split('\n');
  assert.equal(cur.length, 1, '轮转后新账只有本次一条');
  assert.equal(JSON.parse(cur[0]).reason, '轮转', '本次变更已记账');
  // 轮转可重复：再造超限账，旧 .old 被覆盖、不堆积
  fs.writeFileSync(hist, 'y'.repeat(256 * 1024 + 2));
  store.write(ws, policyWithRule('r2'), { by: 'tester', reason: '再轮转', now: 1700000000001 });
  assert.equal(fs.readFileSync(`${hist}.old`, 'utf8'), 'y'.repeat(256 * 1024 + 2), '.old 被最新一轮覆盖');
  assert.equal(JSON.parse(fs.readFileSync(hist, 'utf8').trim()).reason, '再轮转');
}

function testHistoryErrorSignal() {
  const ws = newWs('history-error');
  // 用目录占住 history 路径令 appendFile 失败（策略本体路径不受影响）
  fs.mkdirSync(store.historyPath(ws));
  const res = store.write(ws, policyWithRule('r9'), { by: 'tester', reason: '失败信号', now: 1700000000002 });
  assert.ok(typeof res.historyError === 'string' && res.historyError.length > 0, 'history 失败信号进返回值');
  assert.ok(fs.existsSync(store.filePath(ws)), '策略本体照常写入（history 失败不回滚本体）');
  // 恢复可写后，失败不留残余状态：本体可继续正常记账
  fs.rmSync(store.historyPath(ws), { recursive: true });
  const ok = store.write(ws, policyWithRule('r10'), { by: 'tester', reason: '恢复', now: 1700000000003 });
  assert.equal(ok.historyError, undefined, '路径恢复后记账正常');
  assert.ok(fs.existsSync(store.historyPath(ws)), 'history 恢复追加');
}

function testI18nHistoryErrorKey() {
  const key = '（变更历史记录失败：{{error}}，回滚材料缺失）';
  assert.ok(key in en, '失败转述词条存在于 en 词条表（fragments 经 en.ts spread）');
  assert.ok(en[key].includes('{{error}}'), '译文保留插值占位');
}

function testHostNotifyWiring() {
  // 工具层接线（source 断言）：hosts/subscriptionPolicy.ts 须把 historyError 转述进通知文案
  const host = fs.readFileSync(
    path.join(root, 'src', 'main', 'capabilities', 'hosts', 'subscriptionPolicy.ts'),
    'utf8'
  );
  assert.ok(host.includes('written.historyError'), '通知层读取 write 返回的 historyError');
  assert.ok(host.includes('（变更历史记录失败：{{error}}，回滚材料缺失）'), '失败信号以 i18n 词条拼进通知文案');
}

const tests = [
  ['history 超 256KB 滚动 .old 再追加（X3-F05）', testHistoryRotation],
  ['history 失败信号 historyError 进返回值，本体不受影响（F-02）', testHistoryErrorSignal],
  ['失败转述词条已入 en 词条表（F-02/i18n）', testI18nHistoryErrorKey],
  ['通知层转述 historyError 接线（F-02）', testHostNotifyWiring]
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
