/**
 * B1 调度会话 microcompact 回归（zcode-adoption-plan B1，批次 R2）：
 * 1) 配置归一（缺省/夹紧）；2) 白名单命中与跳过（点名/pi 注册名互认）；
 * 3) 逐工具保留最近 N 条 + 错误结果保留；4) 最小节省门槛（估算纯函数）；
 * 5) idle 触发判定；6) 0.72→0.8 升级链（decideSchedulerCompactChain：微压缩嵌在
 *    autoCompact 链上，busy/开关互斥）；7) 唤醒集成（mock 层级二动作：idle 达标 →
 *    clear 决策 + 定向指令含白名单）；8) 还原转红锚：orchestrator 源码必须走微压缩
 *    链（把 B1 判定从 autoCompact 链上摘掉 → 本文件至少一条用例转红，见 §8 注）。
 * 运行: node test/microcompact-policy.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microcompact-'));
const compile = createSharedCompiler(root, tmp);

const policy = await import(pathToFileURL(compile('shared/microcompactPolicy.ts')).href);
const {
  DEFAULT_MICROCOMPACT_IDLE_MINUTES,
  DEFAULT_MICROCOMPACT_MIN_SAVINGS_TOKENS,
  DEFAULT_MICROCOMPACT_KEEP_RECENT,
  MICROCOMPACT_TOKEN_RATIO,
  MICROCOMPACT_COMPACTABLE_TOOLS,
  isMicrocompactableToolName,
  estimateTextTokens,
  normalizeMicroCompactConfig,
  normalizeAutoCompactWithMicro,
  isIdleTriggerDue,
  microTriggerRatio,
  decideMicrocompact,
  decideSchedulerCompactChain,
  buildMicroCompactInstructions
} = policy;

// ── 1) 配置归一 ──
{
  assert.deepEqual(normalizeMicroCompactConfig(undefined), {
    enabled: true,
    idleMinutes: DEFAULT_MICROCOMPACT_IDLE_MINUTES,
    minSavingsTokens: DEFAULT_MICROCOMPACT_MIN_SAVINGS_TOKENS,
    keepRecent: DEFAULT_MICROCOMPACT_KEEP_RECENT
  });
  assert.equal(DEFAULT_MICROCOMPACT_IDLE_MINUTES, 30, '缺省 idle 阈值 30 分钟');
  assert.equal(DEFAULT_MICROCOMPACT_MIN_SAVINGS_TOKENS, 2000, '缺省最小节省 2000 tokens');
  assert.equal(DEFAULT_MICROCOMPACT_KEEP_RECENT, 5, '缺省保留最近 5 条（ZCode 同款）');
  const clamped = normalizeMicroCompactConfig({
    enabled: false,
    idleMinutes: 0.5,
    minSavingsTokens: -3,
    keepRecent: 0.2
  });
  assert.equal(clamped.enabled, false);
  assert.equal(clamped.idleMinutes, 1, 'idle 分钟下限 1');
  assert.equal(clamped.minSavingsTokens, 0, '最小节省下限 0');
  assert.equal(clamped.keepRecent, 1, 'keepRecent 下限 1');
  assert.equal(normalizeMicroCompactConfig('junk').enabled, true, '非对象回缺省');

  // autoCompact 整归一带出 micro（config.ts sanitize 消费口径）
  const full = normalizeAutoCompactWithMicro({ enabled: true, ratio: 0.85, micro: { idleMinutes: 45 } });
  assert.equal(full.ratio, 0.85);
  assert.equal(full.micro.idleMinutes, 45);
  assert.equal(full.micro.enabled, true, 'micro 缺省开');
  assert.deepEqual(normalizeAutoCompactWithMicro(undefined).micro.keepRecent, DEFAULT_MICROCOMPACT_KEEP_RECENT);
  console.log('ok   配置归一（缺省/夹紧/autoCompact 带 micro）');
}

// ── 2) 白名单命中与跳过 ──
{
  // 计划点名的读类轮询工具全在清单（R5 后无 tools.search）
  for (const name of ['sessions.observe', 'memory.list']) {
    assert.ok(MICROCOMPACT_COMPACTABLE_TOOLS.includes(name), `${name} 在白名单`);
  }
  assert.ok(!MICROCOMPACT_COMPACTABLE_TOOLS.includes('tools.search'), 'R5 发现层退役：tools.search 出白名单');
  assert.equal(isMicrocompactableToolName('sessions_observe'), true, 'pi 注册名（下划线）命中');
  assert.equal(isMicrocompactableToolName('sessions.observe'), true, 'Catalog 点名命中');
  assert.equal(isMicrocompactableToolName(' sessions.observe '), true, '首尾空白容忍');
  // 写类/短结果/未知工具跳过
  assert.equal(isMicrocompactableToolName('sessions.create'), false, '写类回执不清');
  assert.equal(isMicrocompactableToolName('sessions_message'), false, '派活不清（对账价值）');
  assert.equal(isMicrocompactableToolName('ui_notify'), false, '短文本不值得清');
  assert.equal(isMicrocompactableToolName('ext.demo.ping'), false, '未知动态工具不清');
  console.log('ok   白名单命中与跳过（点名/pi 注册名互认）');
}

// ── 3) 逐工具保留最近 N 条 + 错误/已清保留 ──
{
  const cand = (id, toolName, text, extra = {}) => ({ id, toolName, text, ...extra });
  const sevenSessions = Array.from({ length: 7 }, (_, i) =>
    cand(`s${i}`, 'sessions_observe', `会话列表快照 ${i} ${'x'.repeat(200)}`)
  );
  const d = decideMicrocompact({
    trigger: 'idle',
    enabled: true,
    busy: false,
    candidates: sevenSessions,
    keepRecent: 5,
    minSavingsTokens: 10
  });
  assert.equal(d.action, 'clear');
  // 会话顺序即入列顺序：清最旧的 2 条（s0、s1），保留最近 5 条
  assert.deepEqual(d.clearIds, ['s0', 's1']);
  assert.equal(d.trigger, 'idle');

  // 每工具各自保留：2 个工具各 4 条 → 全保留（nothing-to-clear）
  const twoTools = [
    ...Array.from({ length: 4 }, (_, i) => cand(`a${i}`, 'sessions_observe', 'x'.repeat(300))),
    ...Array.from({ length: 4 }, (_, i) => cand(`b${i}`, 'memory_list', 'y'.repeat(300)))
  ];
  assert.deepEqual(
    decideMicrocompact({ trigger: 'idle', enabled: true, busy: false, candidates: twoTools, minSavingsTokens: 10 }).action,
    'skip'
  );
  // 清理决策只命中白名单工具
  const mixed = [
    cand('w1', 'sessions_message', 'z'.repeat(500)),
    cand('w2', 'sessions_observe', 'x'.repeat(500)),
    cand('w3', 'sessions_observe', 'x'.repeat(500)),
    cand('w4', 'sessions_observe', 'x'.repeat(500)),
    cand('w5', 'sessions_observe', 'x'.repeat(500)),
    cand('w6', 'sessions_observe', 'x'.repeat(500)),
    cand('w7', 'sessions_observe', 'x'.repeat(500))
  ];
  const dm = decideMicrocompact({ trigger: 'idle', enabled: true, busy: false, candidates: mixed, minSavingsTokens: 10 });
  assert.equal(dm.action, 'clear');
  assert.deepEqual(dm.clearIds, ['w2'], '只清白名单工具的超额旧条目（tasks_delegate 不占不清）');

  // 错误结果与已清占位一律保留
  const guarded = Array.from({ length: 7 }, (_, i) =>
    cand(`e${i}`, 'memory.list', 'f'.repeat(300), i < 2 ? { isError: true } : {})
  );
  const dg = decideMicrocompact({ trigger: 'idle', enabled: true, busy: false, candidates: guarded, minSavingsTokens: 10 });
  assert.deepEqual(dg, { action: 'skip', reason: 'nothing-to-clear' }, '7 条里 2 错误保留 + 5 最近保留 → 无可清');
  const clearedMark = Array.from({ length: 7 }, (_, i) =>
    cand(`c${i}`, 'memory_list', 'f'.repeat(300), i < 2 ? { alreadyCleared: true } : {})
  );
  const dc = decideMicrocompact({ trigger: 'idle', enabled: true, busy: false, candidates: clearedMark, minSavingsTokens: 10 });
  assert.deepEqual(dc, { action: 'skip', reason: 'nothing-to-clear' }, '已清占位不重复清');

  assert.deepEqual(
    decideMicrocompact({ trigger: 'idle', enabled: true, busy: false, candidates: [] }).reason,
    'no-candidates'
  );
  // 缺省最小节省 2000：可清 2 条 × 50 tokens = 100 → 不足不动手
  assert.deepEqual(
    decideMicrocompact({ trigger: 'idle', enabled: true, busy: false, candidates: sevenSessions }).reason,
    'below-min-savings'
  );
  assert.equal(
    decideMicrocompact({ trigger: 'idle', enabled: false, busy: false, candidates: sevenSessions }).reason,
    'disabled'
  );
  assert.equal(
    decideMicrocompact({ trigger: 'idle', enabled: true, busy: true, candidates: sevenSessions }).reason,
    'busy'
  );
  console.log('ok   逐工具保留最近 N 条 + 错误/已清/互斥跳过');
}

// ── 4) 估算纯函数与最小节省门槛 ──
{
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('abcdefgh'), 2, 'ASCII 4 字符≈1 token');
  assert.equal(estimateTextTokens('调度调度'), 4, 'CJK 1 字≈1 token');
  // 混合文本：CJK 逐字 + 其余整除
  assert.equal(estimateTextTokens('会话 ab'), 2 + 1, 'CJK 2 + ceil(3/4)=1');

  const big = 'x'.repeat(20_000); // ≈5000 tokens
  const d = decideMicrocompact({
    trigger: 'token-pressure',
    enabled: true,
    busy: false,
    candidates: [
      { id: 'big1', toolName: 'sessions.observe', text: big },
      { id: 'big2', toolName: 'sessions.observe', text: big },
      { id: 'r1', toolName: 'sessions.observe', text: 'tiny' },
      { id: 'r2', toolName: 'sessions.observe', text: 'tiny' },
      { id: 'r3', toolName: 'sessions.observe', text: 'tiny' },
      { id: 'r4', toolName: 'sessions.observe', text: 'tiny' },
      { id: 'r5', toolName: 'sessions.observe', text: 'tiny' }
    ],
    minSavingsTokens: 2000
  });
  assert.equal(d.action, 'clear');
  assert.deepEqual(d.clearIds, ['big1', 'big2']);
  assert.ok(d.estimatedSavingsTokens >= 2000, '估算节省达门槛');

  // 节省不足：可清内容太小 → below-min-savings（放行等 0.8 全量）
  const small = decideMicrocompact({
    trigger: 'token-pressure',
    enabled: true,
    busy: false,
    candidates: [
      { id: 't1', toolName: 'memory.list', text: '短结果' },
      { id: 't2', toolName: 'memory.list', text: '短' },
      { id: 't3', toolName: 'memory.list', text: '短' },
      { id: 't4', toolName: 'memory.list', text: '短' },
      { id: 't5', toolName: 'memory.list', text: '短' },
      { id: 't6', toolName: 'memory.list', text: '短' }
    ],
    minSavingsTokens: 2000
  });
  assert.deepEqual(small, { action: 'skip', reason: 'below-min-savings' });
  console.log('ok   估算纯函数与最小节省门槛');
}

// ── 5) idle 触发判定 ──
{
  const TH = 30 * 60_000;
  const last = 1_000_000;
  assert.equal(isIdleTriggerDue(last + TH, last, TH), true, '正好到阈值触发');
  assert.equal(isIdleTriggerDue(last + TH - 1, last, TH), false, '差 1ms 不触发');
  assert.equal(isIdleTriggerDue(last + 10 * TH, last, TH), true, '远超阈值触发');
  assert.equal(isIdleTriggerDue(last + TH, undefined, TH), false, '无完成时间（新桶/重启）不触发');
  assert.equal(isIdleTriggerDue(last + TH, NaN, TH), false, '非法时间戳不触发');
  assert.equal(isIdleTriggerDue(last + 1, last, 0), false, '非法阈值不触发');
  assert.equal(microTriggerRatio(0.8), 0.8 * MICROCOMPACT_TOKEN_RATIO, '0.72 档 = 阈值×0.9');
  assert.ok(Math.abs(microTriggerRatio(0.8) - 0.72) < 1e-9);
  console.log('ok   idle 触发判定与 0.72 档换算');
}

// ── 6) 0.72→0.8 升级链（decideSchedulerCompactChain）──
{
  const bigCandidates = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`,
    toolName: 'sessions.observe',
    text: 'p'.repeat(4000)
  }));
  const base = {
    autoCompactCapable: true,
    configEnabled: true,
    ratioThreshold: 0.8,
    contextWindow: 100_000,
    busy: false,
    micro: { enabled: true, minSavingsTokens: 2000, keepRecent: 5 }
  };
  // ≥0.8 → 全量压缩（链不打折，微压缩不拦截）
  assert.deepEqual(
    decideSchedulerCompactChain({ ...base, tokens: 80_000, candidates: bigCandidates }),
    { action: 'compact' }
  );
  // 0.75 档 + 节省足够 → micro（token-pressure）
  const micro = decideSchedulerCompactChain({ ...base, tokens: 75_000, candidates: bigCandidates });
  assert.equal(micro.action, 'micro');
  assert.equal(micro.trigger, 'token-pressure');
  assert.equal(micro.decision.clearIds.length, 3, '8 条清最旧 3 条（保留 5）');
  // 0.71 档 → 还没到微压缩档
  assert.deepEqual(
    decideSchedulerCompactChain({ ...base, tokens: 71_000, candidates: bigCandidates }),
    { action: 'skip', reason: 'below-micro-ratio' }
  );
  // 0.75 档但节省不足 → 放行等 0.8（skip below-min-savings）
  assert.deepEqual(
    decideSchedulerCompactChain({ ...base, tokens: 75_000, candidates: bigCandidates, micro: { enabled: true, minSavingsTokens: 999_999, keepRecent: 5 } }),
    { action: 'skip', reason: 'below-min-savings' }
  );
  // 微压缩关 → 链退化为原 decideAutoCompact（0.75 以下全 skip below-threshold）
  assert.deepEqual(
    decideSchedulerCompactChain({ ...base, tokens: 75_000, candidates: bigCandidates, micro: { enabled: false, minSavingsTokens: 2000, keepRecent: 5 } }),
    { action: 'skip', reason: 'below-threshold' }
  );
  // 互斥复用：busy/开关/能力位/未知用量任一 → skip 同因（微压缩不越权）
  assert.deepEqual(
    decideSchedulerCompactChain({ ...base, tokens: 75_000, busy: true, candidates: bigCandidates }),
    { action: 'skip', reason: 'busy' }
  );
  assert.deepEqual(
    decideSchedulerCompactChain({ ...base, tokens: 75_000, configEnabled: false, candidates: bigCandidates }),
    { action: 'skip', reason: 'disabled' }
  );
  assert.deepEqual(
    decideSchedulerCompactChain({ ...base, tokens: 75_000, autoCompactCapable: false, candidates: bigCandidates }),
    { action: 'skip', reason: 'no-capability' }
  );
  assert.deepEqual(
    decideSchedulerCompactChain({ ...base, tokens: null, candidates: bigCandidates }),
    { action: 'skip', reason: 'unknown-usage' }
  );
  console.log('ok   0.72→0.8 升级链（micro 嵌在 autoCompact 链上，互斥同闸）');
}

// ── 7) 唤醒集成（mock 层级二动作）：idle 达标 → 尝试清理 ──
// 真实 Orchestrator 类依赖 electron/Pi 无法离线构造（同 test/turn-gate.mjs 头注），
// 这里按唤醒路径的装配契约做决策级集成：send() 在进回合前以 idle 数据调
// decideMicrocompact(trigger:'idle')，命中即执行 buildMicroCompactInstructions() 的
// 定向指令压缩（层级二）。orchestrator 侧接线由 §8 的源码锚守卫。
{
  const now = 10_000_000_000;
  const lastCompleted = now - 41 * 60_000; // 空闲 41 分钟 ≥ 30 分钟阈值
  const mc = normalizeMicroCompactConfig(undefined);
  const idleDue = isIdleTriggerDue(now, lastCompleted, mc.idleMinutes * 60_000);
  assert.equal(idleDue, true, '唤醒时空闲达标');

  const candidates = [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `wake${i}`,
      toolName: 'sessions_observe',
      text: `sessions 快照 ${i}：${'会话'.repeat(600)}`
    })),
    { id: 'fresh', toolName: 'sessions_observe', text: '最新快照' }
  ];
  const decision = decideMicrocompact({
    trigger: 'idle',
    enabled: mc.enabled,
    busy: false,
    candidates,
    keepRecent: mc.keepRecent,
    minSavingsTokens: mc.minSavingsTokens
  });
  // 7 条同工具结果（6 旧 + 1 新），保留最近 5 → 清最旧 2 条；估算节省 ≥ 2000
  assert.equal(decision.action, 'clear', 'idle 达标且有足量可清 → 尝试清理');
  assert.deepEqual(decision.clearIds, ['wake0', 'wake1'], '清最旧 2 条、保留最近 5 条');
  assert.ok(decision.estimatedSavingsTokens >= mc.minSavingsTokens, '估算节省达最小值');

  // 空闲不足 → 不清理（回到不触发的原文进回合）
  assert.equal(isIdleTriggerDue(now, now - 5 * 60_000, mc.idleMinutes * 60_000), false);

  // 层级二定向指令：白名单点名 + 保留口径 + 一行结论纪律（执行层 compactSession 的入参）
  const instructions = buildMicroCompactInstructions();
  for (const name of ['sessions.observe', 'memory.list']) {
    assert.ok(instructions.includes(name), `指令点名白名单工具 ${name}`);
  }
  assert.ok(!instructions.includes('tools.search'), 'R5 发现层退役：指令不再点名 tools.search');
  assert.ok(instructions.includes('most recent 5'), '指令写明保留最近 5 条');
  assert.ok(instructions.includes('one-line conclusion'), '指令要求旧结果压成一行结论');
  console.log('ok   唤醒集成（idle 达标 → 清理决策 + 层级二定向指令）');
}

// ── 8) 还原转红锚：B1 判定必须挂在 orchestrator 的 autoCompact 链上 ──
// 自查方式：把 orchestrator 的 maybeAutoCompact 换回直调 decideAutoCompact（摘掉
// decideSchedulerCompactChain），或删掉 send() 里的 maybeIdleMicrocompact 唤醒钩子，
// 本节断言即转红。源码文本锚是最接近「链路接线」的可离线守卫（真实类依赖 electron）。
{
  // 拆分后 autoCompact 链接线在 src/main/agent/orchestrator/compaction.ts、
  // send 唤醒钩子在 sendPipeline.ts：守卫读「门面 + 子模块全量」拼接源（拆分 2026-09-26）
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
    src.includes('decideSchedulerCompactChain('),
    'maybeAutoCompact 必须走微压缩链（decideSchedulerCompactChain），不得直调 decideAutoCompact'
  );
  assert.ok(
    !src.match(/decideAutoCompact\s*\(/),
    'orchestrator 不得绕过微压缩链直调 decideAutoCompact（0.72 档会被跳过）'
  );
  assert.ok(
    src.includes('await o.maybeIdleMicrocompact(wsId)'),
    'send() 唤醒路径必须挂 idle 微压缩钩子'
  );
  // 两处调用点（token-pressure 的 ac.micro / idle 的 mc）各自必须传 keepRecent——
  // 计数断言使任一处单独还原为硬编码缺省都转红
  assert.equal(
    (src.match(/buildMicroCompactInstructions\((ac\.micro|mc)\.keepRecent\)/g) ?? []).length,
    2,
    '层级二动作必须带定向摘要指令，且两处调用点均与判定侧 keepRecent 同口径（还原为硬编码缺省即红）'
  );
  console.log('ok   还原转红锚（orchestrator 链路接线守卫）');
}

console.log('microcompact-policy: ok');
