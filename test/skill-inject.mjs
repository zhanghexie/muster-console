/**
 * A2 skill 点名自动加载 + 加载审计 + 20k/回合预算（zcode-adopt-batch-a T3）：
 * 1) 点名即加载：用户消息/派活简报精确名或别名命中 → SKILL.md 正文进上下文；
 * 2) 未点名不整目录注入；
 * 3) 超预算：自动注入被拒、显式 /skill: 仍展开但返回警告；
 * 4) 审计：每次注入记 {skillId,chars,trigger,at,sessionId}（含 NDJSON sink 落盘）。
 * 运行: node test/skill-inject.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-inject-'));
const compile = createSharedCompiler(root, tmp);

const shared = await import(pathToFileURL(compile('shared/skillInject.ts')).href);
const {
  SKILL_INJECT_TURN_BUDGET_CHARS,
  SkillTurnBudget,
  parseSkillFrontmatterMeta,
  detectNamedSkills,
  isDistinctiveSkillToken,
  mentionTokensOf,
  formatSkillPointerBlock,
  planNamedSkillInjection,
  recordExplicitSkillLoad,
  skillInjectAudit,
  skillBudgetWarning,
  formatNamedSkillBlock
} = shared;

const host = await import(pathToFileURL(compile('main/agent/skillInject.ts')).href);
const {
  makeSkillAuditSink,
  loadSkillCandidates,
  applyNamedSkillInjection,
  expandSkillTextWithBudget,
  prepareEngineSkillText,
  appendNamedSkillsToBrief,
  SkillInjectTurnBook,
  SKILL_INJECT_LOG_NAME
} = host;

const sessionId = 'sess-t3';
const now = 1_700_000_000_000;

// ── 0) frontmatter 元数据（name / aliases） ──
{
  const meta = parseSkillFrontmatterMeta(
    '---\nname: journal\ndescription: x\naliases: [jnote, 工作日志]\n---\n\nbody'
  );
  assert.equal(meta.name, 'journal');
  assert.deepEqual(meta.aliases, ['jnote', '工作日志']);

  const csv = parseSkillFrontmatterMeta('---\nname: demo\naliases: d1, d2\n---\nbody');
  assert.deepEqual(csv.aliases, ['d1', 'd2']);

  const auto = parseSkillFrontmatterMeta(
    '---\nname: review\nx-muster-automention: always\n---\nbody'
  );
  assert.equal(auto.autoMention, 'always', 'x-muster-automention: always 解析');
  const never = parseSkillFrontmatterMeta(
    '---\nname: perf-trace\nx-muster-automention: never\n---\nbody'
  );
  assert.equal(never.autoMention, 'never');
  assert.equal(
    parseSkillFrontmatterMeta('---\nname: x\nx-muster-automention: 别的\n---\nbody').autoMention,
    undefined,
    '非法值忽略'
  );

  assert.deepEqual(parseSkillFrontmatterMeta('no frontmatter'), {});
  console.log('ok   frontmatter name/aliases/autoMention 解析');
}

// ── 1) 点名检测：精确名 / 别名 / 词边界 / 未点名 ──
{
  const skills = [
    { name: 'journal', aliases: ['jnote', '工作日志'] },
    { name: 'perf-trace' },
    { name: 'demo-helper' }
  ];
  assert.deepEqual(detectNamedSkills('跑一下 perf-trace 排查', skills), ['perf-trace']);
  assert.deepEqual(
    detectNamedSkills('按 工作日志 处理', skills),
    ['journal'],
    '非 ASCII 别名可辨识 → 命中'
  );
  assert.deepEqual(detectNamedSkills('用 demo-helper 一起上', skills), ['demo-helper']);
  assert.deepEqual(detectNamedSkills('普通的闲聊消息', skills), [], '未点名零命中');
  assert.deepEqual(
    detectNamedSkills('pre-perf-trace-x', skills),
    [],
    '词边界：不误伤连缀'
  );
  assert.deepEqual(
    detectNamedSkills('x-demo-helper-y perf-tracer', skills),
    [],
    '词边界：连字符名两侧也不许粘连'
  );
  console.log('ok   点名检测（可辨识名/非 ASCII 别名/词边界/未点名）');
}

// ── 1b) 2026-09-28 回归：常用单词名不得被裸词点名误伤 ──
// 各 CLI 自带 skill 大量叫 review / loop / goal / shell / share，用户随口一句
// 「帮我 review 一下」曾把整篇 SKILL.md 灌进上下文。
{
  assert.equal(isDistinctiveSkillToken('perf-trace'), true);
  assert.equal(isDistinctiveSkillToken('node_repl'), true);
  assert.equal(isDistinctiveSkillToken('工作日志'), true);
  assert.equal(isDistinctiveSkillToken('review'), false);
  assert.equal(isDistinctiveSkillToken('loop'), false);
  assert.equal(isDistinctiveSkillToken(''), false);

  const common = [
    { name: 'review' },
    { name: 'loop' },
    { name: 'goal' },
    { name: 'shell' },
    { name: 'journal', aliases: ['jnote'] }
  ];
  assert.deepEqual(
    detectNamedSkills('帮我review一下我们skill和mcp的接入方式', common),
    [],
    'review 是常用词，裸词不得触发'
  );
  assert.deepEqual(detectNamedSkills('这个 shell 命令跑不通', common), []);
  assert.deepEqual(detectNamedSkills('goal 是把 loop 去掉', common), []);
  assert.deepEqual(detectNamedSkills('请用 journal 记一笔', common), [], '短名默认不自动注入');
  assert.deepEqual(detectNamedSkills('按 jnote 处理', common), [], '短别名同样不自动注入');

  // 短名要自动注入：frontmatter 显式 opt-in
  assert.deepEqual(
    detectNamedSkills('请用 journal 记一笔', [
      { name: 'journal', aliases: ['jnote'], autoMention: 'always' }
    ]),
    ['journal'],
    'x-muster-automention: always 让短名恢复自动注入'
  );
  // never：连可辨识名也关掉
  assert.deepEqual(
    detectNamedSkills('跑 perf-trace', [{ name: 'perf-trace', autoMention: 'never' }]),
    [],
    'x-muster-automention: never 关掉自动注入'
  );
  assert.deepEqual(mentionTokensOf({ name: 'review' }), []);
  assert.deepEqual(mentionTokensOf({ name: 'review', autoMention: 'always' }), ['review']);
  assert.deepEqual(mentionTokensOf({ name: 'perf-trace' }), ['perf-trace']);
  console.log('ok   常用单词名不被裸词误伤（+ automention opt-in/opt-out）');
}

// ── 2) 点名即加载：正文进注入块 + 审计；未点名零注入 ──
{
  const skills = [
    {
      name: 'journal',
      aliases: ['jnote'],
      autoMention: 'always',
      filePath: 'E:/ws/.agents/skills/journal/SKILL.md',
      baseDir: 'E:/ws/.agents/skills/journal',
      body: '# journal body\n按格式写入 docs/journal/。'
    }
  ];
  const budget = new SkillTurnBudget();
  const plan = planNamedSkillInjection({
    text: '请用 journal 记一笔',
    skills,
    budget,
    sessionId,
    at: now
  });
  assert.ok(plan.injection.includes('<skill name="journal"'), '点名后正文以 <skill> 块进入');
  assert.ok(plan.injection.includes('按格式写入 docs/journal/。'), 'SKILL.md 正文在注入块内');
  assert.equal(plan.audits.length, 1);
  assert.equal(plan.audits[0].skillId, 'journal');
  assert.equal(plan.audits[0].trigger, 'user-mention');
  assert.equal(plan.audits[0].sessionId, sessionId);
  assert.equal(plan.audits[0].at, now);
  assert.ok(plan.audits[0].chars > 0, 'chars 记注入长度');
  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.warning, null);

  const none = planNamedSkillInjection({
    text: '普通消息，不点任何技能',
    skills,
    budget: new SkillTurnBudget(),
    sessionId,
    at: now
  });
  assert.equal(none.injection, '', '未点名不得整目录注入正文');
  assert.equal(none.audits.length, 0);
  console.log('ok   点名即加载（正文进块 + 审计）/ 未点名零注入');
}

// ── 3) 预算：单回合 20k，超限拒自动注入 ──
{
  assert.equal(SKILL_INJECT_TURN_BUDGET_CHARS, 20_000, '默认预算 20k 字符');

  const bigBody = 'x'.repeat(12_000);
  const skills = [
    {
      name: 'big-a',
      filePath: '/a/SKILL.md',
      baseDir: '/a',
      body: bigBody
    },
    {
      name: 'big-b',
      filePath: '/b/SKILL.md',
      baseDir: '/b',
      body: bigBody
    }
  ];
  const budget = new SkillTurnBudget();
  const plan = planNamedSkillInjection({
    text: '请用 big-a 和 big-b',
    skills,
    budget,
    sessionId,
    at: now
  });
  // 两个块各约 12k+，第一个装入后第二个超 20k 被拒
  assert.equal(plan.audits.length, 1, '预算内只装第一个');
  assert.deepEqual(plan.rejected, ['big-b'], '超预算的自动注入被拒');
  assert.ok(plan.warning && plan.warning.includes('skill 预算'), '拒后给出超预算警告');
  assert.ok(budget.used <= budget.limit);

  // 预算耗尽后再点名第三个也拒
  const more = planNamedSkillInjection({
    text: '还要 big-b',
    skills,
    budget,
    sessionId,
    at: now
  });
  assert.equal(more.audits.length, 0);
  assert.deepEqual(more.rejected, ['big-b']);
  assert.ok(more.warning);
  console.log('ok   预算 20k/回合：超限拒绝自动注入 + 警告');
}

// ── 4) 显式 Skill 加载（/skill:）：仍放行但超预算返回警告 ──
{
  const budget = new SkillTurnBudget(100);
  const r1 = recordExplicitSkillLoad({
    skillId: 'journal',
    chars: 80,
    budget,
    sessionId,
    at: now
  });
  assert.equal(r1.warning, null, '预算内显式加载无警告');
  assert.equal(r1.audit.trigger, 'skill-tool');

  const r2 = recordExplicitSkillLoad({
    skillId: 'demo',
    chars: 80,
    budget,
    sessionId,
    at: now
  });
  assert.ok(r2.warning && r2.warning.includes('skill 预算'), '超预算显式加载返回警告');
  assert.ok(budget.used > budget.limit, '显式加载仍记账（可超限）');
  console.log('ok   显式 Skill 加载：仍放行 + 超预算警告');
}

// ── 5) 审计记录形状 + NDJSON sink 落盘 ──
{
  const audit = skillInjectAudit({
    skillId: 'journal',
    chars: 123,
    trigger: 'user-mention',
    sessionId,
    at: now
  });
  assert.deepEqual(Object.keys(audit).sort(), ['at', 'chars', 'sessionId', 'skillId', 'trigger']);
  assert.equal(audit.at, now);
  assert.equal(audit.chars, 123);

  const logsDir = path.join(tmp, 'userData', 'logs');
  const sink = makeSkillAuditSink(path.join(tmp, 'userData'));
  assert.ok(sink, 'sink 可装配');
  sink(audit);
  const file = path.join(logsDir, SKILL_INJECT_LOG_NAME);
  assert.ok(fs.existsSync(file), '审计落 userData/logs/skill-inject.ndjson');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.skillId, 'journal');
  assert.equal(rec.trigger, 'user-mention');
  assert.equal(rec.sessionId, sessionId);
  assert.equal(rec.chars, 123);
  assert.equal(rec.at, now);
  console.log('ok   审计记录形状 + NDJSON 落盘');
}

// ── 6) 宿主装配：applyNamedSkillInjection / expandSkillTextWithBudget / prepareEngineSkillText ──
{
  const ws = path.join(tmp, 'ws');
  const skillDir = path.join(ws, '.agents', 'skills', 'journal');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: journal\ndescription: d\naliases: [jnote]\nx-muster-automention: always\n---\n\n# JOURNAL_BODY\n按格式写入。',
    'utf8'
  );
  const demoDir = path.join(ws, '.agents', 'skills', 'demo-helper');
  fs.mkdirSync(demoDir, { recursive: true });
  fs.writeFileSync(
    path.join(demoDir, 'SKILL.md'),
    '---\nname: demo-helper\ndescription: d\n---\n\n# DEMO_BODY',
    'utf8'
  );
  const listSkills = async () => [
    {
      name: 'journal',
      description: 'd',
      filePath: path.join(skillDir, 'SKILL.md'),
      baseDir: skillDir
    },
    {
      name: 'demo-helper',
      description: 'd',
      filePath: path.join(demoDir, 'SKILL.md'),
      baseDir: demoDir
    }
  ];
  const audits = [];
  const deps = {
    listSkills,
    audit: (ev) => audits.push(ev),
    now: () => now
  };

  // 点名即加载
  const named = await applyNamedSkillInjection('请用 jnote 记一笔', {
    cwd: ws,
    sessionId,
    budget: new SkillTurnBudget(),
    deps,
    at: now
  });
  assert.ok(named.appended.includes('JOURNAL_BODY'), '别名点名 → 正文注入');
  assert.equal(named.audits.length, 1);
  assert.equal(named.audits[0].trigger, 'user-mention');
  assert.equal(audits.length, 1, '审计送到 sink');

  // 未点名不注入
  const plain = await applyNamedSkillInjection('普通消息', {
    cwd: ws,
    sessionId,
    budget: new SkillTurnBudget(),
    deps,
    at: now
  });
  assert.equal(plain.appended, '', '未点名不整目录注入');
  assert.equal(plain.audits.length, 0);

  // 显式 /skill: 展开（主路径语义）+ 审计
  const slash = await expandSkillTextWithBudget('/skill:journal 请记一笔', {
    cwd: ws,
    sessionId,
    budget: new SkillTurnBudget(),
    deps,
    at: now
  });
  assert.ok(slash.text.startsWith('<skill name="journal"'), '/skill: 仍展开 <skill> 块');
  assert.ok(slash.text.includes('JOURNAL_BODY'));
  assert.ok(slash.text.endsWith('请记一笔'), '参数跟在块后（主路径语义不变）');
  assert.ok(slash.audit && slash.audit.trigger === 'skill-tool');
  assert.equal(slash.warning, null, '预算内无警告');

  // prepareEngineSkillText：/skill: 与点名合并、exclude 防重复
  const prepAudits = [];
  const prep = await prepareEngineSkillText('/skill:journal 请用 demo-helper 一起做', {
    cwd: ws,
    sessionId,
    budget: new SkillTurnBudget(),
    deps: { ...deps, audit: (ev) => prepAudits.push(ev) },
    at: now
  });
  assert.ok(prep.text.includes('JOURNAL_BODY'), '/skill: 正文在');
  assert.ok(prep.text.includes('DEMO_BODY'), '点名 demo-helper 正文也在');
  const ids = prep.audits.map((a) => a.skillId).sort();
  assert.deepEqual(ids, ['demo-helper', 'journal'], '两条审计且不重复 journal');
  assert.ok(prep.text.split('JOURNAL_BODY').length === 2, 'journal 只出现一次（exclude）');

  // 超预算：自动注入被拒、显式 /skill: 有警告
  const tiny = new SkillTurnBudget(50);
  const overNamed = await applyNamedSkillInjection('用 journal 和 demo-helper', {
    cwd: ws,
    sessionId,
    budget: tiny,
    deps,
    at: now
  });
  assert.equal(overNamed.appended, '', '超预算自动注入全拒');
  assert.ok(overNamed.rejected.length >= 1);
  assert.ok(overNamed.warning);

  const overSlash = await expandSkillTextWithBudget('/skill:journal x', {
    cwd: ws,
    sessionId,
    budget: new SkillTurnBudget(10),
    deps,
    at: now
  });
  assert.ok(overSlash.text.includes('JOURNAL_BODY'), '显式加载仍放行正文');
  assert.ok(overSlash.warning, '显式加载超预算返回警告');

  // 2026-09-27 复审回归：点名被拒的 warning 也要进引擎文本（模型知情，不再静默丢弃）
  const overPrep = await prepareEngineSkillText('请用 journal 和 demo-helper', {
    cwd: ws,
    sessionId,
    budget: new SkillTurnBudget(50),
    deps,
    at: now
  });
  assert.equal(overPrep.text.includes('JOURNAL_BODY'), false, '超预算正文不注入');
  assert.ok(overPrep.warning, 'prepare 返回 warning');
  assert.ok(
    overPrep.text.includes('预算') || /20k|20000/.test(overPrep.text),
    `warning 文本须进 engine text（得到：${overPrep.text.slice(0, 120)}…）`
  );
  console.log('ok   宿主装配（点名/未点名/skill-tool/超预算/防重复/warning 透传）');
}

// ── 6b) /skill: 普通名未命中不再静默当正文（skills 审计 F-01，2026-10-25）──
// 旧实现：普通名（不带 root:/user/ 等前缀）拼错时原样透传、零警告；
// 限定名未命中却有「技能来源已不可用」警告——不对称。修复后普通名也返回警告。
{
  const ws = path.join(tmp, 'ws-miss');
  const skillDir = path.join(ws, '.agents', 'skills', 'journal');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: journal\ndescription: d\n---\n\n# JOURNAL_BODY', 'utf8');
  const listSkills = async () => [
    { name: 'journal', description: 'd', filePath: path.join(skillDir, 'SKILL.md'), baseDir: skillDir }
  ];
  const deps = { listSkills, now: () => 0 };

  const missed = await expandSkillTextWithBudget('/skill:journall 请记一笔', {
    cwd: ws, sessionId: 's-miss', budget: new SkillTurnBudget(), deps, at: 0
  });
  assert.ok(missed.warning, '普通名未命中返回 warning（不再静默）');
  assert.match(missed.warning, /未找到技能 journall/);
  assert.ok(missed.text.includes('未找到技能 journall'), '警告进引擎文本，模型可见');
  assert.ok(missed.text.includes('请记一笔'), '原正文保留');
  assert.equal(missed.audit, null, '未命中不计审计');

  const briefMissed = await appendNamedSkillsToBrief('简报', '/skill:journall 干活', {
    cwd: ws, sessionId: 's-miss', budget: new SkillTurnBudget(), deps, at: 0
  });
  assert.ok(briefMissed.warning, '简报路径普通名未命中同样返回 warning');
  assert.match(briefMissed.warning, /未找到技能 journall/);
  assert.ok(briefMissed.appended.includes('未找到技能 journall'), '简报附加警告文本');

  // 限定名未命中警告保持原样（对称性参照）
  const qualified = await expandSkillTextWithBudget('/skill:user/journall x', {
    cwd: ws, sessionId: 's-miss', budget: new SkillTurnBudget(), deps, at: 0
  });
  assert.match(qualified.warning, /技能来源已不可用：user\/journall/);
  console.log('ok   /skill: 普通名未命中返回警告（与限定名对称，F-01）');
}

// ── 7) 简报点名「给路径不给全文」（A5）+ 回合预算簿 ──
// 2026-09-28 回归：简报曾把 SKILL.md 整篇塞进去，与 A5 披露分级和「勿贴技能全文」
// 的调度纪律冲突——终端 Worker 自己就能读 SKILL.md。
{
  const ws = path.join(tmp, 'ws');
  const skillFile = path.join(ws, '.agents', 'skills', 'demo-helper', 'SKILL.md');
  const listSkills = async () => [
    {
      name: 'demo-helper',
      description: 'd',
      filePath: skillFile,
      baseDir: path.dirname(skillFile)
    }
  ];
  const audits = [];
  const deps = { listSkills, audit: (ev) => audits.push(ev), now: () => now };
  const brief = '【Muster Console 任务简报】\n任务：用 demo-helper 处理';
  const r = await appendNamedSkillsToBrief(brief, '用 demo-helper 处理', {
    cwd: ws,
    sessionId: 'brief-sess',
    budget: new SkillTurnBudget(),
    deps,
    at: now
  });
  assert.ok(r.appended.startsWith(brief), '简报原文在前');
  assert.ok(r.appended.includes('demo-helper'), '点名 skill 名在指路块里');
  assert.ok(r.appended.includes(skillFile), '给出 SKILL.md 绝对路径');
  assert.equal(r.appended.includes('DEMO_BODY'), false, '简报不得搬 SKILL.md 正文');
  assert.equal(r.audits.length, 1);
  assert.equal(r.audits[0].trigger, 'brief-pointer', '审计 trigger 区分指路与正文注入');
  assert.equal(audits.length, 1, '指路也进审计 sink');

  const plainBrief = await appendNamedSkillsToBrief(brief, '普通任务', {
    cwd: ws,
    sessionId: 'brief-sess',
    budget: new SkillTurnBudget(),
    deps,
    at: now
  });
  assert.equal(plainBrief.appended, brief, '未点名简报零附加');

  assert.equal(formatSkillPointerBlock([]), '', '无命中时指路块为空串');
  const block = formatSkillPointerBlock([{ name: 'a-b', filePath: '/x/SKILL.md' }]);
  assert.ok(block.includes('a-b：/x/SKILL.md'));

  const book = new SkillInjectTurnBook();
  const b1 = book.beginTurn('s1');
  assert.equal(b1.used, 0);
  b1.consume(100);
  assert.equal(book.usedOf('s1'), 100);
  const b2 = book.beginTurn('s1');
  assert.equal(b2.used, 0, '新回合预算重置');
  book.current('s2').consume(10);
  assert.equal(book.usedOf('s2'), 10, 'steer/插话沿用本回合预算');
  book.endTurn('s2');
  assert.equal(book.usedOf('s2'), 0, '回合收口丢预算');
  console.log('ok   简报点名只给路径 + 回合预算簿');
}

// ── 7b) 会话级去重：同一 skill 一个会话只注一次正文；显式 /skill: 不受限 ──
{
  const ws = path.join(tmp, 'ws');
  const skillDir = path.join(ws, '.agents', 'skills', 'demo-helper');
  const listSkills = async () => [
    {
      name: 'demo-helper',
      description: 'd',
      filePath: path.join(skillDir, 'SKILL.md'),
      baseDir: skillDir
    }
  ];
  const deps = { listSkills, now: () => now };
  const book = new SkillInjectTurnBook();
  const sid = 'dedupe-sess';

  const first = await prepareEngineSkillText('用 demo-helper 做一下', {
    cwd: ws,
    sessionId: sid,
    budget: book.beginTurn(sid),
    alreadyInjected: book.injectedOf(sid),
    deps,
    at: now
  });
  assert.ok(first.text.includes('DEMO_BODY'), '首次点名注入正文');
  assert.deepEqual(first.injectedIds, ['demo-helper'], 'injectedIds 报告本次注入');
  book.noteInjected(sid, first.injectedIds);

  const second = await prepareEngineSkillText('继续用 demo-helper', {
    cwd: ws,
    sessionId: sid,
    budget: book.beginTurn(sid),
    alreadyInjected: book.injectedOf(sid),
    deps,
    at: now
  });
  assert.equal(second.text.includes('DEMO_BODY'), false, '同会话再点名不重复注入正文');
  assert.equal(second.text, '继续用 demo-helper', '文本原样通过');
  assert.deepEqual(second.injectedIds, []);

  // 显式 /skill: 永远照办（用户明确意图）
  const slash = await prepareEngineSkillText('/skill:demo-helper 再来一次', {
    cwd: ws,
    sessionId: sid,
    budget: book.beginTurn(sid),
    alreadyInjected: book.injectedOf(sid),
    deps,
    at: now
  });
  assert.ok(slash.text.includes('DEMO_BODY'), '显式 /skill: 不受会话级去重限制');

  // 换会话重新可注入；forgetSession 清台账
  assert.deepEqual(book.injectedOf('other-sess'), []);
  book.forgetSession(sid);
  assert.deepEqual(book.injectedOf(sid), [], 'forgetSession 清掉已注入台账');
  console.log('ok   会话级已注入去重（显式 /skill: 例外 + forgetSession 回收）');
}

// ── 8) 注册表登记（A3：新注入点必须登记） ──
{
  const { INJECTION_REGISTRY } = await import(
    pathToFileURL(compile('main/agent/injection-registry.ts')).href
  );
  const hit = INJECTION_REGISTRY.find((s) => s.id === 'worker.turn-prefix.skill-body');
  assert.ok(hit, 'worker.turn-prefix.skill-body 必须登记');
  assert.equal(hit.channel, 'turn-prefix');
  assert.equal(hit.mode, 'conditional');
  assert.ok(/skillInject\.ts/.test(hit.note), 'note 带代码出处');

  const pointer = INJECTION_REGISTRY.find((s) => s.id === 'worker.turn-prefix.skill-pointer');
  assert.ok(pointer, '简报指路块是独立注入点，必须登记');
  assert.equal(pointer.channel, 'turn-prefix');
  assert.ok(/formatSkillPointerBlock/.test(pointer.note), 'note 带代码出处');
  console.log('ok   injection-registry 登记 skill-body / skill-pointer');
}

// ── 9) 2026-09-28 回归：技能发现路径不含 Cursor 产品自带目录 + 链接去重 ──
{
  const { resolveExtraSkillPaths } = await import(
    pathToFileURL(compile('main/agent/systemPrompt.ts')).href
  );
  const src = fs.readFileSync(path.join(root, 'src/main/agent/systemPrompt.ts'), 'utf8');
  // 只看字符串字面量（注释里解释「为什么不含」是允许的）
  assert.equal(
    /['"]skills-cursor['"]/.test(src),
    false,
    '~/.cursor/skills-cursor 是 Cursor 产品自带技能（review/loop/shell 等常用词名），不得进候选表'
  );

  const ws = path.join(tmp, 'ws-paths');
  const real = path.join(ws, '.agents', 'skills');
  fs.mkdirSync(real, { recursive: true });
  const cursorDir = path.join(ws, '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });
  const link = path.join(cursorDir, 'skills');
  let linked = false;
  try {
    fs.symlinkSync(
      path.resolve(real),
      link,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    linked = true;
  } catch {
    /* 无权建链接的环境跳过链接去重断言 */
  }
  const paths = resolveExtraSkillPaths(ws);
  const physical = fs.realpathSync(ws);
  const inWs = paths.filter((p) => p.startsWith(physical + path.sep));
  assert.deepEqual(inWs, [fs.realpathSync(real)], '链接与真身指向同一目录时只保留 .agents/skills 真身');
  if (linked) {
    assert.equal(inWs.includes(link), false, '.cursor/skills 链接被 realpath 去重');
  }
  console.log('ok   技能发现路径（排除 skills-cursor + 链接 realpath 去重）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('skill-inject: ok');
