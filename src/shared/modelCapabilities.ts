/**
 * 模型能力推断（与 piConfigSync / config inferModelDefaults 同源）。
 * 零依赖，renderer-safe。发送链路与入口开关共用，避免「Pi 静默丢图、UI 仍给上传」。
 */
import { t } from './i18n';

/** 旧入口缺少有效模型配置时按模型 ID 推断。Core 发送使用端点目录的解析结果。 */
const MULTIMODAL_ID_RE =
  /mimo-v2\.5|mimo-v2-omni|4o|vision|vl|claude-3|gemini|pixtral|qwen-vl|internvl/i;

export function inferModelSupportsImages(id: string, explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return MULTIMODAL_ID_RE.test(String(id || '').toLowerCase());
}

export function formatModelNoImageInputError(modelName: string): string {
  const name = String(modelName || '').trim() || '?';
  return t('模型 {{name}} 不支持图片输入', { name });
}

/**
 * 发送守卫：带图且当前模型不支持图片输入时拒绝。
 * 无图、或模型（显式 multimodal / id 推断）支持时放行。
 */
export function rejectImagesIfModelLacksSupport(opts: {
  images?: unknown[] | null;
  modelId: string;
  modelName?: string;
  explicitMultimodal?: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (!opts.images?.length) return { ok: true };
  if (inferModelSupportsImages(opts.modelId, opts.explicitMultimodal)) return { ok: true };
  const name = (opts.modelName || opts.modelId).trim() || opts.modelId;
  return { ok: false, error: formatModelNoImageInputError(name) };
}
