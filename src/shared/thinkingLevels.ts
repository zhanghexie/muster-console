/**
 * 产品统一思考档（五档；Pi 引擎七档的子集——minimal/xhigh 不暴露）。
 * 单独成模块保持零依赖（types.ts 带类型再导出；test/*.mjs 转译加载不拖 i18n 链）。
 */
export type GuiThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** 思考档全集（与 GuiThinkingLevel 联动；遍历/校验统一引用，勿再内联字面量数组） */
export const GUI_THINKING_LEVELS: readonly GuiThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

/** 服务商思考映射的最小形状（避免本模块依赖 types.ts 的 LlmProviderConfig） */
export type ThinkingProviderLike = {
  id: string;
  enabled?: boolean;
  thinking?: { levels?: Partial<Record<string, string | null>> };
};

/**
 * 生效服务商是否配置了任一产品档的思考映射（chip 显隐 / available）。
 * 先找 enabled!==false 的同 id，再回落任意同 id（与 GUI Host 原口径一致）。
 */
export function providerThinkingConfigured(
  providers: ReadonlyArray<ThinkingProviderLike>,
  providerId: string
): boolean {
  if (!providerId) return false;
  const prov =
    providers.find((p) => p.id === providerId && p.enabled !== false) ??
    providers.find((p) => p.id === providerId);
  const lv = prov?.thinking?.levels;
  if (!lv) return false;
  return GUI_THINKING_LEVELS.some((k) => {
    const v = lv[k];
    return typeof v === 'string' && !!v.trim();
  });
}

/**
 * 热读生效档：会话/工作区显式档 > 缺省（reasoning 模型 medium，否则 off）。
 * null/undefined = 跟随默认。GUI driver 与调度 pi 会话共用。
 */
export function resolveThinkingLevel(
  sessionLevel: GuiThinkingLevel | null | undefined,
  modelReasoning: boolean
): GuiThinkingLevel {
  return sessionLevel ?? (modelReasoning ? 'medium' : 'off');
}
