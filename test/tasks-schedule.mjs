/**
 * getNextRunAt：daily/weekly/interval 的边界与校验
 * 运行: node test/tasks-schedule.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// schedule.ts 现 import shared/i18n（i18next）：用带目录解析与 i18next shim 的 shared-compile
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsched-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('main/tasks/schedule.ts');
const { getNextRunAt, MAX_INTERVAL_MINUTES } = await import(pathToFileURL(outFile).href);

const at = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo, d, h, mi, s, ms);
const MIN = 60_000;

// ---------- interval ----------
assert.equal(getNextRunAt({ kind: 'interval', intervalMinutes: 30 }, at(2026, 0, 1, 8)), at(2026, 0, 1, 8, 30).getTime());
assert.equal(
  getNextRunAt({ kind: 'interval', intervalMinutes: MAX_INTERVAL_MINUTES }, at(2026, 0, 1, 8)),
  at(2026, 0, 1, 8).getTime() + MAX_INTERVAL_MINUTES * MIN
);
for (const bad of [0, -1, 1.5, NaN]) {
  assert.throws(() => getNextRunAt({ kind: 'interval', intervalMinutes: bad }, at(2026, 0, 1)), /正整数/);
}
assert.throws(
  () => getNextRunAt({ kind: 'interval', intervalMinutes: MAX_INTERVAL_MINUTES + 1 }, at(2026, 0, 1)),
  /上限/
);
console.log('ok: interval 校验与计算');

// ---------- daily ----------
assert.equal(getNextRunAt({ kind: 'daily', time: '09:00' }, at(2026, 0, 1, 8)), at(2026, 0, 1, 9).getTime());
assert.equal(getNextRunAt({ kind: 'daily', time: '09:00' }, at(2026, 0, 1, 10)), at(2026, 0, 2, 9).getTime());
// 恰好在触发时间那一瞬：属于「已过」，排到明天
assert.equal(getNextRunAt({ kind: 'daily', time: '09:00' }, at(2026, 0, 1, 9)), at(2026, 0, 2, 9).getTime());
// 跨月（setDate 语义）：1 月 31 日 23:45 → 2 月 1 日
assert.equal(getNextRunAt({ kind: 'daily', time: '23:30' }, at(2026, 0, 31, 23, 45)), at(2026, 1, 1, 23, 30).getTime());
// 跨年
assert.equal(getNextRunAt({ kind: 'daily', time: '00:05' }, at(2026, 11, 31, 23)), at(2027, 0, 1, 0, 5).getTime());
for (const bad of ['9:00', '09:60', '24:00', '', '0900']) {
  assert.throws(() => getNextRunAt({ kind: 'daily', time: bad }, at(2026, 0, 1)), /HH:mm/);
}
console.log('ok: daily 校验、当日已过/未过、跨月跨年');

// ---------- weekly（2026-01-01 是周四=4）----------
assert.equal(
  getNextRunAt({ kind: 'weekly', time: '09:00', weekdays: [1] }, at(2026, 0, 1, 10)),
  at(2026, 0, 5, 9).getTime(),
  '周四 → 下周一'
);
assert.equal(
  getNextRunAt({ kind: 'weekly', time: '09:00', weekdays: [4] }, at(2026, 0, 1, 8)),
  at(2026, 0, 1, 9).getTime(),
  '周四当天时间未过 → 今天'
);
assert.equal(
  getNextRunAt({ kind: 'weekly', time: '09:00', weekdays: [4] }, at(2026, 0, 1, 10)),
  at(2026, 0, 8, 9).getTime(),
  '周四当天时间已过 → 下周四'
);
assert.equal(
  getNextRunAt({ kind: 'weekly', time: '09:00', weekdays: [5, 1, 3] }, at(2026, 0, 1, 10)),
  at(2026, 0, 2, 9).getTime(),
  '乱序多天 [5,1,3]：周四之后最近的是周五'
);
assert.equal(
  getNextRunAt({ kind: 'weekly', time: '09:00', weekdays: [1, 3] }, at(2026, 0, 1, 10)),
  at(2026, 0, 5, 9).getTime(),
  '多天 [1,3] 本周已无命中 → 跨周到下周一'
);
assert.equal(
  getNextRunAt({ kind: 'weekly', time: '09:00', weekdays: [6, 0] }, at(2026, 0, 2, 10)),
  at(2026, 0, 3, 9).getTime(),
  '周六已过 → 周日'
);
// 重复与非法 weekday：去重后仍有有效值
assert.equal(
  getNextRunAt({ kind: 'weekly', time: '09:00', weekdays: [4, 4, 7, 9] }, at(2026, 0, 1, 8)),
  at(2026, 0, 1, 9).getTime(),
  '重复/越界 weekday 被过滤后仍命中周四'
);
for (const bad of [[], [7], [-1], [1.5]]) {
  assert.throws(() => getNextRunAt({ kind: 'weekly', time: '09:00', weekdays: bad }, at(2026, 0, 1)), /不能为空/);
}
console.log('ok: weekly 多天排序、当天已过、去重过滤、空集报错');
