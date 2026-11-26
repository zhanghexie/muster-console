/**
 * 压缩链（B1/B2/B3）：手动 /compact、0.8 阈值全量压缩、idle/token-pressure 微压缩，
 * 共用 compactSession 的 busy 单飞窗；熔断状态机喂线与可见信号接线保持原位原序。
 * （自 orchestrator.ts 拆分；`this.` 改经 OrchestratorHost 协作面，锚点注释逐字保留。）
 */
import { t } from '../../../shared/i18n';
import { formatNotifyText } from '../../../shared/types';
import {
  beginAutoCompactAttempt,
  isAutoCompactBlocked,
  MAX_CONSECUTIVE_COMPACT_FAILURES,
  recordAutoCompactOutcome,
  recordManualCompactSuccess,
  type CompactBreakerTripReason
} from '../../../shared/compactBreaker';
import { buildFullCompactInstructions } from '../../../shared/compactSummary';
import {
  buildMicroCompactInstructions,
  decideMicrocompact,
  decideSchedulerCompactChain,
  isIdleTriggerDue,
  normalizeAutoCompactWithMicro
} from '../../../shared/microcompactPolicy';
import { CHAT_RUNTIME_CAPABILITIES } from '../../../shared/agentRuntimeCapabilities';
import { snapshotPiContext } from '../piContext';
import { collectSchedulerToolResultCandidates } from '../piMicrocompact';
import { runAsAgentWorkspace } from '../agentScope';
import { compactOrchestratorSession } from '../providers/piProvider';
import { snapshotTranscriptForCompact } from '../transcriptSnapshot';
import type { PiCompactResult } from '../../../shared/piEvents';
import type { OrchestratorHost } from './internal';
import { schedulerIsClosing, trackSchedulerWork } from './lifecycle';

/**
 * 压缩当前会话上下文：空闲期执行；忙/空会话直接拒绝（结果由调用方呈现）。
 * 压缩记录落在 pi 会话转录里；上下文占用要下一轮回合才恢复可见。
 *
 * 压缩窗置 busy 挡并发 send/startTurn（并发回合的 setSession 会与压缩互相覆盖
 * 会话）；待触发的自动重试一并取消——它到点会在压缩中开新回合，重试提示同步清掉。
 *
 * B2 source 语义：
 * - 'manual'（缺省；/compact 与 chat:compact IPC）：熔断不挡（手动是恢复通道）；
 *   成功即全量重置熔断状态（recordManualCompactSuccess）；摘要指令 = B3 全量
 *   模板 + 用户补充说明（优先级最高）。
 * - 'auto'（0.8 全量 / 0.72 与 idle 微压缩）：成败喂熔断状态机（失败连击、
 *   成功开新窗口），达限自动打闸并向调度面板发可见信号。
 *
 * B3 transcript 快照：busy 窗置位后、记忆 flush 前复制会话 JSONL（保持
 * check-and-set 同步原子性——busy 检查与置位之间不插 await；快照 fail-open，
 * 不阻塞压缩），成功则记桶上指针，下一回合前缀注入「完整历史快照已存 <路径>」。
 */
export function compactSession(...args: Parameters<typeof compactSessionOwned>): Promise<PiCompactResult> {
  if (schedulerIsClosing(args[0])) return Promise.resolve({ ok: false, error: 'Scheduler is shutting down' });
  return trackSchedulerWork(args[0], () => compactSessionOwned(...args));
}

async function compactSessionOwned(
  o: OrchestratorHost,
  wsId: string,
  instructions?: string,
  opts?: { source?: 'manual' | 'auto' }
): Promise<PiCompactResult> {
  const source = opts?.source === 'auto' ? 'auto' : 'manual';
  const b = o.ensureBucket(wsId);
  if (b.busy) {
    return { ok: false, error: t('Agent 正忙，请等当前回合结束后再压缩') };
  }
  const pendingRetry = o.autoRetryTimers.get(wsId);
  if (pendingRetry) {
    clearTimeout(pendingRetry);
    o.autoRetryTimers.delete(wsId);
    for (let i = b.display.length - 1; i >= 0; i--) {
      const m = b.display[i]!;
      if (m.role === 'assistant' && m.retryHint) {
        delete m.retryHint;
        o.emit('agent:message', { ...m, workspaceId: wsId });
        break;
      }
    }
  }
  b.busy = true;
  try {
    // B3 transcript 快照（busy 窗内、flush 之前）：必须放在 check-and-set **之后**
    // 做 IO——busy 检查与置位之间不能插 await（R2 的同步原子闸）；pi 的
    // session.compact() 本体无单飞闸（agent-session.js compact() 每次直接
    // new AbortController，并发窗真实有害），宿主侧互斥全靠这个置位。快照
    // fail-open 不抛（失败返回 null），失败也不需要回滚 busy。
    const snapshotPath = await snapshotTranscriptForCompact({
      sessionFile: b.piSessionFile,
      sessionDir: o.ctx.store.getPiSessionDir(wsId)
    });
    const result = await runAsAgentWorkspace(wsId, () =>
      compactOrchestratorSession({
        ctx: o.ctx,
        wsId,
        getSession: () => b.piSession,
        setSession: (s) => {
          b.piSession = s;
        },
        sessionFile: b.piSessionFile,
        targetModel: { providerId: b.providerId, modelId: b.modelId },
        mode: b.mode,
        getThinkingLevel: () => o.getThinkingLevel(wsId),
        // B3 摘要指令接管：手动 = 全量模板 + 用户补充；自动 = 调用方传入的
        // 指令（0.8 全量模板 / 微压缩定向指令）原样生效
        instructions:
          source === 'manual' ? buildFullCompactInstructions(instructions) : instructions
      })
    );
    if (result.ok) {
      // R-12 compact 后刷新：压缩摘要可能丢细节，下回合重读盘上双文件注入
      // （对齐 Claude Code「/compact 后重读 CLAUDE.md」）
      b.memoryInjectionDue = true;
      // B3：快照成功才注入指针行（下一回合消费后清除）
      if (snapshotPath) b.transcriptPointer = snapshotPath;
      // B2：手动成功=恢复通道（全量重置）；自动成功=开新窗口、清失败连击
      b.compactBreaker =
        source === 'manual'
          ? recordManualCompactSuccess(b.compactBreaker)
          : recordAutoCompactOutcome(b.compactBreaker, true).state;
      o.emitContextStatus(wsId);
    } else if (source === 'auto') {
      // B2：自动压缩失败喂熔断；达限打闸并发可见信号（复用通知通道，不造新 UI）
      const br = recordAutoCompactOutcome(b.compactBreaker, false);
      b.compactBreaker = br.state;
      if (br.justTripped) o.signalCompactBreakerTripped(wsId, 'consecutive-failures');
    }
    return result;
  } finally {
    b.busy = false;
    if (b.queue.length) void o.drainQueue(b, wsId);
  }
}

/**
 * 调度侧阈值自动压缩：Pi 独有能力位；复用 compactSession（busy/单飞与手动互斥）。
 * B1 起走微压缩链：0.8 全量判定不变；低于 0.8 但达 0.72（阈值×0.9）档先试微压缩
 * （层级二动作=带定向摘要指令的 compact，节省不足放行 0.8 全量）。
 * B2 熔断：已打闸直接跳过整条自动链；链给出 compact/micro 动作后先过
 * beginAutoCompactAttempt（rapid-refill 计数与熔断），再以 source='auto' 执行——
 * 成败喂 recordAutoCompactOutcome（compactSession 内）。0.8 全量带 B3 全量摘要模板。
 */
export function maybeAutoCompact(o: OrchestratorHost, wsId: string): void {
  if (!CHAT_RUNTIME_CAPABILITIES.pi.autoCompact) return;
  const b = o.buckets.get(wsId);
  if (!b || b.busy || b.queue.length > 0 || !b.piSession) return;
  if (isAutoCompactBlocked(b.compactBreaker)) {
    console.info(`[orchestrator] 自动压缩已熔断，跳过阈值压缩（ws=${wsId}）`);
    return;
  }
  const ac = normalizeAutoCompactWithMicro(o.ctx.config.get().autoCompact);
  const snap = snapshotPiContext(b.piSession);
  const chain = decideSchedulerCompactChain({
    autoCompactCapable: true,
    configEnabled: ac.enabled,
    ratioThreshold: ac.ratio,
    tokens: snap.tokens,
    contextWindow: snap.contextWindow,
    busy: b.busy,
    micro: ac.micro,
    candidates: collectSchedulerToolResultCandidates(b.piSession)
  });
  if (chain.action === 'compact') {
    const attempt = beginAutoCompactAttempt(b.compactBreaker);
    b.compactBreaker = attempt.state;
    if (attempt.justTripped) o.signalCompactBreakerTripped(wsId, 'rapid-refill');
    if (!attempt.allowed) return;
    void o.compactSession(wsId, buildFullCompactInstructions(), { source: 'auto' }).then((r) => {
      if (!r.ok) {
        console.info(`[orchestrator] 自动压缩未执行（ws=${wsId}）: ${r.error}`);
      }
    });
    return;
  }
  if (chain.action === 'micro') {
    const attempt = beginAutoCompactAttempt(b.compactBreaker);
    b.compactBreaker = attempt.state;
    if (attempt.justTripped) o.signalCompactBreakerTripped(wsId, 'rapid-refill');
    if (!attempt.allowed) return;
    const d = chain.decision;
    console.log(
      `[orchestrator] microcompact(token-pressure, ws=${wsId}): 清 ${d.clearIds.length} 条旧轮询结果，估算省 ${d.estimatedSavingsTokens} tokens（层级二：定向指令压缩，一阶近似）`
    );
    void o.compactSession(wsId, buildMicroCompactInstructions(ac.micro.keepRecent), { source: 'auto' }).then((r) => {
      if (!r.ok) {
        console.info(`[orchestrator] 微压缩未执行（ws=${wsId}）: ${r.error}`);
      }
    });
  }
}

/**
 * B1 idle 触发的微压缩（send 非忙碌路径在进回合前调用）：空闲超过阈值（缺省
 * 30 分钟，可配 autoCompact.micro.idleMinutes）且白名单旧轮询结果节省达最小值
 * 才动手。层级二实现：compactSession + 定向摘要指令（spike 结论：pi 无历史改写
 * API，真替换不可行，见 piMicrocompact.ts 头注）。动作与手动 /compact、0.8 自动
 * 压缩互斥——三者都走 compactSession 的 busy 窗。B2：熔断态停这条自动路径
 * （gate-only：idle 微压缩非 token 压力驱动，不计 refill 连击；成败仍喂 outcome）。
 */
export async function maybeIdleMicrocompact(o: OrchestratorHost, wsId: string): Promise<void> {
  const b = o.buckets.get(wsId);
  if (!b || b.busy || b.queue.length > 0 || !b.piSession) return;
  if (isAutoCompactBlocked(b.compactBreaker)) return;
  const mc = normalizeAutoCompactWithMicro(o.ctx.config.get().autoCompact).micro;
  if (!mc.enabled) return;
  if (!isIdleTriggerDue(Date.now(), b.lastTurnCompletedAt, mc.idleMinutes * 60_000)) return;
  const decision = decideMicrocompact({
    trigger: 'idle',
    enabled: true,
    busy: b.busy,
    candidates: collectSchedulerToolResultCandidates(b.piSession),
    keepRecent: mc.keepRecent,
    minSavingsTokens: mc.minSavingsTokens
  });
  if (decision.action !== 'clear') return;
  console.log(
    `[orchestrator] microcompact(idle, ws=${wsId}): 空闲 ${Math.round((Date.now() - (b.lastTurnCompletedAt ?? Date.now())) / 60_000)}min，清 ${decision.clearIds.length} 条旧轮询结果，估算省 ${decision.estimatedSavingsTokens} tokens（层级二：定向指令压缩，一阶近似）`
  );
  const r = await o.compactSession(wsId, buildMicroCompactInstructions(mc.keepRecent), { source: 'auto' });
  if (!r.ok) {
    console.info(`[orchestrator] idle 微压缩未执行（ws=${wsId}）: ${r.error}`);
  }
}

/**
 * B2 熔断可见信号：自动压缩链被打闸时，经现有通知通道（通知中心 + toast）
 * 告知人工接管——「黄条」语义的现有形态，不造新 UI。文案走 i18n（en+zh）。
 */
export function signalCompactBreakerTripped(o: OrchestratorHost, wsId: string, reason: CompactBreakerTripReason): void {
  const text =
    reason === 'rapid-refill'
      ? t('自动压缩已熔断：上下文压缩后反复快速回满，已暂停自动压缩，请手动 /compact 或新开会话')
      : t('自动压缩已熔断：连续 {{n}} 次自动压缩失败，已暂停自动压缩，请手动 /compact 或新开会话', {
          n: MAX_CONSECUTIVE_COMPACT_FAILURES
        });
  console.error(`[orchestrator] 自动压缩已熔断（ws=${wsId} reason=${reason}）`);
  o.ctx.notify.push({
    workspaceId: wsId,
    sessionId: `orchestrator:${wsId}`,
    sessionName: t('调度'),
    kind: 'error',
    text: formatNotifyText(t('调度'), text),
    update: true,
    updateKey: `orch-compact-breaker:${wsId}`,
    toast: true
  });
}
