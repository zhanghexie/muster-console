/**
 * 拉活缺省继承（子代理通用化 · 决策 D7/D8）。
 *
 * 「凡有 parentSessionId 即继承」是**通用语义**，不限于子代理：将来 fork、续作、
 * 模板拉活只要带上父会话，都走同一条解析。因此抽成独立纯函数，而不是在子代理
 * 分支里打补丁——否则 fork 那条路将来会重复实现一遍。
 *
 * 继承字段：harness 类型（runtime）、模型、思考档、权限档（guiMode）。
 * **Pi persona 不继承**（D8）：Pi 模式含「首条消息后锁死」语义，creator 还挂
 * modes.* 工具，子代理套用父的创作/验收模式容易产生意外。
 * ACP uses the same storage field for product identity; its inheritance is
 * resolved alongside adapter and model compatibility in guiInheritMeta.
 *
 * 纯函数、无 IO：父会话缺省时回落调用方给出的全局缺省，行为与改造前一致。
 */
import type { SessionMeta } from './types';

/** 拉活时的缺省解析结果（各字段均已定型，调用方可直接使用）。 */
export interface ResolvedLaunchDefaults {
  runtime: string;
  modelOverride?: SessionMeta['modelOverride'];
  thinkingLevel?: SessionMeta['thinkingLevel'];
  guiMode?: SessionMeta['guiMode'];
}

/** 调用方给出的全局缺省（无父时的既有行为）。 */
export interface GlobalLaunchDefaults {
  runtime: string;
  modelOverride?: SessionMeta['modelOverride'];
  thinkingLevel?: SessionMeta['thinkingLevel'];
  guiMode?: SessionMeta['guiMode'];
}

/** 可从父会话继承的最小形状（测试可传普通对象，不必构造完整 SessionMeta）。 */
export interface InheritableSession {
  configurePermissions?: boolean;
  runtime?: string;
  piModeId?: string;
  modelOverride?: SessionMeta['modelOverride'];
  thinkingLevel?: SessionMeta['thinkingLevel'];
  guiMode?: SessionMeta['guiMode'];
}

/**
 * 解析拉活缺省：显式入参 > 父会话 > 全局缺省。
 *
 * 显式入参一律优先——父显式指定覆盖继承是 D3/D9 的直接推论（「父可覆盖」）。
 * 父会话该字段为空时**不**阻断继承，退到全局缺省（父没设 ≠ 子必须没设）。
 */
export function resolveInheritedDefaults(
  explicit: {
    runtime?: string;
    modelOverride?: SessionMeta['modelOverride'];
    thinkingLevel?: SessionMeta['thinkingLevel'];
    guiMode?: SessionMeta['guiMode'];
  },
  parent: InheritableSession | null | undefined,
  global: GlobalLaunchDefaults
): ResolvedLaunchDefaults {
  const runtime = firstNonEmpty(explicit.runtime, parent?.runtime, global.runtime);
  return {
    runtime,
    modelOverride: explicit.modelOverride ?? (parent?.runtime === runtime ? parent.modelOverride : undefined)
      ?? (global.runtime === runtime ? global.modelOverride : undefined),
    // 思考档：父显式设了就用父的；父未设（undefined）回落全局缺省。
    // SessionMeta.thinkingLevel 已是产品五档（GuiThinkingLevel），引擎内部七档在
    // driver 侧映射，会话层不跨档，无需在此重解析。
    thinkingLevel: explicit.thinkingLevel ?? parent?.thinkingLevel ?? global.thinkingLevel,
    guiMode: explicit.guiMode ?? parent?.guiMode ?? global.guiMode
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
