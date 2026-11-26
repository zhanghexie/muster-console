/**
 * 浏览器回合结束截图证据 · 归属台账与采集决策（纯逻辑，零依赖，可单测）。
 *
 * 语义（任务 D，handoff 2026-10-08）：
 * - Worker（GUI chat / CLI 终端）每个回合内实际调用 browser.* 成功的目标 tab 记入台账；
 * - 回合收口时按会话取走（collect 即清除）→ 对仍存活的 tab 各截一张图归集到证据链；
 * - 只截「本会话本回合记录过的 tab」，绝不截全局 active tab（防误归属另一会话）；
 * - 硬边界：开关关闭 / 目标已关 / 截图失败一律静默跳过，不影响回合收口。
 *
 * 回合键的取舍：GUI 宿主工具执行上下文（GuiToolExecContext）只有 sessionId 没有
 * turnId，CLI /v1/tool 同样只有令牌解析出的 sessionId——因此台账按 sessionId 键，
 * 「回合」由消费时机界定：收口取走即清，下一次记录自然属于新回合（跨回合隔离）。
 * turnId 只是证据条目上的展示元数据（GUI=收口回合 assistant 消息 id，CLI 无）。
 */

/** 单回合最多采集的 tab 数（封顶防失控；先来先得，按首次使用顺序） */
export const TURN_SHOT_MAX_TABS = 8;

/** 一个会话一个回合内累计的浏览器 tab 使用 */
export interface TurnTabUsage {
  /** 实际用过的 tabId（按首次使用顺序，去重） */
  tabIds: string[];
  firstTs: number;
  lastTs: number;
}

/** 单个 tab 的采集决策输入（全部由调用方实地判定，本函数只做纯谓词） */
export interface TurnShotCaptureInput {
  /** evidence.browserShots 开关（收集器内另有同名门，双保险） */
  enabled: boolean;
  /** 目标 tab 仍存活（tab 壳存在 + 活 guest webContents） */
  tabAlive: boolean;
}

/** 采集谓词：开关关闭或目标已关 → 跳过（静默，不报错） */
export function shouldCapture(input: TurnShotCaptureInput): boolean {
  return input.enabled && input.tabAlive;
}

/**
 * 按会话记「本回合用过的 tab」。record 只增不删（close 掉的 tab 记录无害：
 * 收口时 tabAlive 判定会跳过）；collect 取走即清，实现回合边界。
 */
export class TurnTabLedger {
  private turns = new Map<string, TurnTabUsage>();

  /** 记一次成功的 browser.* 工具使用；空参忽略，tab 数封顶 TURN_SHOT_MAX_TABS */
  recordToolUse(sessionId: string, tabId: string, ts: number): void {
    const sid = sessionId.trim();
    const tid = tabId.trim();
    if (!sid || !tid) return;
    let usage = this.turns.get(sid);
    if (!usage) {
      usage = { tabIds: [], firstTs: ts, lastTs: ts };
      this.turns.set(sid, usage);
    }
    usage.lastTs = ts;
    if (!usage.tabIds.includes(tid)) {
      if (usage.tabIds.length >= TURN_SHOT_MAX_TABS) return; // 封顶：丢弃超量 tab
      usage.tabIds.push(tid);
    }
  }

  /** 回合收口取走：返回该会话累计并清除键（无记录返回 null，不建空档） */
  collectTurnTabs(sessionId: string): TurnTabUsage | null {
    const usage = this.turns.get(sessionId.trim()) ?? null;
    if (usage) this.turns.delete(sessionId.trim());
    return usage;
  }

  /** 会话结束时兜底清理（防无收口路径的台账泄漏） */
  clearSession(sessionId: string): void {
    this.turns.delete(sessionId.trim());
  }

  /** 当前在记的会话数（诊断/测试用） */
  size(): number {
    return this.turns.size;
  }
}

/** 进程内单例：记录点（catalogHostTools / shellApi）与消费点（回合收口）共享 */
export const turnTabLedger = new TurnTabLedger();
