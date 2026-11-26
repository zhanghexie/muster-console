/** Explicit model declarations; unset values retain the legacy image inference. */
export interface AttachmentTools {
  ffmpegPath?: string;
  libreOfficePath?: string;
}

/** A present global object (including {}) overrides legacy model-local paths. */
export function normalizeAttachmentTools(raw: unknown, legacy: unknown[] = []): AttachmentTools {
  const candidates = raw && typeof raw === 'object' ? [raw] : legacy;
  const result: AttachmentTools = {};
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    for (const key of ['ffmpegPath', 'libreOfficePath'] as const) {
      const value = (candidate as Record<string, unknown>)[key];
      if (result[key] === undefined && typeof value === 'string' && value.trim()) result[key] = value.trim();
    }
  }
  return result;
}

export interface AttachmentPolicy {
  nativeAudio?: boolean;
  nativeVideo?: boolean;
  nativeFiles?: boolean;
  allowMixedMedia?: boolean;
  videoTransport?: 'data-url' | 'url-only';
  /** MIME allowlist for native non-image inputs. Empty means protocol defaults. */
  mimeTypes?: string[];
}

export interface AttachmentProcessing {
  maxFileMB?: number;
  maxTextChars?: number;
  videoFrames?: number;
  videoIntervalSeconds?: number;
  autoConvertMB?: number;
  autoPages?: number;
  autoImageMB?: number;
}

export const ATTACHMENT_PROCESSING_FIELDS = [
  ['maxFileMB', '单文件上限（MiB）', 32, 1, 256], ['maxTextChars', '提取文字上限（字符）', 40000, 1000, 200000],
  ['autoConvertMB', '缩减自动预览的文件阈值（MiB）', 10, 1, 256], ['autoPages', '每条消息自动预览页数', 4, 1, 16],
  ['autoImageMB', '页面预览图片总上限（MiB）', 2, 1, 16],
  ['videoFrames', '视频最多抽帧数', 8, 1, 32], ['videoIntervalSeconds', '视频采样间隔（秒）', 10, 1, 600]
] as const;

export function normalizeAttachmentProcessing(raw: unknown, legacy: unknown[] = []): AttachmentProcessing {
  const out: AttachmentProcessing = {};
  for (const value of raw && typeof raw === 'object' ? [raw] : legacy) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    for (const [key, , , min, max] of ATTACHMENT_PROCESSING_FIELDS) {
      if (out[key] === undefined && typeof v[key] === 'number' && Number.isFinite(v[key]))
        out[key] = Math.max(min, Math.min(max, Math.floor(v[key] as number)));
    }
  }
  return out;
}

export function normalizeAttachmentPolicy(raw: unknown): AttachmentPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const out: AttachmentPolicy = {};
  for (const key of ['nativeAudio', 'nativeVideo', 'nativeFiles', 'allowMixedMedia'] as const)
    if (typeof v[key] === 'boolean') out[key] = v[key];
  if (Array.isArray(v.mimeTypes)) out.mimeTypes = v.mimeTypes.filter((x): x is string =>
    typeof x === 'string' && /^[a-z][a-z0-9.+-]*\/(?:[a-z0-9][a-z0-9.+-]*|\*)$/i.test(x)).slice(0, 50);
  if (v.videoTransport === 'data-url' || v.videoTransport === 'url-only') out.videoTransport = v.videoTransport;
  return out;
}

export function nativeAttachmentKind(mime: string, api: string, policy: AttachmentPolicy): 'audio' | 'video' | 'file' | undefined {
  const kind = mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'file';
  if (!(kind === 'audio' ? policy.nativeAudio : kind === 'video' ? policy.nativeVideo : policy.nativeFiles)) return;
  if (policy.mimeTypes?.length && !policy.mimeTypes.some(x => x === mime || x === `${mime.split('/')[0]}/*`)) return;
  if (api === 'google-generative-ai' && (kind !== 'file' || mime === 'application/pdf' || mime.startsWith('text/') || mime === 'application/json')) return kind;
  if (kind === 'file' && ['openai-responses', 'azure-openai-responses', 'openai-completions'].includes(api)) return kind;
  if (kind === 'file' && mime === 'application/pdf' && ['openai-responses', 'azure-openai-responses', 'anthropic-messages'].includes(api)) return kind;
  if (api === 'openai-completions' && kind === 'audio' && ['audio/wav', 'audio/mpeg', 'audio/mp3'].includes(mime)) return kind;
  // video_url is a provider extension, enabled only by explicit model declaration.
  if (api === 'openai-completions' && kind === 'video' && policy.videoTransport === 'data-url') return kind;
  return;
}

/** AI writes are strict; disk normalization above remains tolerant for migration. */
export function mergeModelAttachmentPolicy(raw: unknown, current?: AttachmentPolicy): AttachmentPolicy | undefined {
  if (raw === undefined) return current;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('attachments 必须是模型原生输入能力对象');
  const value = raw as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (['nativeAudio', 'nativeVideo', 'nativeFiles', 'allowMixedMedia'].includes(key)) {
      if (typeof item !== 'boolean') throw new Error(`attachments.${key} 必须是布尔值`);
    } else if (key === 'videoTransport') {
      if (item !== 'url-only' && item !== 'data-url') throw new Error('attachments.videoTransport 必须为 url-only 或 data-url');
    } else if (key === 'mimeTypes') {
      if (!Array.isArray(item) || item.length > 50 || item.some(x => typeof x !== 'string' || !/^[a-z][a-z0-9.+-]*\/(?:[a-z0-9][a-z0-9.+-]*|\*)$/i.test(x)))
        throw new Error('attachments.mimeTypes 必须是有效 MIME 类型数组（最多 50 项）');
    } else throw new Error(`attachments.${key} 不属于模型输入能力；转换预算和工具路径请在模型与输入设置中配置`);
  }
  return { ...current, ...normalizeAttachmentPolicy(raw) };
}
