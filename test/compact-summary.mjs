/**
 * B3 结构化压缩摘要模板 + transcript 指针行回归（zcode-adoption-plan B3，批次 R3）：
 * 1) 六节核心齐全且有序；2) 逐字保留条款在（全量独立成节 + 微压缩随核心带上）；
 * 3) 两版共用同一套核心（微压缩引用六节核心 + 保留轮询清理指令）；
 * 4) 用户补充说明追加且优先级最高；5) transcript 指针行格式（<系统提醒> 包裹、
 * 带路径与「文件工具按需读取」指引）；6) 转红锚：orchestrator 必须把全量模板与
 * 指针行接进压缩链路（摘掉 → 本文件转红，见 §6 注）。
 * 运行: node test/compact-summary.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-summary-'));
const compile = createSharedCompiler(root, tmp);

const summary = await import(pathToFileURL(compile('shared/compactSummary.ts')).href);
const {
  COMPACT_SUMMARY_CORE_SECTIONS,
  COMPACT_SUMMARY_VERBATIM_CLAUSE,
  buildFullCompactInstructions,
  TRANSCRIPT_POINTER_TAG,
  buildTranscriptPointerLine
} = summary;
const policy = await import(pathToFileURL(compile('shared/microcompactPolicy.ts')).href);
const { buildMicroCompactInstructions, MICROCOMPACT_COMPACTABLE_TOOLS } = policy;

// 六节的稳定识别锚（措辞即合同：改动要有意识地同步测试；R5 起英文）
const SECTION_ANCHORS = [
  'Primary request and intent',
  'Key facts and decisions',
  'User global rules and safety constraints',
  'Delegation and acceptance pipeline status',
  'Current work at compaction time',
  'Suggested next step'
];

// ── 1) 六节核心齐全且有序 ──
{
  assert.equal(COMPACT_SUMMARY_CORE_SECTIONS.length, 6, '六节核心');
  SECTION_ANCHORS.forEach((anchor, i) => {
    assert.ok(
      COMPACT_SUMMARY_CORE_SECTIONS[i].includes(anchor),
      `第 ${i + 1} 节应含「${anchor}」`
    );
  });
  // 第 3 节自带逐字保留措辞（ZCode prompt.ts「preserved verbatim」条款同款）
  assert.ok(
    COMPACT_SUMMARY_CORE_SECTIONS[2].includes('preserved verbatim'),
    '核心第 3 节必须写明逐字保留'
  );
  console.log('ok   六节核心齐全且有序');
}

// ── 2) 全量模板：六节 + 逐字保留条款 + 标识符保留纪律 ──
{
  const full = buildFullCompactInstructions();
  const positions = SECTION_ANCHORS.map((a) => full.indexOf(a));
  for (const p of positions) assert.ok(p >= 0, '全量模板含全部六节');
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    '六节在模板中按序出现'
  );
  assert.ok(full.includes(COMPACT_SUMMARY_VERBATIM_CLAUSE), '逐字保留条款全文在');
  assert.ok(full.includes('six sections'), '模板声明六节结构');
  assert.ok(full.includes('verbatim — never refer'), '标识符（会话名/路径/id）原样保留纪律在');
  assert.ok(!full.includes('Additional instructions'), '无用户补充时不出现补充指令段');

  // 用户补充说明（/compact <说明>）：追加 + 优先级最高
  const withExtra = buildFullCompactInstructions('只关注会话验收相关内容');
  assert.ok(withExtra.includes('Additional instructions (user-specified, highest priority): 只关注会话验收相关内容'));
  assert.ok(withExtra.indexOf('Additional instructions') > withExtra.indexOf('Suggested next step'), '补充指令在模板之后');
  console.log('ok   全量模板（六节有序/逐字保留/补充指令追加）');
}

// ── 3) 两版共用同一套核心 ──
{
  const micro = buildMicroCompactInstructions();
  assert.ok(micro.includes('six-section core'), '微压缩版引用共用六节核心');
  assert.ok(micro.includes(COMPACT_SUMMARY_VERBATIM_CLAUSE), '微压缩版带逐字保留条款');
  // 轮询清理指令保留（B1 既有合同：白名单点名/一行结论/保留最近 5 条；R5 后白名单=observe+list）
  for (const tool of ['sessions.observe', 'memory.list']) {
    assert.ok(micro.includes(tool), `微压缩指令点名白名单工具 ${tool}`);
  }
  assert.ok(!micro.includes('tools.search'), 'R5 发现层退役：微压缩指令不再点名 tools.search');
  assert.ok(micro.includes('one-line conclusion'), '旧结果压成一行结论纪律在');
  assert.ok(micro.includes('most recent 5'), '保留最近 5 条在');
  // keepRecent 入参与判定侧同口径：指令跟随配置，不写死 5
  assert.ok(
    buildMicroCompactInstructions(10).includes('most recent 10'),
    'keepRecent=10 时指令写最近 10 条'
  );
  assert.equal(
    micro.split('sessions.observe').length,
    MICROCOMPACT_COMPACTABLE_TOOLS.includes('sessions.observe') ? 2 : 1,
    '白名单点名各出现一次'
  );
  console.log('ok   两版共用核心（微压缩=清理指令+六节核心与逐字条款）');
}

// ── 4) transcript 指针行 ──
{
  assert.equal(TRANSCRIPT_POINTER_TAG, '<system-reminder>', '与 C1 date-change 同款标签');
  const line = buildTranscriptPointerLine('/data/pi-sessions/main/transcript-abc-123.jsonl');
  assert.ok(line.startsWith(TRANSCRIPT_POINTER_TAG) && line.endsWith(TRANSCRIPT_POINTER_TAG));
  assert.ok(line.includes('/data/pi-sessions/main/transcript-abc-123.jsonl'), '带快照路径');
  assert.ok(line.includes('full-history snapshot'), '说明语义（快照已存）');
  assert.ok(line.includes('file tool'), '回读指引（文件工具）');
  console.log('ok   transcript 指针行（标签/路径/回读指引）');
}

// ── 5) registry 同源：模板与指针登记处引用本模块（轻量锚，完整性在 injection-registry.mjs）──
{
  const regSrc = fs.readFileSync(path.join(root, 'src/main/agent/injection-registry.ts'), 'utf8');
  assert.ok(regSrc.includes('scheduler.compact.summary-template'), '全量模板已登记');
  assert.ok(regSrc.includes('scheduler.turn-prefix.transcript-pointer'), '指针行已登记');
  console.log('ok   registry 登记锚');
}

// ── 6) 还原转红锚：模板与指针必须接进 orchestrator 压缩链路 ──
// 自查方式：把 compactSession 的 buildFullCompactInstructions 合成摘掉（手动回落
// 原样透传）、或删掉 applyTranscriptPointerInjection 注入、或去掉快照接线
// snapshotTranscriptForCompact，本节断言即转红。
{
  // 拆分后压缩链在 orchestrator/compaction.ts、指针注入在 orchestrator/memoryInjection.ts：
  // 守卫读「门面 + 子模块全量」拼接源（拆分 2026-09-26，锚点语义不变）
  const orchDir = path.join(root, 'src/main/agent/orchestrator');
  const src = [
    fs.readFileSync(path.join(root, 'src/main/agent/orchestrator.ts'), 'utf8'),
    ...fs
      .readdirSync(orchDir)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => fs.readFileSync(path.join(orchDir, f), 'utf8'))
  ].join('\n');
  assert.ok(
    src.includes('buildFullCompactInstructions(instructions)'),
    '手动压缩必须经全量模板合成（用户说明=补充指令）'
  );
  assert.ok(
    src.includes("o.compactSession(wsId, buildFullCompactInstructions(), { source: 'auto' })"),
    '0.8 自动全量压缩必须带全量模板'
  );
  assert.ok(
    src.includes('applyTranscriptPointerInjection(bucket, out)'),
    '回合前缀必须挂 transcript 指针注入'
  );
  assert.ok(
    src.includes('snapshotTranscriptForCompact('),
    'compactSession 必须先做 transcript 快照（fail-open）'
  );
  assert.ok(
    src.includes('b.transcriptPointer = snapshotPath'),
    '快照成功才注入指针行'
  );
  console.log('ok   还原转红锚（模板/指针链路接线守卫）');
}

console.log('compact-summary: ok');
