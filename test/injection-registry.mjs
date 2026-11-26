/**
 * A3 注入 source 注册表 + C1 跨日 date-change reminder 回归（批次 R2）：
 * 1) 注册表完整性：id 唯一、必填字段齐全、target/channel/mode 枚举合法、
 *    survivesCompact 布尔、note 非空（计划定的宽容实现——完整性靠 review 惯例，
 *    不做反查 grep 的易碎测试）；
 * 2) CapabilitiesView.injections 结构兼容（设置页「注入清单」数据源）；
 * 3) C1 判定：首次锚定/同日不注/跨日注入/年末跨界/闰年边界/损坏记录降级/文案格式。
 * 运行: node test/injection-registry.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-registry-'));
const compile = createSharedCompiler(root, tmp);

const { INJECTION_REGISTRY, listInjections } = await import(
  pathToFileURL(compile('main/agent/injection-registry.ts')).href
);
const { en } = await import(pathToFileURL(compile('shared/i18n/locales/en.ts')).href);
const { t, applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);
const dateChange = await import(pathToFileURL(compile('shared/dateChangeReminder.ts')).href);
const { decideDateChangeReminder, localDateKey, DATE_CHANGE_REMINDER_TAG } = dateChange;

for (const id of ['scheduler.tool-schema.catalog', 'worker.tool-schema.host-tools']) {
  const note = INJECTION_REGISTRY.find(entry => entry.id === id)?.note ?? '';
  assert.match(note, /host\.desktop\.run 与 host\.panel\.run/);
  assert.doesNotMatch(note, /host\.desktop\.list 已注册|host\.desktop 尚未注册/);
}

// ── 1) 注册表完整性 ──
{
  assert.ok(INJECTION_REGISTRY.length >= 10, `现役注入点应有完整登记（当前 ${INJECTION_REGISTRY.length} 条）`);

  const ids = new Set();
  for (const s of INJECTION_REGISTRY) {
    assert.ok(s.id && typeof s.id === 'string', 'id 必填');
    assert.ok(!ids.has(s.id), `id 唯一：${s.id}`);
    ids.add(s.id);
    assert.ok(
      ['scheduler', 'worker', 'both'].includes(s.target),
      `${s.id} target 枚举合法`
    );
    assert.ok(
      ['system', 'tool-schema', 'turn-prefix', 'tool-result', 'event-wake', 'host-md', 'compact'].includes(s.channel),
      `${s.id} channel 枚举合法`
    );
    assert.ok(
      ['always', 'conditional'].includes(s.mode),
      `${s.id} mode 枚举合法`
    );
    assert.equal(typeof s.survivesCompact, 'boolean', `${s.id} survivesCompact 必须布尔`);
    assert.ok(typeof s.note === 'string' && s.note.trim().length > 0, `${s.id} note 非空（出处+边界）`);
    assert.ok(/\.(ts|tsx|mjs)/.test(s.note), `${s.id} note 应带代码出处（.ts/.tsx 文件引用）`);
  }
  // 关键注入点不许漏登记（计划点名的面）
  for (const must of [
    'engine.system.pi-skill-catalog',
    'scheduler.system.stable-body',
    'scheduler.system.catalog-map',
    // 工具定义是体量最大的注入面，漏登记即红
    'scheduler.tool-schema.catalog',
    'worker.tool-schema.host-tools',
    'scheduler.turn-prefix.memory-bucket',
    'scheduler.turn-prefix.situation',
    'scheduler.turn-prefix.date-change',
    'scheduler.event-wake.orch-events',
    'scheduler.event-wake.needs-you',
    'worker.turn-prefix.cli-host',
    'worker.turn-prefix.initial-assignment',
    'worker.turn-prefix.route-handoff',
    'scheduler.system.worker-routing',
    'both.turn-prefix.worker-model-reference',
    'worker.tool-schema.pty-http',
    'worker.turn-prefix.gui-policy',
    'worker.turn-prefix.workspace-context',
    'worker.brief.mail-continuity',
    'memory.curator.system',
    'memory.curator.candidate',
    'memory.curator.user-input',
    'memory.curator.receipt-repair',
    'memory.curator.compaction',
    'scheduler.compact.micro-instructions',
    'scheduler.compact.summary-template',
    'scheduler.turn-prefix.transcript-pointer'
  ]) {
    assert.ok(ids.has(must), `关键注入点 ${must} 必须登记`);
  }
  assert.equal(ids.has('worker.turn-prefix.delegate-brief'),false,'retired task delegation injection must not return');
  // listInjections() 与表同源（设置页消费口）
  assert.equal(listInjections(), INJECTION_REGISTRY);
  assert.deepEqual(listInjections().map((s) => s.id), INJECTION_REGISTRY.map((s) => s.id));
  const original = JSON.stringify(INJECTION_REGISTRY);
  applyLocaleSetting('en');
  for (const item of INJECTION_REGISTRY) {
    assert.ok(Object.hasOwn(en, item.note), `${item.id}: English note`);
    assert.equal(t(item.note), en[item.note], `${item.id}: displayed note resolves exactly`);
  }
  applyLocaleSetting('zh-CN');
  assert.equal(JSON.stringify(INJECTION_REGISTRY), original, 'language switching must not modify registry or trust digest input');
  console.log(`ok   注册表完整性（${INJECTION_REGISTRY.length} 条，id 唯一/枚举合法/note 带出处）`);
}

// ── 2) CapabilitiesView.injections 结构兼容 ──
{
  // shared/types.ts 的内联结构：字段名与字面量集合一致即可赋值（结构化类型）
  const viewShaped = INJECTION_REGISTRY.map((s) => ({ ...s }));
  const allowedTarget = new Set(['scheduler', 'worker', 'both']);
  const allowedChannel = new Set(['system', 'tool-schema', 'turn-prefix', 'tool-result', 'event-wake', 'host-md', 'compact']);
  const allowedMode = new Set(['always', 'conditional']);
  for (const s of viewShaped) {
    assert.ok(allowedTarget.has(s.target) && allowedChannel.has(s.channel) && allowedMode.has(s.mode));
    assert.deepEqual(Object.keys(s).sort(), ['channel', 'id', 'mode', 'note', 'survivesCompact', 'target']);
  }
  // capabilitiesView 主进程侧真的把注册表挂上了（防「登记了没暴露」）
  const capsSrc = fs.readFileSync(path.join(root, 'src/main/agent/capabilitiesView.ts'), 'utf8');
  assert.ok(capsSrc.includes('listInjections()'), 'capabilitiesView 必须挂 listInjections()');
  console.log('ok   CapabilitiesView.injections 结构兼容 + capabilitiesView 挂载');
}

// ── 3) C1 date-change 判定 ──
{
  // 日期键（本地时区）
  assert.equal(localDateKey(new Date(2026, 8, 23, 9, 30).getTime()), '2026-09-23');
  assert.equal(localDateKey(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05');

  // 首次锚定（无记录）→ 注入一行（调度 system prompt 无日期，先给「今天」）
  const first = decideDateChangeReminder({ nowMs: new Date(2026, 8, 23, 9, 0).getTime() });
  assert.equal(first.changed, true);
  assert.equal(first.dateKey, '2026-09-23');
  assert.match(first.line, /Today is 2026-09-23/);
  assert.ok(!first.line.includes('last interaction'), '无记录不带「上次交互」');
  assert.ok(first.line.startsWith(DATE_CHANGE_REMINDER_TAG) && first.line.endsWith(DATE_CHANGE_REMINDER_TAG));

  // 同日 → 不注入
  const same = decideDateChangeReminder({
    nowMs: new Date(2026, 8, 23, 18, 0).getTime(),
    lastInjectedDate: '2026-09-23'
  });
  assert.equal(same.changed, false);
  assert.equal(same.line, undefined);
  assert.equal(same.dateKey, '2026-09-23');

  // 跨日 → 注入并带上次交互
  const cross = decideDateChangeReminder({
    nowMs: new Date(2026, 8, 24, 8, 0).getTime(),
    lastInjectedDate: '2026-09-23'
  });
  assert.equal(cross.changed, true);
  assert.match(cross.line, /Today is 2026-09-24 \(last interaction Sep 23\)/);

  // 年末跨界 12-31 → 01-01
  const newYear = decideDateChangeReminder({
    nowMs: new Date(2027, 0, 1, 0, 5).getTime(),
    lastInjectedDate: '2026-12-31'
  });
  assert.equal(newYear.changed, true);
  assert.match(newYear.line, /Today is 2027-01-01 \(last interaction Dec 31\)/);

  // 闰年边界 2024-02-29 → 2024-03-01
  const leap = decideDateChangeReminder({
    nowMs: new Date(2024, 2, 1, 0, 5).getTime(),
    lastInjectedDate: '2024-02-29'
  });
  assert.equal(leap.changed, true);
  assert.match(leap.line, /Today is 2024-03-01 \(last interaction Feb 29\)/);
  // 闰日当天同日不注入
  const leapSame = decideDateChangeReminder({
    nowMs: new Date(2024, 1, 29, 15, 0).getTime(),
    lastInjectedDate: '2024-02-29'
  });
  assert.equal(leapSame.changed, false);

  // 上次记录损坏（不可解析）→ 退化为纯锚定行，不抛错
  const corrupt = decideDateChangeReminder({
    nowMs: new Date(2026, 8, 24, 8, 0).getTime(),
    lastInjectedDate: 'not-a-date'
  });
  assert.equal(corrupt.changed, true);
  assert.match(corrupt.line, /Today is 2026-09-24/);
  assert.ok(!corrupt.line.includes('last interaction'));

  // 空串/undefined 同无记录口径
  for (const bad of [undefined, null, '   ']) {
    const r = decideDateChangeReminder({ nowMs: new Date(2026, 8, 24, 8, 0).getTime(), lastInjectedDate: bad });
    assert.equal(r.changed, true);
    assert.ok(!r.line.includes('last interaction'));
  }
  console.log('ok   C1 date-change（锚定/同日/跨日/年末/闰年/损坏降级）');
}

console.log('injection-registry: ok');
