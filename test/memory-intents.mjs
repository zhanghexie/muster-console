/**
 * B7（memory-refactor P6）：standing intents（全词预筛矩阵/事件谓词矩阵/状态机与防骚扰
 * 默认/单事务复查/intent 工具守卫）、origin 注解（roundtrip/伪造剥离·还原即红/晋升带
 * 真实来源/索引读注解/面板真值）、USER.md 画像层（注入预算与面限定/巩固治理路由/
 * supersede-in-place/面板直改免审/上限守卫）。
 * Run: node test/memory-intents.mjs
 * 全部落系统临时目录（mkdtemp）；db 走真 node:sqlite；LLM 全 mock。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';

// 本机 Node 构建缺 fts5（如 22.x 官方 win-x64）时 db 层建库即报 no such module: fts5，
// 属环境能力缺失而非回归——按仓库惯例打印原因后退出 0 跳过（详见 helpers/sqlite-fts5.mjs）。
if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-intents-'));
const compile = createSharedCompiler(root, tmp);

const intentsMod = await import(pathToFileURL(compile('main/memory/intents.ts')).href);
const intentToolMod = await import(pathToFileURL(compile('main/memory/intentTool.ts')).href);
const dbMod = await import(pathToFileURL(compile('main/memory/db.ts')).href);
const entryFormatMod = await import(pathToFileURL(compile('main/memory/entryFormat.ts')).href);
const applyMod = await import(pathToFileURL(compile('main/memory/consolidation/apply.ts')).href);
const profileMod = await import(pathToFileURL(compile('main/memory/consolidation/profile.ts')).href);
const gatesMod = await import(pathToFileURL(compile('main/memory/consolidation/gates.ts')).href);
const indexerMod = await import(pathToFileURL(compile('main/memory/indexer.ts')).href);
const centerMod = await import(pathToFileURL(compile('main/memory/center.ts')).href);
const userProfileMod = await import(pathToFileURL(compile('main/memory/userProfile.ts')).href);
const turnScopeMod = await import(pathToFileURL(compile('main/agent/turnScope.ts')).href);
const svcMod = await import(pathToFileURL(compile('main/memory/service.ts')).href);
const svcRefMod = await import(pathToFileURL(compile('main/memory/serviceRef.ts')).href);

const {
  INTENT_CONSTANTS,
  insertIntent,
  listIntents,
  cancelIntent,
  rearmIntent,
  sweepIntentExpiry,
  matchIntentKeywords,
  matchIntentPredicate,
  tryFireIntent,
  runIntentMessageScan,
  runIntentEventScan
} = intentsMod;
const { runIntentTool, looksTimeOnlyIntent } = intentToolMod;
const { openMemoryDb } = dbMod;
const {
  parseMemoryEntriesV2,
  serializeMemoryEntryV2,
  splitEntryAnnotations,
  formatEntryAnnotations,
  stripOriginAnnotationTail,
  serializeNewEntryWithAnnotations,
  USER_PROFILE_MAX_CHARS
} = entryFormatMod;
const { applyConsolidationOperations } = applyMod;
const {
  parseProfileOperations,
  planProfileWrite,
  executeProfileWrite,
  enqueueUserProfileApproval,
  decideUserProfileApproval,
  runUserProfileSweep
} = profileMod;
const { namespaceOfOrigin } = gatesMod;
const { chunkMemorySource, syncMemoryIndex } = indexerMod;
const {
  memoryCenterEntries,
  memoryCenterIntents,
  memoryCenterCancelIntent,
  memoryCenterRearmIntent,
  memoryCenterProfile,
  memoryCenterUpdateProfile,
  setMemoryService,
  MemoryService
} = { ...centerMod, ...svcRefMod, MemoryService: svcMod.MemoryService };
const {
  setUserProfileFilePath,
  getUserProfileFilePath,
  userProfileFilePathFor,
  readUserProfile,
  writeUserProfile
} = userProfileMod;
const { runWithTurnUserText, runAsNonUserTurn, runAsHeadlessTurn } = turnScopeMod;

const NOW = new Date('2026-09-21T12:00:00').getTime();
const DAY = 86_400_000;

// center.ts 的 db 访问走服务单例（memoryCenterIntents/profile 等）
setMemoryService(new MemoryService());

function freshWs(name) {
  const ws = path.join(tmp, name);
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

/* ---------------- 1. 消息面：确定性全词预筛矩阵 ---------------- */
{
  // 全词现才命中：多关键词全在 → true；缺一 → false
  assert.equal(matchIntentKeywords(['冒烟', 'auth'], 'auth 任务的 PR 合并了，记得跑冒烟'), true, '全词命中');
  assert.equal(matchIntentKeywords(['冒烟', 'auth'], 'auth 任务合并了'), false, '缺一不命中');
  assert.equal(matchIntentKeywords(['Auth'], '请检查 AUTH 服务'), true, 'ASCII 大小写不敏感');
  assert.equal(matchIntentKeywords(['数据库'], '数据库迁移方案定了'), true, 'CJK 子串命中');
  assert.equal(matchIntentKeywords([], '任意消息'), false, '空关键词表永不命中（消息面）');
  assert.equal(matchIntentKeywords(['x'], '   '), false, '空消息不命中');
  // 关键词跨词序不要求（包含语义，与 trigger 词法同口径）
  assert.equal(matchIntentKeywords(['发布', '回滚'], '回滚方案要先在发布前演练'), true);

  // 扫描入口：命中 → 单事务发射 → 有界隐藏块
  const ws1 = freshWs('ws-msg');
  const db1 = openMemoryDb(ws1);
  const i1 = insertIntent(db1, {
    description: '用户提到 auth 冒烟时提醒回归范围',
    triggerKeywords: ['auth', '冒烟'],
    now: NOW
  });
  assert.equal(i1.state, 'armed', '创建即 armed');
  const scan1 = runIntentMessageScan(db1, 'auth 任务的 PR 好了，跑冒烟了吗', NOW);
  assert.equal(scan1.hits.length, 1, '全词命中发一次');
  assert.ok(scan1.block.includes('前瞻意图提醒'), '注入块节标题');
  assert.ok(scan1.block.includes('auth 冒烟'), '注入块带描述');
  assert.ok(scan1.block.includes('1/3'), '注入块带发射计数');
  assert.equal(scan1.hits[0].fired.state, 'fired', '发射后状态 fired');

  // 冷却内重复消息不再发射（防骚扰默认 24h）
  const scan2 = runIntentMessageScan(db1, '再聊一下 auth 冒烟', NOW + 3_600_000);
  assert.equal(scan2.hits.length, 0, '冷却内不发射');
  assert.equal(scan2.block, '', '无命中无块');

  // 越过冷却再发；预算耗尽 → done；再扫不发射
  const r3 = tryFireIntent(db1, i1.id, NOW + DAY);
  assert.equal(r3.fired, true);
  const r4 = tryFireIntent(db1, i1.id, NOW + 2 * DAY);
  assert.equal(r4.fired, true);
  assert.equal(r4.record.state, 'done', '第 3 次发射后预算耗尽 → done');
  const scan3 = runIntentMessageScan(db1, 'auth 冒烟再来一次', NOW + 3 * DAY);
  assert.equal(scan3.hits.length, 0, 'done 终态不发射');

  // ≤3 条注入上限
  const db1b = openMemoryDb(freshWs('ws-msg-cap'));
  for (let n = 0; n < 5; n++) {
    // 前三位预算 1（一发即 done），后两位缺省 3——用于验证预算只对实际注入者推进
    insertIntent(db1b, { description: `意图 ${n}`, triggerKeywords: ['共同词'], fireBudget: n < 3 ? 1 : 3, now: NOW });
  }
  const scanCap = runIntentMessageScan(db1b, '共同词出现就全命中', NOW);
  assert.equal(scanCap.hits.length, INTENT_CONSTANTS.MAX_INJECT_PER_TURN, '每回合注入 ≤3 条');
  assert.ok(scanCap.block.split('\n').length <= 1 + INTENT_CONSTANTS.MAX_INJECT_PER_TURN);
  // m3（B8 评审收口）：预算只对实际注入者推进——同回合第 4/5 位命中但未注入：
  // 不发射、不耗预算、不推冷却（先发射后截断会让防骚扰预算被命中数白耗）
  const notInjected = listIntents(db1b).filter((x) => x.fireCount === 0);
  assert.equal(notInjected.length, 2, '未注入者 fire_count 不推进');
  assert.ok(notInjected.every((x) => x.state === 'armed' && x.lastFiredAt == null), '未注入者保持 armed 且无发射时刻');
  // 前三位预算（=1）耗尽后，下回合轮到此前未注入的两条（预算保留的直接证据）
  const scanCap2 = runIntentMessageScan(db1b, '共同词出现就全命中', NOW + DAY);
  assert.deepEqual(
    scanCap2.hits.map((h) => h.intent.description).sort(),
    ['意图 3', '意图 4'],
    '预算保留者后续回合可发射'
  );

  // 过期清扫搭车（piggyback）：过期候选不再扫到且被标 expired
  const db1c = openMemoryDb(freshWs('ws-msg-exp'));
  insertIntent(db1c, {
    description: '已过期意图',
    triggerKeywords: ['触发词'],
    expiry: NOW - 1,
    now: NOW - 2 * DAY
  });
  const scan4 = runIntentMessageScan(db1c, '触发词', NOW);
  assert.equal(scan4.hits.length, 0, '过期不发射');
  assert.ok(scan4.expiredSwept >= 1, '扫描搭车清扫');
  assert.equal(listIntents(db1c)[0].state, 'expired');
}

/* ---------------- 2. 事件面：结构化谓词矩阵（确定性，零模型调用） ---------------- */
{
  // notify_flip
  assert.equal(matchIntentPredicate({ kind: 'notify_flip', trigger: 'needs_you' }, { kind: 'notify_flip', trigger: 'needs_you' }), true);
  assert.equal(matchIntentPredicate({ kind: 'notify_flip', trigger: 'error' }, { kind: 'notify_flip', trigger: 'needs_you' }), false);

  // merge_blocked / pr_merged：至少一匹配面；已设面全须命中
  assert.equal(matchIntentPredicate({ kind: 'merge_blocked', branchIncludes: 'feat/' }, { kind: 'merge_blocked', branch: 'feat/x' }), true);
  assert.equal(matchIntentPredicate({ kind: 'merge_blocked', branchIncludes: 'feat/' }, { kind: 'merge_blocked', branch: 'fix/y' }), false);
  assert.equal(matchIntentPredicate({ kind: 'merge_blocked', repoIncludes: '/main' }, { kind: 'merge_blocked', branch: 'x' }), false, '已设 repo 面但事件无 repo → 不命中（确定性）');
  assert.equal(matchIntentPredicate({ kind: 'merge_blocked', repoIncludes: '/main' }, { kind: 'merge_blocked', repo: 'E:/Projects/main' }), true, '仅 repo 面');
  assert.equal(matchIntentPredicate({ kind: 'pr_merged', branchIncludes: 'release' }, { kind: 'pr_merged', branch: 'release-1.2' }), true);

  // 谓词间 OR；扫描入口全链
  const ws2 = freshWs('ws-evt');
  const db2 = openMemoryDb(ws2);
  insertIntent(db2, {
    description: 'PR 合并提醒跑冒烟',
    eventPredicates: [
      {kind:'notify_flip',trigger:'needs_you'},
      { kind: 'pr_merged', branchIncludes: 'auth' }
    ],
    cooldownMs: 0,
    now: NOW
  });
  const scan1 = runIntentEventScan(db2, { kind: 'pr_merged', branch: 'auth/rewrite' }, NOW);
  assert.equal(scan1.hits.length, 1, 'pr_merged 命中');
  assert.equal(scan1.hits[0].predicate.kind, 'pr_merged');
  const scan2 = runIntentEventScan(db2, { kind: 'pr_merged', branch: 'other' }, NOW + 1);
  assert.equal(scan2.hits.length, 0, '分支不符不命中');
  // 冷却 0：每次命中即发
  const scan3 = runIntentEventScan(db2, {kind:'notify_flip',trigger:'needs_you'}, NOW + 2);
  assert.equal(scan3.hits.length, 1, '第二谓词（会话等人）命中');
}

/* ---------------- 3. 状态机与防骚扰默认 ---------------- */
{
  const ws3 = freshWs('ws-sm');
  const db3 = openMemoryDb(ws3);
  const it = insertIntent(db3, { description: '默认防骚扰', triggerKeywords: ['k'], now: NOW });
  assert.equal(it.fireBudget, 3, '缺省预算 3');
  assert.equal(it.cooldownMs, INTENT_CONSTANTS.DEFAULT_COOLDOWN_MS, '缺省冷却 24h');
  assert.equal(it.expiry, NOW + INTENT_CONSTANTS.DEFAULT_EXPIRY_MS, '缺省 90 天过期');

  // 取消是持久状态，扫描面永不恢复
  assert.equal(cancelIntent(db3, it.id, NOW), true);
  assert.equal(listIntents(db3)[0].state, 'cancelled');
  const fr = tryFireIntent(db3, it.id, NOW + DAY);
  assert.equal(fr.fired, false, 'cancelled 不发射');
  const msgScan = runIntentMessageScan(db3, 'k 出现', NOW + DAY);
  assert.equal(msgScan.hits.length, 0, 'cancelled 不进消息面');
  // 幂等取消
  assert.equal(cancelIntent(db3, it.id, NOW), false);
  // 面板重新武装（人显式操作）→ armed，计数清零
  const re = rearmIntent(db3, it.id, NOW);
  assert.equal(re.ok, true);
  assert.equal(re.record.state, 'armed');
  assert.equal(re.record.fireCount, 0);
  assert.equal(re.record.lastFiredAt, null);

  // 过期后 rearm 续期 90 天
  insertIntent(db3, { description: '过期后续期', triggerKeywords: ['k2'], expiry: NOW - DAY, now: NOW - 2 * DAY });
  sweepIntentExpiry(db3, NOW);
  const expired = listIntents(db3).find((i) => i.description === '过期后续期');
  assert.equal(expired.state, 'expired');
  const re2 = rearmIntent(db3, expired.id, NOW);
  assert.equal(re2.record.state, 'armed');
  assert.equal(re2.record.expiry, NOW + INTENT_CONSTANTS.DEFAULT_EXPIRY_MS, '过期 rearm 续 90d');

  // rearm 不存在的 id
  assert.equal(rearmIntent(db3, 9999, NOW).ok, false);
}

/* ---------------- 4. 单事务复查（状态→过期→冷却→预算） ---------------- */
{
  const ws4 = freshWs('ws-fire');
  const db4 = openMemoryDb(ws4);
  const it = insertIntent(db4, { description: '复查', triggerKeywords: ['k'], cooldownMs: 0, fireBudget: 1, now: NOW });
  const a = tryFireIntent(db4, it.id, NOW + 1);
  assert.equal(a.fired, true);
  assert.equal(a.record.state, 'done', '预算 1 耗尽即 done');
  const b = tryFireIntent(db4, it.id, NOW + 2);
  assert.equal(b.fired, false, '终态复查拒发');
  assert.equal(b.reason, 'state');
  assert.equal(b.record.state, 'done');

  // expired 复查：过期的 armed 在 fire 时被就地置 expired
  const it2 = insertIntent(db4, { description: '将过期', triggerKeywords: ['k'], expiry: NOW + 10, now: NOW });
  const c = tryFireIntent(db4, it2.id, NOW + 20);
  assert.equal(c.fired, false);
  assert.equal(c.reason, 'expired');
  assert.equal(c.record.state, 'expired');

  // 不存在的 id → null
  assert.equal(tryFireIntent(db4, 424242, NOW), null);
}

/* ---------------- 5. intent 工具：回合证据 / 纯时间型拒绝 / list / cancel ---------------- */
{
  const ws5 = freshWs('ws-tool');
  const db5 = openMemoryDb(ws5);

  // host 自治 / 后台子代理回合（runAsNonUserTurn）拒建——还原即红参照（B3 MAJOR-1 同款守卫）
  assert.throws(
    () => runAsNonUserTurn(() => runIntentTool(db5, { action: 'create', description: '自治回合造的', triggerKeywords: ['x'] })),
    /用户在本回合/,
    'host/bg 回合拒建'
  );
  // 无头回合拒建
  assert.throws(
    () => runAsHeadlessTurn(() => runWithTurnUserText('周五提醒我', () => runIntentTool(db5, { action: 'create', description: 'x', triggerKeywords: ['x'] }))),
    /无头/
  );
  // 纯时间型拒绝（提醒动词 + 时间锚点），并指路定时任务
  assert.equal(looksTimeOnlyIntent('周五提醒我提交周报'), true);
  assert.equal(looksTimeOnlyIntent('remind me tomorrow to check CI'), true);
  assert.equal(looksTimeOnlyIntent('每当 auth 的 PR 合并就提醒跑冒烟'), false, '事件型不算纯时间');
  assert.throws(
    () =>
      runWithTurnUserText('周五提醒我提交周报', () =>
        runIntentTool(db5, { action: 'create', description: '周五提醒我提交周报', triggerKeywords: ['周报'] })
      ),
    /定时任务/,
    '纯时间型拒绝并指路定时任务'
  );
  // 缺触发面拒绝
  assert.throws(
    () => runWithTurnUserText('以后提醒我', () => runIntentTool(db5, { action: 'create', description: '提醒我' })),
    /触发面/
  );
  // 用户回合正常创建 + list + cancel
  const created = runWithTurnUserText('以后每当 auth 的 PR 合并就提醒我跑冒烟', () =>
    runIntentTool(db5, {
      action: 'create',
      description: '每当 auth 的 PR 合并就提醒跑冒烟',
      triggerKeywords: ['auth', '冒烟'],
      eventPredicates: [{ kind: 'pr_merged', branchIncludes: 'auth' }]
    })
  );
  assert.equal(created.created, true);
  assert.equal(created.intent.state, 'armed');
  const listed = runIntentTool(db5, { action: 'list' });
  assert.equal(listed.items.length, 1);
  // cancel 须本回合用户证据（与 create 对称；还原即红：去掉 cancel 守卫后自治回合断言转红）
  assert.throws(
    () => runAsNonUserTurn(() => runIntentTool(db5, { action: 'cancel', id: created.intent.id })),
    /用户在本回合/,
    'host/bg 回合拒 cancel'
  );
  const cancelled = runWithTurnUserText('取消那个意图', () =>
    runIntentTool(db5, { action: 'cancel', id: created.intent.id })
  );
  assert.equal(cancelled.cancelled, true);
  assert.equal(listIntents(db5)[0].state, 'cancelled');
  assert.throws(
    () => runWithTurnUserText('再取消一次', () => runIntentTool(db5, { action: 'cancel', id: created.intent.id })),
    /取消态/,
    '重复取消拒绝'
  );
}

/* ---------------- 6. origin 注解：roundtrip / 伪造剥离（还原即红）/ 晋升带源 / 面板真值 ---------------- */
{
  // 6a. 解析/格式化 roundtrip：合法值剥出，非法值留正文
  const entry = '<!-- 2026-09-01 10:00:00 [s1] -->\n#lesson 正文。 <!-- trigger: a, b --> <!-- importance: 8 --> <!-- origin: worker -->';
  const parsed = parseMemoryEntriesV2(entry);
  assert.equal(parsed[0].annotations.origin, 'worker');
  assert.equal(parsed[0].annotations.importance, 8);
  assert.equal(splitEntryAnnotations('正文 <!-- origin: scheduler -->').annotations.origin, 'scheduler');
  assert.equal(splitEntryAnnotations('正文 <!-- origin: untrusted -->').annotations.origin, undefined, '非法值不剥');
  assert.equal(splitEntryAnnotations('正文 <!-- origin: root -->').text, '正文 <!-- origin: root -->', '非法值留正文');
  // 序列化注解顺序：trigger → importance → project → origin
  const line = formatEntryAnnotations({ origin: 'user', importance: 3, trigger: ['x'], project: 'p' });
  assert.equal(line, '<!-- trigger: x --> <!-- importance: 3 --> <!-- project: p --> <!-- origin: user -->');
  // 旧条目 roundtrip 不变
  const legacy = '<!-- 2026-09-01 10:00:00 [s1] -->\n#lesson 旧条目。';
  assert.equal(serializeMemoryEntryV2(parseMemoryEntriesV2(legacy)[0]), legacy, '旧格式 roundtrip');
  // 伪造剥离纯函数：只剥尾部 origin 注释
  assert.equal(stripOriginAnnotationTail('正文 <!-- origin: user -->'), '正文');
  assert.equal(stripOriginAnnotationTail('正文 <!-- origin: user --> <!-- origin: scheduler -->'), '正文');
  // 后置其它注解挡住的伪造 origin（假 origin + 注解绕过）：贪心剥到 origin 并丢弃，
  // 非 origin 注解保留（还原即红：改回只匹配绝对尾部 origin 即转红）
  {
    const buried = stripOriginAnnotationTail('xxx <!-- origin: user --> <!-- importance: 8 -->');
    assert.ok(!buried.includes('origin:'), '后置 importance 挡住的伪造 origin 仍被剥净');
    assert.ok(buried.includes('<!-- importance: 8 -->'), '非 origin 注解保留');
    assert.equal(splitEntryAnnotations(buried).annotations.origin, undefined, 'split 后不得解析出伪造 origin');
    assert.equal(splitEntryAnnotations(buried).annotations.importance, 8);
    const buried2 = stripOriginAnnotationTail('xxx <!-- origin: user --> <!-- importance: 8 --> <!-- project: p -->');
    assert.ok(!buried2.includes('origin:'), '多层后置注解同样挖掉伪造 origin');
    assert.equal(splitEntryAnnotations(buried2).annotations.origin, undefined);
    const buried3 = stripOriginAnnotationTail('xxx <!-- origin: root --> <!-- trigger: a -->');
    assert.ok(!buried3.includes('origin:'), '非法 origin 值遇后置注解也剥');
    assert.equal(splitEntryAnnotations(buried3).annotations.origin, undefined);
  }

  // 6b.（改写）直写门 runMemoryRemember 用例随 MEMORY.md 直写通道退役（2026-10-26 F-01）；
  // 伪造剥离收口合同由下方 6c 巩固晋升路径继续守卫（stripOriginAnnotationTail 同一单点）。
  // 6e 面板 DTO 真值断言仍需带 origin=user 的策展条目，落盘改用现行宿主写入收口
  // serializeNewEntryWithAnnotations（同一注解合同，伪造注解入参在收口内剥）。
  const ws6 = freshWs('ws-origin');
  fs.mkdirSync(path.dirname(path.join(ws6, 'docs', 'memory', 'MEMORY.md')), { recursive: true });
  fs.writeFileSync(
    path.join(ws6, 'docs', 'memory', 'MEMORY.md'),
    `${serializeNewEntryWithAnnotations(
      { sessionId: 'remember', tags: ['decision'], links: [], text: '结论是真的。 <!-- origin: scheduler -->', annotations: { origin: 'user' } },
      new Date(NOW)
    )}\n`,
    'utf8'
  );
  const disk6 = fs.readFileSync(path.join(ws6, 'docs', 'memory', 'MEMORY.md'), 'utf8');
  assert.ok(!disk6.includes('origin: scheduler'), '伪造注解已剥离（收口单点，还原即红断言）');
  const back6 = parseMemoryEntriesV2(disk6);
  assert.equal(back6[0].annotations.origin, 'user', '宿主写入条目带分类 origin=user');

  // 6c. 巩固晋升带 staging 真实来源；模型正文伪造被剥
  const ws6c = freshWs('ws-origin-promote');
  const db6c = openMemoryDb(ws6c);
  const plan6 = applyConsolidationOperations(db6c, {
    ops: [{ op: 'add', stagingId: 7, text: '晋升的结论。 <!-- origin: user -->', confidence: 0.9 }],
    evidence: [{ stagingId: 7, evidencePath: 'journal/2026-09-20.md', lineStart: 3, lineEnd: 4, origin: 'scheduler' }],
    targetFile: path.join(ws6c, '.muster', 'scheduler', 'MEMORY.md'),
    budgetChars: 6000,
    surface: 'scheduler',
    now: NOW,
    cause: 'test'
  });
  assert.equal(plan6.applied.length, 1);
  const disk6c = fs.readFileSync(path.join(ws6c, '.muster', 'scheduler', 'MEMORY.md'), 'utf8');
  assert.ok(disk6c.includes('<!-- origin: scheduler -->'), '晋升条目带真实来源注解');
  assert.ok(!disk6c.includes('origin: user'), '模型伪造 origin:user 已剥离');
  const back6c = parseMemoryEntriesV2(disk6c);
  assert.equal(back6c[0].annotations.origin, 'scheduler');
  assert.ok(back6c[0].text.includes('Source: '), 'Source 引用行保留');

  // 无 origin 证据（旧候选）不落注解
  const plan6b = applyConsolidationOperations(db6c, {
    ops: [{ op: 'add', stagingId: 8, text: '无来源候选。', confidence: 0.9 }],
    evidence: [{ stagingId: 8, evidencePath: 'x.md' }],
    targetFile: path.join(ws6c, '.muster', 'scheduler', 'MEMORY.md'),
    budgetChars: 6000,
    surface: 'scheduler',
    now: NOW,
    cause: 'test'
  });
  const disk6b = fs.readFileSync(path.join(ws6c, '.muster', 'scheduler', 'MEMORY.md'), 'utf8');
  assert.equal(plan6b.applied.length, 1);
  assert.equal((disk6b.match(/<!-- origin:/g) || []).length, 1, '无来源不新增注解');

  // 6d. 索引把注解读进 chunks.origin（无注解维持 system）
  const drafts6 = chunkMemorySource(
    '<!-- 2026-09-01 10:00:00 [s1] -->\n#lesson 带源条目。 <!-- origin: user -->\n\n<!-- 2026-09-02 10:00:00 [s1] -->\n#lesson 无源条目。',
    'memory'
  );
  assert.equal(drafts6[0].origin, 'user');
  assert.equal(drafts6[1].origin, null);
  const ws6d = freshWs('ws-origin-idx');
  const db6d = openMemoryDb(ws6d);
  fs.mkdirSync(path.join(ws6d, 'docs', 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(ws6d, 'docs', 'memory', 'MEMORY.md'),
    '<!-- 2026-09-01 10:00:00 [s1] -->\n#lesson 带源条目。 <!-- origin: user -->\n',
    'utf8'
  );
  syncMemoryIndex(db6d, ws6d);
  const originRows = db6d.handle.prepare("SELECT origin FROM chunks WHERE source_type='memory'").all();
  assert.equal(originRows[0].origin, 'user', 'chunks.origin 读注解');
  // user_md 面 origin 恒 user
  const profDrafts = chunkMemorySource('<!-- observed: 2026-09-20 | status: active -->\nAlways 简体中文。', 'user_md');
  assert.equal(profDrafts[0].origin, 'user');

  // 6e. 面板 DTO 拿到真值
  const center6 = memoryCenterEntries(ws6);
  const withOrigin = center6.entries.find((e) => e.text.includes('结论是真的'));
  assert.equal(withOrigin.origin, 'user', '面板 OriginDot 数据源为真值');
}

/* ---------------- 7. USER.md 注入：槽位兑现 / 面限定 / versionToken ---------------- */
{
  const ws7 = freshWs('ws-inject');
  const userData7 = path.join(tmp, 'userdata-7');
  setUserProfileFilePath(userData7);
  assert.equal(getUserProfileFilePath(), userProfileFilePathFor(userData7));
  fs.mkdirSync(path.dirname(getUserProfileFilePath()), { recursive: true });
  fs.writeFileSync(getUserProfileFilePath(), '<!-- observed: 2026-09-20 | status: active -->\nAlways 用简体中文回复。\n', 'utf8');

  const svc7 = new MemoryService();
  const w1 = svc7.inject(ws7, 'worker', undefined, { sessionId: 's7' });
  assert.ok(w1.text.includes('User profile (USER.md)'), 'worker 面带画像节');
  assert.ok(w1.text.includes('Always 用简体中文回复。'));
  assert.ok(w1.sections.some((s) => s.kind === 'profile'), '分节明细含 profile');
  const s1 = svc7.inject(ws7, 'scheduler', undefined, { sessionId: 'orch7' });
  assert.ok(s1.text.includes('User profile (USER.md)'), '调度面也注入画像（独立小预算）');
  const h1 = svc7.inject(ws7, 'headless', undefined, { sessionId: 'h7' });
  assert.equal(h1.text, '', 'headless 零注入原则不破坏');
  const h2 = svc7.inject(ws7, 'heartbeat', undefined, { sessionId: 'hb7' });
  assert.equal(h2.text, '', 'heartbeat 零注入');
  assert.equal(h2.sections.length, 0);

  // 画像文件变化 → versionToken 变化（token 覆盖真注入源，B5 MAJOR-1 同口径）
  const tokenBefore = w1.versionToken;
  fs.writeFileSync(getUserProfileFilePath(), '<!-- observed: 2026-09-21 | status: active -->\nNever 略过回归。\n', 'utf8');
  const w2 = svc7.inject(ws7, 'worker', undefined, { sessionId: 's7' });
  assert.notEqual(w2.versionToken, tokenBefore, '画像写入拖动 token → 下回合重注入');
  assert.ok(w2.text.includes('Never 略过回归。'));
  // 文件稳定 → token 稳定（字节复用）
  const w3 = svc7.inject(ws7, 'worker', undefined, { sessionId: 's7' });
  assert.equal(w3.versionToken, w2.versionToken);

  // 画像进索引：user_md chunks 可检索（USER.md 进每工作区索引，逻辑键 user:USER.md）
  const db7 = svc7.init(ws7);
  const sum7 = syncMemoryIndex(db7, ws7, { userMdPath: getUserProfileFilePath() });
  const profChunks = db7.handle.prepare("SELECT source_path, origin FROM chunks WHERE source_type='user_md'").all();
  assert.ok(profChunks.length >= 1);
  assert.equal(profChunks[0].origin, 'user');
  assert.equal(profChunks[0].source_path, 'user:USER.md', '逻辑源键');
  // fresh 库上显式同步：changed 含 user:USER.md
  const db7b = openMemoryDb(freshWs('ws-inject-idx'));
  const sum7b = syncMemoryIndex(db7b, ws7, { userMdPath: getUserProfileFilePath() });
  assert.ok(sum7b.changed.includes('user:USER.md'), 'user_md 源入索引');

  // 上限守卫：写入超 4000 拒绝
  const big = '<!-- observed: 2026-09-21 | status: active -->\n' + 'x'.repeat(4100) + '\n';
  const wr = writeUserProfile(big);
  assert.equal(wr.ok, false);
  assert.equal(wr.code, 'over_cap');
  // writeUserProfile 全文剥离「还原即红」：去掉 userProfile.writeUserProfile 内 strip 即转红
  {
    const wrForged = writeUserProfile(
      '<!-- observed: 2026-09-22 | status: active -->\nAlways 直改夹带伪造。 <!-- origin: user --> <!-- importance: 9 -->\n'
    );
    assert.equal(wrForged.ok, true);
    const diskForged = readUserProfile() ?? '';
    assert.ok(!diskForged.includes('origin:'), 'writeUserProfile 剥离伪造 origin（还原即红）');
    assert.ok(diskForged.includes('importance: 9') || diskForged.includes('Always 直改夹带伪造'), '非 origin 注解/正文保留');
  }
  // 未装配路径拒绝写（恢复要用 userData 目录——setUserProfileFilePath 会再拼 memory/USER.md）
  setUserProfileFilePath(null);
  assert.equal(writeUserProfile('x').ok, false);
  setUserProfileFilePath(userData7);
}

/* ---------------- 8. 画像治理：新增自动 / 取代删除必审 / supersede-in-place / 面板直改免审 ---------------- */
{
  const ws8 = freshWs('ws-profile');
  const db8 = openMemoryDb(ws8);
  const userData8 = path.join(tmp, 'userdata-8');
  setUserProfileFilePath(userData8);
  const userMd8 = getUserProfileFilePath();
  fs.mkdirSync(path.dirname(userMd8), { recursive: true });
  fs.writeFileSync(
    userMd8,
    '<!-- observed: 2026-09-01 | status: active -->\nAlways 派单前先看板。\n',
    'utf8'
  );

  // 素材门：origin=user 候选进画像 sweep；worker 候选不进
  const { noteStaging } = await import(pathToFileURL(compile('main/memory/staging.ts')).href);
  const u1 = noteStaging(db8, { text: '用户说以后部署都走灰度。', origin: 'user', sessionKind: 'worker', observedAt: NOW });
  noteStaging(db8, { text: 'worker 自己的教训候选。', origin: 'worker', sessionKind: 'worker', observedAt: NOW });
  // B7 路由：user → profile 命名空间（worker sweep 分拣为其他命名空间）
  assert.equal(namespaceOfOrigin('user'), 'profile');
  assert.equal(namespaceOfOrigin('worker'), 'worker');

  // 无候选跳过：不留 log 不调模型
  let calls = 0;
  const callModel = async () => {
    calls += 1;
    return '{"operations":[]}';
  };
  const skip = await runUserProfileSweep({ db: openMemoryDb(freshWs('ws-empty')), callModel, now: NOW, reason: 'task_close', targetFileAbs: userMd8, baseHashFn: (t) => String(t.length) });
  assert.equal(skip.ran, false);
  assert.equal(skip.skipped, 'no_candidates');
  assert.equal(calls, 0);

  // 高置信 add 自动；低置信 supersede 必审（决策 #7）
  // add directive 夹带伪造 origin 注解（B8 评审：画像治理路径剥离对称性回归——
  // 还原 planProfileWrite 的剥离即本节转红）
  let modelOut = JSON.stringify({
    operations: [
      { op: 'add', candidateId: u1.stagingId, directive: 'Always 部署走灰度。 <!-- origin: scheduler -->', confidence: 0.9 },
      { op: 'supersede', candidateId: -1, oldDirective: '占位', directive: 'x', confidence: 0.5 }
    ]
  });
  // 清掉上面注入的 worker 候选对画像门无影响（素材门只认 origin=user），只重放 user 候选：
  // u1 已被上一条 staging 占用 stagingId——重新取 pending 候选验证
  const sum8 = await runUserProfileSweep({
    db: db8,
    callModel: async () => modelOut,
    now: NOW,
    reason: 'task_close',
    highConfidenceAdd: 0.75,
    targetFileAbs: userMd8,
    baseHashFn: (t) => t
  });
  assert.equal(sum8.ran, true);
  assert.equal(sum8.modelOk, true);
  // 高置信 add 自动落盘
  assert.equal(sum8.autoApplied, 1, '高置信 add 自动应用');
  const disk8 = fs.readFileSync(userMd8, 'utf8');
  assert.ok(disk8.includes('Always 部署走灰度。'));
  assert.ok(disk8.includes('Always 派单前先看板。'), '旧指令保留（不盲目追加矛盾条目）');
  assert.ok(!disk8.includes('origin:'), '画像写入后伪造 origin 注解不在盘上（治理路径剥离对称，还原即红）');
  // 低置信/必审操作进审批队列（candidateId=-1 被按 model_failed 丢弃 → deferred 仅含真实候选的 supersede）
  assert.equal(sum8.deferredCount, 0, '未知候选不进审批');
  assert.equal(sum8.deferredApprovalId, undefined);
  assert.ok(sum8.logId > 0, '画像 sweep 留时间线');

  // supersede 必审 → approve 原位替换（supersede-in-place，永不追加矛盾 directive）
  const before8 = fs.readFileSync(userMd8, 'utf8');
  const approvalId = enqueueUserProfileApproval(db8, {
    operations: [
      { op: 'supersede', stagingId: 99, directive: 'Always 部署走灰度（含紧急回滚预案）。', oldDirective: 'Always 部署走灰度。', confidence: 0.6 },
      { op: 'delete', stagingId: 98, directive: '', oldDirective: 'Always 派单前先看板。', confidence: 0.6 }
    ],
    baseHash: before8,
    baseContentChars: before8.length,
    reason: 'task_close',
    now: NOW
  });
  assert.equal(approvalId > 0, true);
  const decided = decideUserProfileApproval(db8, approvalId, 'approve', {
    targetFileAbs: userMd8,
    baseHashFn: (t) => t,
    now: NOW
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.appliedCount, 2);
  const disk8b = fs.readFileSync(userMd8, 'utf8');
  assert.ok(disk8b.includes('Always 部署走灰度（含紧急回滚预案）。'), 'supersede 新指令在场');
  assert.ok(!disk8b.includes('Always 部署走灰度。\n'), '旧指令被原位替换（无矛盾条目并存）');
  assert.ok(!disk8b.includes('Always 派单前先看板。'), 'delete 生效');
  assert.equal((disk8b.match(/Always/g) || []).length, 1, 'supersede-in-place：不追加');
  // staging 联动（99/98 不存在，transitionStaging 静默跳过——此处仅断言审批状态翻转）
  const { listApprovals } = await import(pathToFileURL(compile('main/memory/db.ts')).href);
  assert.equal(listApprovals(db8).find((a) => a.id === approvalId).state, 'approved');

  // reject：候选退场
  const approvalId2 = enqueueUserProfileApproval(db8, {
    operations: [{ op: 'add', stagingId: 97, directive: 'Never 被驳回的指令。', confidence: 0.5 }],
    baseHash: fs.readFileSync(userMd8, 'utf8'),
    baseContentChars: 100,
    reason: 'task_close',
    now: NOW
  });
  const rejected = decideUserProfileApproval(db8, approvalId2, 'reject', { targetFileAbs: userMd8, baseHashFn: (t) => t, now: NOW });
  assert.equal(rejected.ok, true);
  assert.equal(listApprovals(db8).find((a) => a.id === approvalId2).state, 'rejected');
  assert.ok(!fs.readFileSync(userMd8, 'utf8').includes('Never 被驳回的指令。'));

  // 9a. 哈希冲突整体放弃
  const approvalId3 = enqueueUserProfileApproval(db8, {
    operations: [{ op: 'add', stagingId: 96, directive: 'Never 冲突指令。', confidence: 0.5 }],
    baseHash: 'stale-hash',
    baseContentChars: 100,
    reason: 'task_close',
    now: NOW
  });
  const conflict = decideUserProfileApproval(db8, approvalId3, 'approve', { targetFileAbs: userMd8, baseHashFn: (t) => t, now: NOW });
  assert.equal(conflict.hashConflict, true);
  assert.ok(!fs.readFileSync(userMd8, 'utf8').includes('Never 冲突指令。'), '哈希冲突不写盘');

  // 9b. plan 纯函数：supersede 歧义只拒该条；add 超 4000 上限单条拒
  const plan8 = planProfileWrite({
    currentContent: '<!-- observed: 2026-09-01 | status: active -->\nAlways 重复的指令。\n\n<!-- observed: 2026-09-02 | status: active -->\nAlways 重复的指令。\n',
    ops: [{ op: 'supersede', stagingId: 1, directive: 'x', oldDirective: 'Always 重复的指令。', confidence: 0.9 }],
    now: new Date(NOW)
  });
  assert.equal(plan8.applied.length, 0, '歧义定位拒绝');
  assert.equal(plan8.rejected[0].category, 'ambiguous');
  const plan8b = planProfileWrite({
    currentContent: '',
    ops: [{ op: 'add', stagingId: 2, directive: 'y'.repeat(4100), confidence: 0.9 }],
    now: new Date(NOW)
  });
  assert.equal(plan8b.rejected[0].category, 'over_cap', '上限单条拒');

  // supersede 放大 directive 顶破全文 4000 硬上限（还原即红：planProfileWrite 只对
  // add 做 over_cap 时本用例转红——supersede 会绕过上限把超限内容写入）
  {
    const shortDirective = 'Always 短指令。';
    const pad = '<!-- observed: 2026-09-01 | status: active -->\n' + 'p'.repeat(3500) + '\n';
    const cur = `${pad}\n<!-- observed: 2026-09-02 | status: active -->\n${shortDirective}\n`;
    assert.ok(cur.trim().length <= USER_PROFILE_MAX_CHARS, '基线画像在上限内');
    const longDirective = 'Always ' + '长'.repeat(600) + '。';
    const planOver = planProfileWrite({
      currentContent: cur,
      ops: [
        {
          op: 'supersede',
          stagingId: 3,
          directive: longDirective,
          oldDirective: shortDirective,
          confidence: 0.6
        }
      ],
      now: new Date(NOW)
    });
    assert.equal(planOver.applied.length, 0, 'supersede 超上限不应用');
    assert.equal(planOver.rejected[0].category, 'over_cap', 'supersede 顶破全文上限 → over_cap');
    assert.equal(planOver.changed, false, '超限 supersede 不改 content');
    assert.ok(!planOver.content.includes('长'.repeat(600)), '超限新指令不进 content');

    // executeProfileWrite 写盘前防御性复核（还原即红：去掉写盘前长度断言后，
    // 若组装侧漏检则会落盘；本用例与 plan 侧断言互为双保险）
    // 注意：setUserProfileFilePath 吃 userDataDir 而非文件路径，恢复必须回 userData8
    try {
      const wsCap = freshWs('ws-profile-overcap');
      const dbCap = openMemoryDb(wsCap);
      const udCap = path.join(tmp, 'userdata-overcap');
      setUserProfileFilePath(udCap);
      const userMdCap = getUserProfileFilePath();
      fs.mkdirSync(path.dirname(userMdCap), { recursive: true });
      fs.writeFileSync(userMdCap, cur, 'utf8');
      const outCap = executeProfileWrite(dbCap, {
        ops: [
          {
            op: 'supersede',
            stagingId: 3,
            directive: longDirective,
            oldDirective: shortDirective,
            confidence: 0.6
          }
        ],
        targetFile: userMdCap,
        baseHashFn: (t) => t,
        now: NOW,
        cause: 'test-overcap'
      });
      assert.equal(outCap.plan.changed, false, 'execute 侧超限不改写');
      assert.ok(outCap.plan.rejected.some((r) => r.category === 'over_cap'), 'execute 路径 over_cap');
      const diskCap = fs.readFileSync(userMdCap, 'utf8');
      assert.ok(!diskCap.includes('长'.repeat(600)), '超限 supersede 不落盘');
      assert.ok(diskCap.includes(shortDirective), '原指令原样保留');
      dbCap.close();
    } finally {
      setUserProfileFilePath(userData8);
    }
  }

  // 9c. 面板直改 = 终审免审（不走审批队列，直接落盘 + 原子写）
  const prof8 = memoryCenterProfile();
  assert.equal(prof8.available, true);
  const edit8 = memoryCenterUpdateProfile({
    hash: prof8.hash,
    ops: [{ kind: 'add', directive: 'Prefer 先写测试再实现。', status: 'active' }]
  });
  assert.equal(edit8.stale, false);
  assert.ok(readUserProfile().includes('Prefer 先写测试再实现。'), '直改直接落盘');
  const list8 = listApprovals(db8).filter((a) => a.action === 'user_md_change');
  assert.ok(!list8.some((a) => JSON.parse(a.payload).operations?.some?.((o) => o.directive === 'Prefer 先写测试再实现。')), '直改不入审批队列');
  // stale 防护
  const stale8 = memoryCenterUpdateProfile({ hash: 'bad', ops: [{ kind: 'remove', id: 'x' }] });
  assert.equal(stale8.stale, true);
  // 面板 intents 读写 + 手动取消/重武装
  const intents8 = memoryCenterIntents(ws8, NOW);
  assert.equal(intents8.items.length, 0);
  const i8 = insertIntent(db8, { description: '面板可见意图', triggerKeywords: ['k'], now: NOW });
  const intents8b = memoryCenterIntents(ws8, NOW);
  assert.equal(intents8b.items[0].id, i8.id);
  assert.equal(intents8b.items[0].cooldownRemainMs, null, '未发射无冷却');
  assert.equal(memoryCenterCancelIntent(ws8, i8.id).ok, true);
  assert.equal(memoryCenterIntents(ws8, NOW).items[0].state, 'cancelled');
  assert.equal(memoryCenterRearmIntent(ws8, i8.id).ok, true);
  assert.equal(memoryCenterIntents(ws8, NOW).items[0].state, 'armed');
}

/* ---------------- 9. 画像模型回合解析（操作决策 JSON） ---------------- */
{
  assert.deepEqual(parseProfileOperations(null), null);
  assert.deepEqual(parseProfileOperations('不是 JSON'), null);
  const ops = parseProfileOperations('```json\n{"operations":[{"op":"add","candidateId":3,"directive":"Always a","confidence":0.9},{"op":"delete","candidateId":4,"oldDirective":"Always b","confidence":0.4}]}');
  assert.equal(ops.length, 2);
  assert.equal(ops[0].stagingId, 3);
  assert.equal(ops[1].op, 'delete');
  // add 缺 directive 丢弃；delete 缺 oldDirective 丢弃
  const ops2 = parseProfileOperations('{"operations":[{"op":"add","candidateId":5,"confidence":0.9},{"op":"delete","candidateId":6,"confidence":0.9}]}');
  assert.equal(ops2.length, 0);
}

/* ---------------- 12. hosts 身份门：调度 / Worker 会话放行，匿名拒（2026-10-23 intent 开放 Worker） ---------------- */
{
  const hostsMod = await import(pathToFileURL(compile('main/capabilities/hosts/intents.ts')).href);
  const agentScopeMod = await import(pathToFileURL(compile('main/agent/agentScope.ts')).href);
  const { runAsSchedulerTool, runAsAgentSession } = agentScopeMod;
  const ws12 = freshWs('ws-gate');
  const ctx12 = { config: { get: () => ({ workspaces: [{ id: 'ws-gate', path: ws12, rootsRevision: 0 }], activeWorkspaceId: 'ws-gate' }) } };
  const call = () => hostsMod.intentsHost.intent(ctx12, { action: 'list' });
  // 匿名调用：身份门拒（还原转红参照：把门改回仅 isSchedulerInvocation 时，Worker 用例转身份错）
  assert.throws(call, /调度或 Worker 会话身份/, '匿名调用拒');
  // 调度调用链：过门并全链路跑通 list
  const viaScheduler = await runAsSchedulerTool(call);
  assert.equal(viaScheduler.action, 'list', '调度过身份门');
  // Worker 会话（actor 身份）：同样过门跑通
  const viaWorker = await runAsAgentSession('se-worker-intent-1', call);
  assert.equal(viaWorker.action, 'list', 'Worker 会话过身份门');
}

console.log('memory-intents(B7): ok');
