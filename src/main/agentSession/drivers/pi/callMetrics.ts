/**
 * Pi driver 内部计量状态机（pi-trajectory-plan v3 §4.3）：原 traceMap 的计时逻辑
 * 迁移为 driver 私有状态，不再产出账本事件——只随 turn-complete 携带 summary。
 *
 * 关键语义（与 traceMap 时代一致）：SDK 的 turn_start/turn_end 是**每次 LLM 调用**
 * 一对（工具循环里每调一次模型各一对）；TTFT 取当前调用内首个流事件（text/thinking/
 * toolcall 增量首现——纯工具调用响应没有文本增量，靠 toolcall 打点补盲，这是本迁移
 * 顺手修复的既有缺陷）；retry 取该次调用的 onResponse 响应数 - 1（同 payload 多次
 * 响应 = 重试；pi-ai 观测钩子，无钩子的版本缺省无 retry）。
 *
 * 旁路纪律：所有公开方法吞异常（返回安全值）——计量故障绝不影响模型调用主链路。
 * 纯逻辑、零运行时依赖（test/pi-call-metrics.mjs 单文件转译导入）。
 */
import type {
  GuiHarnessCall,
  GuiHarnessSummary,
  GuiHarnessUsage
} from '../../../../shared/guiWorker';

/** Pi usage 形状（pi-ai Usage：input/output/cacheRead/cacheWrite/reasoning + cost 实算） */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  /** pi-ai 各 API 实现按模型目录价自动实算（USD）；无价模型为 0 */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

/** SDK turn_end 的 AssistantMessage 最小形状（只声明用到的字段） */
interface PiMetricsMessage {
  role?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  /** pi-ai>=1.1：请求起到最终消息的单调时钟时长（含 deferred 语义外的所有实现） */
  durationMs?: number;
}

/** 一次 LLM 调用（turn_start…turn_end）的计时状态 */
interface OpenCall {
  startedAt: number;
  firstChunkAt?: number;
  responses: number;
}

function normalizePiUsage(u: PiUsage | undefined): GuiHarnessUsage | undefined {
  if (!u || (typeof u.input !== 'number' && typeof u.output !== 'number')) return undefined;
  return {
    inputTokens: typeof u.input === 'number' ? u.input : 0,
    outputTokens: typeof u.output === 'number' ? u.output : 0,
    ...(typeof u.cacheRead === 'number' && u.cacheRead > 0 ? { cacheReadTokens: u.cacheRead } : {}),
    ...(typeof u.cacheWrite === 'number' && u.cacheWrite > 0
      ? { cacheWriteTokens: u.cacheWrite }
      : {}),
    ...(typeof u.reasoning === 'number' && u.reasoning > 0
      ? { reasoningTokens: u.reasoning }
      : {}),
    // cost>0 才落：无价模型 calculateCost 出 0，语义是「未知价」不是「免费」
    ...(typeof u.cost?.total === 'number' && u.cost.total > 0 ? { costUsd: u.cost.total } : {})
  };
}

function sumUsage(calls: readonly GuiHarnessCall[]): GuiHarnessUsage | undefined {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let costUsd = 0;
  let any = false;
  for (const c of calls) {
    const u = c.usage;
    if (!u) continue;
    any = true;
    input += u.inputTokens || 0;
    output += u.outputTokens || 0;
    cacheRead += u.cacheReadTokens || 0;
    cacheWrite += u.cacheWriteTokens || 0;
    reasoning += u.reasoningTokens || 0;
    costUsd += u.costUsd || 0;
  }
  if (!any) return undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    ...(costUsd > 0 ? { costUsd } : {})
  };
}

export class PiCallMetrics {
  private turnStartAt: number | null = null;
  private calls: GuiHarnessCall[] = [];
  private call: OpenCall | null = null;

  /** send()：开新回合（未收口的残留状态就地作废） */
  onSend(now: number): void {
    try {
      this.turnStartAt = now;
      this.calls = [];
      this.call = null;
    } catch {
      /* 旁路：吞掉不影响主链路 */
    }
  }

  /** SDK turn_start：一次 LLM 调用开始 */
  onTurnStart(now: number): void {
    try {
      this.call = { startedAt: now, responses: 0 };
    } catch {
      /* 旁路 */
    }
  }

  /** 流式首现打点（当前调用的 TTFT；text/thinking/toolcall 增量均可触发） */
  onChunk(now: number): void {
    try {
      if (this.call && this.call.firstChunkAt === undefined) this.call.firstChunkAt = now;
    } catch {
      /* 旁路 */
    }
  }

  /** pi-ai onResponse：每次真实 HTTP 响应触发；无调用打开时忽略（如压缩请求） */
  onResponse(): void {
    try {
      if (this.call) this.call.responses += 1;
    } catch {
      /* 旁路 */
    }
  }

  /** SDK turn_end：本次调用收口，usage/TTFT/时长/重试/模型累入 calls */
  onTurnEnd(message: PiMetricsMessage | undefined, now: number): void {
    try {
      const call = this.call;
      this.call = null;
      const usage = normalizePiUsage(message?.usage);
      this.calls.push({
        ...(message?.stopReason ? { stopReason: message.stopReason } : {}),
        ...(usage ? { usage } : {}),
        ...(call && call.firstChunkAt !== undefined
          ? { ttftMs: Math.max(0, call.firstChunkAt - call.startedAt) }
          : {}),
        // 原生 durationMs（单调时钟）优先；缺省回落 turn_start→turn_end 事件墙钟
        ...(typeof message?.durationMs === 'number' && message.durationMs >= 0
          ? { durationMs: message.durationMs }
          : call
            ? { durationMs: Math.max(0, now - call.startedAt) }
            : {}),
        ...(call && call.responses > 1 ? { retry: call.responses - 1 } : {}),
        ...(typeof message?.model === 'string' && message.model ? { model: message.model } : {})
      });
    } catch {
      /* 旁路 */
    }
  }

  /**
   * 回合收口：组装 summary（durationMs = 回合墙钟；usage 为各调用累计、model 取末次）。
   * 幂等：收口后状态清空，再调返回 undefined（finalizeTurn 的双重保险）。
   */
  finalize(now: number): GuiHarnessSummary | undefined {
    try {
      if (this.turnStartAt === null) return undefined;
      const durationMs = Math.max(0, now - this.turnStartAt);
      const calls = this.calls;
      this.turnStartAt = null;
      this.calls = [];
      this.call = null;
      const usage = sumUsage(calls);
      let model: string | undefined;
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i]!.model) {
          model = calls[i]!.model;
          break;
        }
      }
      return {
        ...(usage ? { usage } : {}),
        ...(model ? { model } : {}),
        durationMs,
        ...(calls.length ? { calls } : {})
      };
    } catch {
      return undefined;
    }
  }
}
