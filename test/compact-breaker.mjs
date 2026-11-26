/**
 * B2 双熔断状态机 + 超窗错误分类回归（zcode-adoption-plan B2，批次 R3）：
 * 1) 初始态/夹紧；2) 回合喂线老化；3) rapid-refill：compact 成功后 3 回合内再次
 *    触发自动压缩计 1 次，连击 3 次熔断；4) 窗口边界（恰好 3 回合不属 rapid，
 *    streak 归零）；5) 首次自动压缩（从未成功压缩）不计 refill（ZCode undefined
 *    tracking 计 0 同款）；6) 连续失败熔断（2 次）；7) 手动 /compact 成功恢复
 *    （开新 refill 窗）+ 会话重建重置；8) 熔断后自动路径被挡；9) 超窗错误分类
 *    （真实 provider 错误消息 fixture，Anthropic/OpenAI-compatible/DS4/Cerebras/
 *    排除项）；10) 还原转红锚：orchestrator 必须把熔断状态机喂进压缩链（摘掉
 *    喂线 → 本文件至少一条用例转红，见 §10 注）。
 * 运行: node test/compact-breaker.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-breaker-'));
const compile = createSharedCompiler(root, tmp);

const br = await import(pathToFileURL(compile('shared/compactBreaker.ts')).href);
const {
  RAPID_REFILL_TURN_WINDOW,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  MAX_CONSECUTIVE_COMPACT_FAILURES,
  initialCompactBreakerState,
  feedBreakerTurnCompleted,
  isAutoCompactBlocked,
  beginAutoCompactAttempt,
  recordAutoCompactOutcome,
  recordManualCompactSuccess,
  resetCompactBreaker,
  classifyContextOverflowMessage
} = br;

// ── 1) 常量与初始态 ──
{
  assert.equal(RAPID_REFILL_TURN_WINDOW, 3, 'rapid-refill 窗口 3 回合（ZCode 同款）');
  assert.equal(MAX_CONSECUTIVE_RAPID_REFILLS, 3, '连击 3 次熔断（ZCode 同款）');
  assert.equal(MAX_CONSECUTIVE_COMPACT_FAILURES, 2, '连续失败 2 次熔断');
  const s = initialCompactBreakerState();
  assert.deepEqual(
    { ...s, trippedReason: undefined, trippedAt: undefined },
    {
      turnsSinceCompact: 0,
      refillStreak: 0,
      failureStreak: 0,
      tripped: false,
      trippedReason: undefined,
      trippedAt: undefined
    }
  );
  assert.ok(!('lastCompactAt' in s), '初始态无 lastCompactAt 键（从未压缩过）');
  assert.equal(isAutoCompactBlocked(s), false);
  assert.deepEqual(resetCompactBreaker(), initialCompactBreakerState(), '会话重建重置=初始态');
  console.log('ok   常量与初始态');
}

// ── 2) 回合喂线老化 ──
{
  let s = initialCompactBreakerState();
  s = feedBreakerTurnCompleted(s, 1000);
  assert.equal(s.turnsSinceCompact, 1);
  s = feedBreakerTurnCompleted(s, 2000);
  assert.equal(s.turnsSinceCompact, 2);
  assert.equal(s.refillStreak, 0, '喂线只老化窗口，不动 streak');
  // 损坏值夹紧：负数/非有限归零
  const bad = feedBreakerTurnCompleted({ turnsSinceCompact: -5, refillStreak: NaN, failureStreak: 1.9, tripped: false });
  assert.equal(bad.turnsSinceCompact, 1, '负数夹紧为 0 再老化');
  assert.equal(bad.refillStreak, 0);
  assert.equal(bad.failureStreak, 1, '小数下取整');
  console.log('ok   回合喂线老化 + 损坏值夹紧');
}

// ── 3) rapid-refill 连击熔断 ──
// 场景：压缩成功开新窗口（turns=0）→ 每回合收口先喂线再尝试 → 窗口内（turns<3）
// 每次尝试计 1 次 refill；压缩成功又把 turns 归零 → 连续三个回合内反复压缩 →
// 第 3 次尝试打闸。
{
  let s = recordAutoCompactOutcome(initialCompactBreakerState(), true, 1000).state; // 压缩成功
  assert.equal(s.turnsSinceCompact, 0, '成功开新窗口');
  assert.equal(s.failureStreak, 0);

  // 第 1 回合：喂线(1) → 触发压缩 → streak 1，允许
  s = feedBreakerTurnCompleted(s, 2000);
  let a = beginAutoCompactAttempt(s, 2000);
  assert.equal(a.allowed, true);
  assert.equal(a.state.refillStreak, 1);
  assert.equal(a.justTripped, false);
  s = recordAutoCompactOutcome(a.state, true, 2500).state; // 又成功 → turns 归 0

  // 第 2 回合：streak 2
  s = feedBreakerTurnCompleted(s, 3000);
  a = beginAutoCompactAttempt(s, 3000);
  assert.equal(a.allowed, true);
  assert.equal(a.state.refillStreak, 2);
  s = recordAutoCompactOutcome(a.state, true, 3500).state;

  // 第 3 回合：streak 3 → 熔断 + 拒绝本次压缩
  s = feedBreakerTurnCompleted(s, 4000);
  a = beginAutoCompactAttempt(s, 4000);
  assert.equal(a.allowed, false, '连击 3 次 → 拒绝自动压缩');
  assert.equal(a.justTripped, true, '打闸当拍只报一次');
  assert.equal(a.state.tripped, true);
  assert.equal(a.state.trippedReason, 'rapid-refill');
  assert.equal(a.state.trippedAt, 4000);
  s = a.state;

  // 熔断后自动路径全部被挡，且状态冻结（不再累计）
  assert.equal(isAutoCompactBlocked(s), true);
  const frozen = beginAutoCompactAttempt(s, 5000);
  assert.equal(frozen.allowed, false);
  assert.equal(frozen.justTripped, false, '已熔断后再尝试不重复报打闸');
  assert.equal(frozen.state.trippedAt, 4000, '状态冻结不漂移');
  const frozenOutcome = recordAutoCompactOutcome(s, false, 5000);
  assert.equal(frozenOutcome.state.tripped, true);
  assert.equal(frozenOutcome.justTripped, false);
  console.log('ok   rapid-refill 连击熔断（3 回合内复满 ×3 → 停自动压缩）');
}

// ── 4) 窗口边界：恰好 3 回合后触发不算 rapid，streak 归零 ──
{
  let s = recordAutoCompactOutcome(initialCompactBreakerState(), true, 1000).state;
  s = feedBreakerTurnCompleted(s, 2000); // 1
  s = beginAutoCompactAttempt(s, 2000).state; // streak 1
  assert.equal(s.refillStreak, 1);
  // 窗口自然老化：喂到恰好 3 回合
  s = feedBreakerTurnCompleted(s, 3000); // 2
  s = feedBreakerTurnCompleted(s, 4000); // 3
  const a3 = beginAutoCompactAttempt(s, 4000);
  assert.equal(a3.allowed, true, '恰好 3 回合（窗口边界）不算 rapid，不熔断');
  assert.equal(a3.state.refillStreak, 0, 'turns=3 不再 < 3 → streak 归零（ZCode evaluateRapidRefill 同款）');
  // 窗口外再老一回合同理
  s = a3.state;
  s = feedBreakerTurnCompleted(s, 5000); // 4（窗口外）
  const a = beginAutoCompactAttempt(s, 5000);
  assert.equal(a.allowed, true, '窗口已过的压缩不受熔断');
  assert.equal(a.state.refillStreak, 0, '窗口外触发 streak 保持归零');
  console.log('ok   窗口边界（恰好 3 回合直测：不属 rapid；窗外归零）');
}

// ── 5) 首次自动压缩不计 refill（ZCode undefined tracking 计 0 同款）──
{
  // 从未成功压缩过（lastCompactAt 缺省）：第一次达阈值触发的压缩是正常行为
  let s = initialCompactBreakerState();
  let a = beginAutoCompactAttempt(s, 1000);
  assert.equal(a.allowed, true);
  assert.equal(a.state.refillStreak, 0, '首次压缩不计 refill #1');
  // 连续多次「从未成功」的失败重试：refill 仍不计（失败走 failureStreak 通道）
  s = recordAutoCompactOutcome(a.state, false, 1100).state;
  assert.equal(s.failureStreak, 1, '第一次失败经 outcome 计数');
  a = beginAutoCompactAttempt(s, 1200);
  assert.equal(a.state.refillStreak, 0, '无成功压缩史时 refill 恒不计');
  assert.equal(a.state.failureStreak, 1, 'attempt 喂线不动失败连击（只由 outcome 累计）');
  // 手动成功开窗后，窗口内的自动压缩开始计 refill
  s = recordManualCompactSuccess(a.state, 2000);
  assert.equal(s.lastCompactAt, 2000, '手动成功开新 refill 窗口');
  s = feedBreakerTurnCompleted(s, 2100);
  a = beginAutoCompactAttempt(s, 2100);
  assert.equal(a.state.refillStreak, 1, '有成功压缩史后，窗口内触发计 refill #1');
  console.log('ok   首次不计 refill（lastCompactAt 口径对齐 ZCode）');
}

// ── 6) 连续失败熔断 ──
{
  let s = initialCompactBreakerState();
  const a1 = beginAutoCompactAttempt(s, 1000); // 首次尝试（从未压缩 → 不计 refill，允许）
  assert.equal(a1.allowed, true);
  assert.equal(a1.state.refillStreak, 0, '首次尝试不计 refill');
  s = a1.state;
  let r = recordAutoCompactOutcome(s, false, 1100);
  assert.equal(r.allowed, true, '失败 1 次不熔断');
  assert.equal(r.state.failureStreak, 1);
  assert.equal(r.justTripped, false);
  s = r.state;
  r = recordAutoCompactOutcome(s, false, 1200);
  assert.equal(r.allowed, false, '连续失败 2 次 → 熔断');
  assert.equal(r.justTripped, true);
  assert.equal(r.state.tripped, true);
  assert.equal(r.state.trippedReason, 'consecutive-failures');
  assert.equal(r.state.failureStreak, 2, '失败连击保留（恢复后立刻识别再次失败）');
  // 中途成功清失败连击（成功=开新窗口+记 lastCompactAt）
  s = initialCompactBreakerState();
  s = beginAutoCompactAttempt(s, 1000).state;
  s = recordAutoCompactOutcome(s, false, 1100).state;
  s = recordAutoCompactOutcome(s, true, 1200).state;
  assert.equal(s.failureStreak, 0, '成功清失败连击');
  assert.equal(s.turnsSinceCompact, 0, '成功开新窗口');
  assert.equal(s.lastCompactAt, 1200, '成功记 lastCompactAt');
  console.log('ok   连续失败熔断（失败 ×2 打闸；成功清零并开窗）');
}

// ── 7) 手动恢复与会话重建 ──
{
  let s = beginAutoCompactAttempt(initialCompactBreakerState(), 1000).state;
  s = recordAutoCompactOutcome(s, false, 1100).state;
  s = recordAutoCompactOutcome(s, false, 1200).state;
  assert.equal(s.tripped, true);
  // 手动 /compact 成功 = 恢复：计数清零 + 开新 refill 窗
  s = recordManualCompactSuccess(s, 1300);
  assert.equal(s.tripped, false, '手动成功解除熔断');
  assert.equal(s.refillStreak, 0);
  assert.equal(s.failureStreak, 0);
  assert.equal(s.turnsSinceCompact, 0);
  assert.equal(s.lastCompactAt, 1300, '手动成功开新窗（手动后快速回满同样计 refill）');
  assert.equal(isAutoCompactBlocked(s), false);
  // 恢复后窗口从 0 起算：下一次触发又在窗口内，重新计 streak
  s = feedBreakerTurnCompleted(s, 2000);
  const a = beginAutoCompactAttempt(s, 2000);
  assert.equal(a.state.refillStreak, 1, '恢复后 refill 重新从 1 计');
  console.log('ok   手动 /compact 成功恢复（开新窗）+ 会话重建重置');
}

// ── 8) 超窗错误分类（真实 provider 错误消息 fixture）──
{
  // 命中：Anthropic
  assert.equal(classifyContextOverflowMessage('prompt is too long: 213462 tokens > 200000 maximum'), true);
  assert.equal(classifyContextOverflowMessage('413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}'), true);
  // 命中：OpenAI / OpenAI-compatible（Completions、LiteLLM 代理）
  assert.equal(classifyContextOverflowMessage('Your input exceeds the context window of this model'), true);
  assert.equal(classifyContextOverflowMessage("Requested token count exceeds the model's maximum context length of 131072 tokens"), true);
  assert.equal(classifyContextOverflowMessage("Input length (265330) exceeds model's maximum context length (262144)."), true);
  assert.equal(classifyContextOverflowMessage("This model's maximum prompt length is 131072 but the request contains 537812 tokens"), true);
  // 命中：其他 provider
  assert.equal(classifyContextOverflowMessage('invalid params, context window exceeds limit'), true); // MiniMax
  assert.equal(classifyContextOverflowMessage('Your request exceeded model token limit: 200000 (requested: 250000)'), true); // Kimi
  assert.equal(classifyContextOverflowMessage('model_context_window_exceeded'), true); // z.ai finish_reason
  assert.equal(classifyContextOverflowMessage('prompt too long; exceeded max context length by 2048 tokens'), true); // Ollama
  assert.equal(classifyContextOverflowMessage('Range of input length should be [1, 6000]'), true); // DashScope/Qwen
  assert.equal(classifyContextOverflowMessage('Prompt has 150,000 tokens, but the configured context size is 128,000 tokens'), true); // DS4
  assert.equal(classifyContextOverflowMessage('400 (no body)'), true); // Cerebras
  assert.equal(classifyContextOverflowMessage('413 status code (no body)'), true); // Cerebras 413 变体
  // 排除：限流/服务端错误不是超窗
  assert.equal(classifyContextOverflowMessage('Throttling error: Too many tokens, please wait before trying again.'), false, 'Bedrock 限流排除');
  assert.equal(classifyContextOverflowMessage('Rate limit reached for requests'), false);
  assert.equal(classifyContextOverflowMessage('429 Too many requests, please retry later'), false);
  assert.equal(classifyContextOverflowMessage('Service unavailable: upstream connect error'), false);
  // 排除：无关失败
  assert.equal(classifyContextOverflowMessage('network timeout after 30000ms'), false);
  assert.equal(classifyContextOverflowMessage(''), false);
  assert.equal(classifyContextOverflowMessage(undefined), false);
  assert.equal(classifyContextOverflowMessage(null), false);
  console.log('ok   超窗错误分类（Anthropic/OpenAI-compatible/DS4/Cerebras/排除限流）');
}

// ── 9) 还原转红锚：B2 状态机必须喂进 orchestrator 的压缩链 ──
// 自查方式：把 orchestrator 的 feedBreakerTurnCompleted / beginAutoCompactAttempt /
// recordAutoCompactOutcome / recordManualCompactSuccess / isAutoCompactBlocked 任一
// 喂线摘掉（或把 compactSession 的 source 语义拆掉），本节断言即转红。源码文本锚
// 是最接近「链路接线」的可离线守卫（真实类依赖 electron，同 microcompact-policy §8）。
{
  // 拆分后熔断喂线分布在门面与 orchestrator/ 子模块（compaction/turnExecution/buckets/sessions），
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
    src.includes('feedBreakerTurnCompleted(bucket.compactBreaker)'),
    '回合收口必须喂熔断状态机（窗口老化）'
  );
  assert.ok(
    src.includes('beginAutoCompactAttempt(b.compactBreaker)'),
    'maybeAutoCompact 链给出压缩动作后必须过 rapid-refill 闸'
  );
  assert.ok(
    src.includes('isAutoCompactBlocked(b.compactBreaker)'),
    '熔断态必须先挡住阈值压缩链'
  );
  assert.ok(
    src.includes('isAutoCompactBlocked(b.compactBreaker)') && src.split('isAutoCompactBlocked(b.compactBreaker)').length >= 3,
    'idle 微压缩路径同样要过熔断闸（两处 gate）'
  );
  assert.ok(
    src.includes('recordAutoCompactOutcome(b.compactBreaker, true)') &&
      src.includes('recordAutoCompactOutcome(b.compactBreaker, false)'),
    '自动压缩成败必须喂熔断状态机'
  );
  assert.ok(
    src.includes('recordManualCompactSuccess(b.compactBreaker)'),
    '手动 /compact 成功必须是恢复通道（全量重置）'
  );
  assert.ok(
    src.includes("signalCompactBreakerTripped(wsId, 'rapid-refill')") &&
      src.includes("signalCompactBreakerTripped(wsId, 'consecutive-failures')"),
    '两种熔断都必须发可见信号'
  );
  assert.ok(
    src.includes('compactBreaker = resetCompactBreaker()'),
    '会话重建必须重置熔断状态'
  );
  assert.ok(
    src.includes("{ source: 'auto' }"),
    '自动压缩必须带 source=auto（手动缺省 manual=恢复通道，不递增失败）'
  );
  console.log('ok   还原转红锚（orchestrator 熔断喂线守卫）');
}

console.log('compact-breaker: ok');
