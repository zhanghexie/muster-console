/**
 * shared/usageStats 纯函数自测：日分桶 key、脏数据归一、裁剪窗口、补零序列、排行与合并。
 * 运行: node test/usage-stats.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function transpile(entry) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stats-'));
  const outFile = path.join(tmp, path.basename(entry).replace(/\.ts$/, '.mjs'));
  const src = fs.readFileSync(entry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
  return import(pathToFileURL(outFile).href);
}

const {
  emptyUsageDay,
  usageDayKey,
  normalizeUsageDays,
  dropFutureUsageDays,
  pruneUsageDays,
  pruneUsageLlmCalls,
  normalizeUsageLlmCalls,
  recentUsageDays,
  sumCounts,
  rankToolCalls,
  mergeUsageDays,
  addUsageDays,
  rangeUsageDays,
  mergeUsageDaysInRange
} = await transpile(path.join(root, 'src/shared/usageStats.ts'));

const DAY = 24 * 60 * 60 * 1000;

// ---- usageDayKey：本地日、补零 ----
{
  const ts0 = new Date(2026, 0, 5, 0, 0, 1).getTime();
  assert.equal(usageDayKey(ts0), '2026-01-05');
  const tsLate = new Date(2026, 11, 31, 23, 59, 59).getTime();
  assert.equal(usageDayKey(tsLate), '2026-12-31');
}

// ---- normalizeUsageDays：脏值/缺字段/非法 key 不炸 ----
{
  const out = normalizeUsageDays({
    '2026-01-01': { dispatchTurns: 3, toolCalls: { 'sessions.observe': 2, bad: -1 }, junk: 'x' },
    'not-a-date': { dispatchTurns: 9 },
    '2026-01-02': null,
    '2026-01-03': { agentSessions: '5', headlessRuns: 2.9 }
  });
  assert.deepEqual(Object.keys(out).sort(), ['2026-01-01', '2026-01-03']);
  assert.equal(out['2026-01-01'].dispatchTurns, 3);
  assert.deepEqual(out['2026-01-01'].toolCalls, { 'sessions.observe': 2 });
  assert.equal(out['2026-01-01'].agentSessions, 0);
  assert.equal(out['2026-01-03'].agentSessions, 0); // 字符串不算数
  assert.equal(out['2026-01-03'].headlessRuns, 2); // 向下取整
  assert.equal(out['2026-01-01'].extLlmCalls, 0);
  assert.equal(normalizeUsageDays(null)['2026-01-01'], undefined);
}

// ---- pruneUsageDays：保留窗口内（含今天），未来 key 丢弃 ----
{
  const now = new Date(2026, 5, 15, 12).getTime();
  const days = {};
  days[usageDayKey(now)] = emptyUsageDay();
  days[usageDayKey(now - 29 * DAY)] = emptyUsageDay();
  days[usageDayKey(now - 30 * DAY)] = emptyUsageDay();
  days[usageDayKey(now + DAY)] = emptyUsageDay();
  const pruned = pruneUsageDays(days, now, 30);
  assert.ok(pruned[usageDayKey(now)]);
  assert.ok(pruned[usageDayKey(now - 29 * DAY)]);
  assert.equal(pruned[usageDayKey(now - 30 * DAY)], undefined);
  assert.equal(pruned[usageDayKey(now + DAY)], undefined);
}

// ---- recentUsageDays：升序、缺天补零、末位是今天 ----
{
  const now = new Date(2026, 5, 15, 12).getTime();
  const d = emptyUsageDay();
  d.dispatchTurns = 7;
  const days = { [usageDayKey(now - 2 * DAY)]: d };
  const recent = recentUsageDays(days, now, 7);
  assert.equal(recent.length, 7);
  assert.equal(recent[6].date, usageDayKey(now));
  assert.equal(recent[4].day.dispatchTurns, 7);
  assert.equal(recent[0].day.dispatchTurns, 0);
  for (let i = 1; i < recent.length; i++) {
    assert.ok(recent[i - 1].date < recent[i].date);
  }
}

// ---- sumCounts / rankToolCalls ----
{
  const day = emptyUsageDay();
  day.toolCalls = { 'terminal.send': 5, 'sessions.observe': 9, 'ui.confirm': 5 };
  day.toolErrors = { 'terminal.send': 2 };
  assert.equal(sumCounts(day.toolCalls), 19);
  const ranked = rankToolCalls(day);
  assert.deepEqual(
    ranked.map((r) => r.name),
    ['sessions.observe', 'terminal.send', 'ui.confirm'] // 同次数按名称稳定
  );
  assert.equal(ranked[1].errors, 2);
  assert.equal(rankToolCalls(day, 2).length, 2);
}

// ---- mergeUsageDays ----
{
  const a = emptyUsageDay();
  a.dispatchTurns = 2;
  a.toolCalls = { 'sessions.observe': 1 };
  a.sessionsByRuntime = { 'cursor-cli': 1 };
  const b = emptyUsageDay();
  b.dispatchTurns = 3;
  b.toolCalls = { 'sessions.observe': 4, 'ui.confirm': 1 };
  b.toolErrors = { 'ui.confirm': 1 };
  b.sessionsByRuntime = { 'cursor-cli': 2, 'claude-code': 1 };
  a.extLlmCalls = 2;
  a.extLlmByExt = { journal: 2 };
  b.extLlmCalls = 1;
  b.extLlmErrors = 1;
  b.extLlmByExt = { journal: 1, other: 1 };
  const merged = mergeUsageDays([a, b]);
  assert.equal(merged.dispatchTurns, 5);
  assert.deepEqual(merged.toolCalls, { 'sessions.observe': 5, 'ui.confirm': 1 });
  assert.deepEqual(merged.toolErrors, { 'ui.confirm': 1 });
  assert.deepEqual(merged.sessionsByRuntime, { 'cursor-cli': 3, 'claude-code': 1 });
  assert.equal(merged.extLlmCalls, 3);
  assert.equal(merged.extLlmErrors, 1);
  assert.deepEqual(merged.extLlmByExt, { journal: 3, other: 1 });
}

// ---- dropFutureUsageDays：旧桶留下，未来 key 丢掉 ----
{
  const now = new Date(2026, 5, 15, 12).getTime();
  const days = {};
  days[usageDayKey(now - 90 * DAY)] = emptyUsageDay();
  days[usageDayKey(now)] = emptyUsageDay();
  days[usageDayKey(now + DAY)] = emptyUsageDay();
  const kept = dropFutureUsageDays(days, now);
  assert.ok(kept[usageDayKey(now - 90 * DAY)]);
  assert.ok(kept[usageDayKey(now)]);
  assert.equal(kept[usageDayKey(now + DAY)], undefined);
}

// ---- normalize / prune LLM 明细：7 个本地日窗口 ----
{
  const now = new Date(2026, 5, 15, 12).getTime();
  const raw = [
    { id: 'a', startedAt: now, ok: true, extId: 'journal', messages: [{ role: 'user', content: 'hi' }], text: 'ok' },
    { id: 'old', startedAt: now - 7 * DAY, ok: true, extId: 'journal', messages: [] },
    { junk: true },
    { startedAt: now - 2 * DAY, extId: 'x', messages: [{ role: 'nope', content: 'z' }, { role: 'user', content: 'q' }] }
  ];
  const calls = normalizeUsageLlmCalls(raw);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].extId, 'journal');
  assert.equal(calls[2].messages.length, 1);
  const pruned = pruneUsageLlmCalls(calls, now, 7);
  assert.ok(pruned.some((c) => c.id === 'a'));
  assert.ok(!pruned.some((c) => c.id === 'old'));
  assert.equal(pruned[0].startedAt >= pruned[pruned.length - 1].startedAt, true);
}

// ---- llm 明细：默认 30 天窗口 + 条数上限（丢最旧） ----
{
  const now = new Date(2026, 5, 15, 12).getTime();
  const raw = [];
  for (let i = 0; i < 1005; i++) {
    raw.push({ id: `e${i}`, startedAt: now - i * 60_000, ok: true, extId: 'x', messages: [] }); // 同日内 1005 条
  }
  const pruned = pruneUsageLlmCalls(raw, now);
  assert.equal(pruned.length, 1000, '上限 1000');
  assert.equal(pruned[0].id, 'e0', '保留最新');
  assert.ok(!pruned.some((c) => c.id === 'e1004'), '丢最旧');
  const windowRaw = [
    { id: 'in', startedAt: now - 20 * DAY, ok: true, extId: 'x', messages: [] },
    { id: 'out', startedAt: now - 31 * DAY, ok: true, extId: 'x', messages: [] }
  ];
  const window30 = pruneUsageLlmCalls(windowRaw, now);
  assert.ok(window30.some((c) => c.id === 'in'), '默认保留窗口 30 天');
  assert.ok(!window30.some((c) => c.id === 'out'), '31 天前丢弃');
}

// ---- addUsageDays / rangeUsageDays：日历算法（跨月/跨年、端点含入、缺天补零） ----
{
  assert.equal(addUsageDays('2026-01-31', 1), '2026-02-01', '跨月进位');
  assert.equal(addUsageDays('2026-03-01', -1), '2026-02-28', '跨月退位（非闰年）');
  assert.equal(addUsageDays('2026-12-31', 1), '2027-01-01', '跨年');
  assert.equal(addUsageDays('bad-key', 1), 'bad-key', '非法 key 原样返回');
  assert.equal(addUsageDays('2026-06-10', 0), '2026-06-10');

  const d = emptyUsageDay();
  d.headlessRuns = 4;
  const seq = rangeUsageDays({ '2026-03-08': d }, '2026-03-07', '2026-03-10');
  assert.deepEqual(
    seq.map((r) => r.date),
    ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'],
    '升序、端点含入（日历算法不依赖 24h 乘法）'
  );
  assert.equal(seq[1].day.headlessRuns, 4, '命中的桶带数据');
  assert.equal(seq[0].day.headlessRuns, 0, '缺天补零');
  assert.equal(rangeUsageDays({}, '2026-03-07', '2026-03-09').length, 3, '春令时周末仍是 3 个日历日');
  assert.deepEqual(rangeUsageDays({}, '2026-03-10', '2026-03-07'), [], '倒序返回空');
  assert.deepEqual(rangeUsageDays({}, 'bad', '2026-03-07'), [], '非法 key 返回空');
  assert.equal(rangeUsageDays({}, '2026-01-01', '2026-12-31').length, 365, '全年序列');
  assert.equal(rangeUsageDays({}, '2025-01-01', '2027-01-01').length, 366, '超 366 天截断');
}

// ---- mergeUsageDaysInRange：只合并存在桶，窗口外/空窗不串 ----
{
  const a = emptyUsageDay();
  a.dispatchTurns = 2;
  const b = emptyUsageDay();
  b.dispatchTurns = 3;
  b.headlessRuns = 1;
  const merged = mergeUsageDaysInRange(
    { '2026-06-01': a, '2026-06-03': b, '2026-07-01': a },
    '2026-06-01',
    '2026-06-30'
  );
  assert.equal(merged.dispatchTurns, 5, '窗口内累计');
  assert.equal(merged.headlessRuns, 1, '窗口外不串入');
  assert.equal(mergeUsageDaysInRange({}, '2026-06-01', '2026-06-30').dispatchTurns, 0, '空窗零桶');
}

// ---- recentUsageDays 复用日历算法（DST 边界不重不漏） ----
{
  const now = new Date(2026, 5, 15, 12).getTime();
  const d = emptyUsageDay();
  d.dispatchTurns = 7;
  const days = { [usageDayKey(now - 2 * DAY)]: d };
  const recent = recentUsageDays(days, now, 7);
  assert.equal(recent.length, 7);
  assert.equal(recent[6].date, usageDayKey(now));
  assert.equal(recent[4].day.dispatchTurns, 7);
  assert.equal(recent[0].day.dispatchTurns, 0);
  const uniq = new Set(recent.map((r) => r.date));
  assert.equal(uniq.size, 7, '日期不重复');
}

// ---- usage F-01（reliability/usage-stats）：service 落盘前错误脱敏链 ----
// recordExtLlmCall 的 error 必须复用 recordToolCall 的 REDACT 链（Bearer/键值对/
// sk- 前缀），两类明细不再双口径。还原修复（error 直存）时含密断言转红。
{
  const { createSharedCompiler } = await import('./helpers/shared-compile.mjs');
  const tmpSvc = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-svc-'));
  const compileSvc = createSharedCompiler(root, tmpSvc);
  const { UsageStatsService } = await import(
    pathToFileURL(compileSvc('main/usage/service.ts')).href
  );
  const persisted = { llmCalls: null, toolFailures: null, days: null };
  const store = {
    loadUsageStats: () => ({}),
    loadUsageLlmCalls: () => [],
    loadUsageToolFailures: () => [],
    saveUsageStats: (v) => { persisted.days = v; },
    saveUsageLlmCalls: (v) => { persisted.llmCalls = v; },
    saveUsageToolFailures: (v) => { persisted.toolFailures = v; }
  };
  const svc = new UsageStatsService(store);
  const dirtyError = [
    '请求失败：Bearer sk-abc123XYZ_live 失效，',
    'api_key="Hunter2 \\u0041"',
    ' x-api-key=myPlainSecret123 ',
    '上游回显: password=hunter2password'
  ].join('');

  svc.recordToolCall('browser.open', false, { error: dirtyError });
  const toolErr = persisted.toolFailures[0].error;
  svc.recordExtLlmCall({
    extId: 'ext-1',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 100,
    temperature: 0.1,
    ok: false,
    error: dirtyError,
    durationMs: 42
  });
  const llmErr = persisted.llmCalls[0].error;

  for (const [label, text] of [['toolFailures', toolErr], ['llmCalls', llmErr]]) {
    assert.ok(!text.includes('sk-abc123XYZ_live'), `${label}: Bearer/sk- 凭据脱敏`);
    assert.ok(!text.includes('myPlainSecret123'), `${label}: 裸键值凭据脱敏`);
    assert.ok(!text.includes('hunter2password'), `${label}: password= 凭据脱敏`);
    assert.ok(!text.includes('Hunter2'), `${label}: 引号包裹的凭据值脱敏`);
    assert.ok(text.includes('[REDACTED]'), `${label}: 有 REDACTED 标记`);
  }
  assert.ok(llmErr.length <= 2000, 'llm error 截断 2000（与 tool 失败同限）');
  // ok 调用不写 error 字段
  svc.recordExtLlmCall({
    extId: 'ext-1',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 100,
    temperature: 0.1,
    ok: true,
    text: 'fine',
    durationMs: 5
  });
  assert.equal(persisted.llmCalls[0].error, undefined, '成功调用无 error');
  fs.rmSync(tmpSvc, { recursive: true, force: true });
}

console.log('usage-stats: ok');
