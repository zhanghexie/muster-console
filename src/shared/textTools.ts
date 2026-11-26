/**
 * 划词「文本工具」共享模块：内置功能定义与配置校验
 * （主进程默认配置/落盘归一 与 设置页「恢复内置」共用）。
 */
import type { TextToolFunction, TextToolsConfig } from './types';

/** 内置：翻译（中↔英自动判向）。用户可在设置里改名/改提示词/删除 */
export const DEFAULT_TRANSLATE_FUNCTION: TextToolFunction = {
  id: 'translate',
  name: '翻译',
  prompt:
    '你是翻译引擎。自动检测输入文字的语言：中文翻译成英文，其他语言翻译成简体中文。\n保留专有名词、代码、命令与原有格式，只输出译文，不要任何解释。',
  enabled: true
};

/** 「AI 帮写提示词」的元提示词：由功能默认模型执行，产出 name+prompt JSON */
export const TEXT_TOOL_AI_META_PROMPT = [
  '你是配置助手。根据用户描述，为一个“划词文本处理功能”生成配置。',
  '只输出严格 JSON，不要代码块、不要解释，格式：',
  '{"name":"按钮名(2-6个字，适合做浮条按钮，如：整理成表格)","prompt":"system 提示词，描述如何处理输入文本；必须要求只输出处理结果本身，不要解释"}'
].join('\n');

/** functions 逐条校验（id 去重、name 非空），default 二字段留空即回落全局 */
export function normalizeTextTools(raw: unknown, fallback: TextToolsConfig): TextToolsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return structuredClone(fallback);
  const r = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const functions: TextToolFunction[] = [];
  if (Array.isArray(r.functions)) {
    for (const item of r.functions) {
      if (!item || typeof item !== 'object') continue;
      const f = item as Record<string, unknown>;
      const id = typeof f.id === 'string' ? f.id.trim() : '';
      const name = typeof f.name === 'string' ? f.name.trim() : '';
      const prompt = typeof f.prompt === 'string' ? f.prompt : '';
      // prompt 允许为空（草稿不丢；执行时空提示词会报错提示）
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      const fn: TextToolFunction = { id, name, prompt, enabled: f.enabled !== false };
      // noThinking 缺省=开（尽力关思考）；只持久化显式关闭
      if (f.noThinking === false) fn.noThinking = false;
      if (typeof f.providerId === 'string' && f.providerId.trim()) {
        fn.providerId = f.providerId.trim();
      }
      if (typeof f.modelId === 'string' && f.modelId.trim()) {
        fn.modelId = f.modelId.trim();
      }
      functions.push(fn);
    }
  }
  const out: TextToolsConfig = { functions };
  if (typeof r.defaultProviderId === 'string' && r.defaultProviderId.trim()) {
    out.defaultProviderId = r.defaultProviderId.trim();
  }
  if (typeof r.defaultModelId === 'string' && r.defaultModelId.trim()) {
    out.defaultModelId = r.defaultModelId.trim();
  }
  return out;
}
