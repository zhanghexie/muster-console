import { t } from './i18n';

export const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const EXTENSION_TOOL_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const EXTENSION_TOOL_MIN_TIMEOUT_SEC = 5;
export const EXTENSION_TOOL_MAX_TIMEOUT_SEC = 300;
export const EXTENSION_TOOL_PROPS_MAX = 64;

/** llm.chat 请求约束 */
export const EXTENSION_LLM_MAX_MESSAGES = 20;
export const EXTENSION_LLM_MAX_MSG_CHARS = 8000;
export const EXTENSION_LLM_MAX_TOTAL_CHARS = 32_000;
export const EXTENSION_LLM_MAX_TOKENS = 8192;
export const EXTENSION_LLM_TIMEOUT_MS = 240_000;
export const EXTENSION_LLM_MIN_TIMEOUT_MS = 5_000;
export const EXTENSION_LLM_MAX_TIMEOUT_MS = 300_000;

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmChatValidation =
  | { ok: true; messages: LlmChatMessage[]; maxTokens: number; temperature: number; timeoutMs: number; thinking?: 'off' | 'light' | 'medium' | 'high' }
  | { ok: false; error: string };

/** llm.chat 参数纯校验（bridge 与单测共用） */
export function validateLlmChatRequest(
  rawMessages: unknown,
  rawOpts?: unknown
): LlmChatValidation {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, error: t('messages 必须是非空数组 [{role, content}]') };
  }
  if (rawMessages.length > EXTENSION_LLM_MAX_MESSAGES) {
    return { ok: false, error: t('消息条数超上限（≤{{n}}）', { n: EXTENSION_LLM_MAX_MESSAGES }) };
  }
  let total = 0;
  const messages: LlmChatMessage[] = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: t('消息项不是对象') };
    const m = raw as Record<string, unknown>;
    const role = m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { ok: false, error: t('消息 role 不合法: {{v}}', { v: JSON.stringify(role) }) };
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      return { ok: false, error: t('消息 content 必须是非空字符串') };
    }
    if (m.content.length > EXTENSION_LLM_MAX_MSG_CHARS) {
      return { ok: false, error: t('单条消息超上限（≤{{n}} 字符）', { n: EXTENSION_LLM_MAX_MSG_CHARS }) };
    }
    total += m.content.length;
    messages.push({ role, content: m.content });
  }
  if (total > EXTENSION_LLM_MAX_TOTAL_CHARS) {
    return { ok: false, error: t('消息总量超上限（≤{{n}} 字符）', { n: EXTENSION_LLM_MAX_TOTAL_CHARS }) };
  }
  let maxTokens = 1024;
  let temperature = 0.3;
  let timeoutMs = EXTENSION_LLM_TIMEOUT_MS;
  let thinking: 'off' | 'light' | 'medium' | 'high' | undefined;
  if (rawOpts != null) {
    if (typeof rawOpts !== 'object') return { ok: false, error: t('opts 不是对象') };
    const o = rawOpts as Record<string, unknown>;
    if (o.maxTokens != null) {
      if (
        typeof o.maxTokens !== 'number' ||
        !Number.isInteger(o.maxTokens) ||
        o.maxTokens < 1 ||
        o.maxTokens > EXTENSION_LLM_MAX_TOKENS
      ) {
        return { ok: false, error: t('maxTokens 必须是 1-{{n}} 的整数', { n: EXTENSION_LLM_MAX_TOKENS }) };
      }
      maxTokens = o.maxTokens;
    }
    if (o.temperature != null) {
      if (typeof o.temperature !== 'number' || o.temperature < 0 || o.temperature > 2) {
        return { ok: false, error: t('temperature 必须在 0-2 之间') };
      }
      temperature = o.temperature;
    }
    if (o.timeoutMs != null) {
      if (
        typeof o.timeoutMs !== 'number' ||
        !Number.isInteger(o.timeoutMs) ||
        o.timeoutMs < EXTENSION_LLM_MIN_TIMEOUT_MS ||
        o.timeoutMs > EXTENSION_LLM_MAX_TIMEOUT_MS
      ) {
        return { ok: false, error: t('timeoutMs 必须是 {{min}}-{{max}} 毫秒的整数', { min: EXTENSION_LLM_MIN_TIMEOUT_MS, max: EXTENSION_LLM_MAX_TIMEOUT_MS }) };
      }
      timeoutMs = o.timeoutMs;
    }
    if (o.thinking != null) {
      if (typeof o.thinking !== 'string' || !['off', 'light', 'medium', 'high'].includes(o.thinking)) return { ok: false, error: t('thinking 必须是 off、light、medium 或 high') };
      thinking = o.thinking as 'off' | 'light' | 'medium' | 'high';
    }
  }
  return { ok: true, messages, maxTokens, temperature, timeoutMs, ...(thinking ? { thinking } : {}) };
}

export interface ExtensionToolDef {
  /** 完整 Catalog 名：`ext.<extId>.<短名>`，短名小写字母开头 */
  name: string;
  description: string;
  /** 危险操作：executor 在常规 dangerous 确认之外语义同内置工具（每次调用走 ui.confirm） */
  dangerous?: boolean;
  /** JSON Schema（object）；校验层强制 additionalProperties:false、键数上限 */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** 扩展目录内的 Node ESM 脚本相对路径；须导出 `export async function execute(args, io)` */
  script: string;
  /** 超时秒数；缺省 60，5-300 */
  timeoutSec?: number;
}

export interface ExtensionBridgeCall {
  id: string;
  method: ExtensionPanelMethod;
  args: unknown[];
}

/**
 * Single source of truth for methods that can cross the extension panel bridge.
 * Keep this list aligned with ExtensionHost.call and reject unknown methods at
 * the IPC boundary before they reach a package-owned surface.
 */
export const EXTENSION_PANEL_METHODS = [
  'tool',
  'ui.confirm',
  'agent.open', 'agent.release', 'agent.history',
  'agent.send',
  'data.read', 'data.write', 'data.list',
  'journal.list', 'journal.read', 'notify',
  'files.pick', 'files.pathAccess',
  'media.import', 'media.url', 'media.retain', 'media.release',
  'exports.thumbnailHtml', 'exports.create', 'exports.preview', 'exports.reveal',
  'models.list', 'models.invoke',
  'llm.chat', 'llm.chatStream', 'llm.chatStream.cancel',
  'commands.execute',
  'storage.get', 'storage.set', 'storage.del', 'storage.keys',
  'domain.snapshot', 'domain.query', 'domain.command',
  'tasks.create', 'tasks.open', 'tasks.preview', 'tasks.thumbnail',
] as const;

export type ExtensionPanelMethod = (typeof EXTENSION_PANEL_METHODS)[number];

export interface ExtensionPanelCallInput {
  token: string;
  method: ExtensionPanelMethod;
  args?: unknown[];
}

export function isExtensionPanelMethod(value: string): value is ExtensionPanelMethod {
  return (EXTENSION_PANEL_METHODS as readonly string[]).includes(value);
}

/** 相对路径安全检查：拒绝绝对路径、盘符、`..`、反斜杠 */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.length > 512) return false;
  if (p.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  if (p.startsWith('/')) return false;
  const parts = p.split('/').filter((x) => x.length > 0);
  if (parts.length === 0) return false;
  return parts.every((x) => x !== '.' && x !== '..');
}

/** Data/cache are excluded from code trust and therefore cannot contain entrypoints. */
function isCodeRelPath(p: string): boolean {
  return isSafeRelPath(p) && !['data', 'cache', '.git'].includes(p.split('/')[0].toLowerCase());
}

export type ToolValidation =
  | { ok: true; tool: ExtensionToolDef }
  | { ok: false; error: string };

/**
 * 动态工具纯校验（无 fs）：name 强制 `ext.<dirName>.<短名>`（防跨扩展冒名）、
 * parameters 必须 object schema 且额外收紧 additionalProperties:false、键数上限。
 */
export function validateExtensionTool(raw: unknown, dirName: string): ToolValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: t('tool 不是对象') };
  }
  const tRaw = raw as Record<string, unknown>;
  const name = typeof tRaw.name === 'string' ? tRaw.name.trim() : '';
  if (!name) return { ok: false, error: t('tool.name 缺失') };
  const prefix = `ext.${dirName}.`;
  if (!name.startsWith(prefix)) {
    return { ok: false, error: t('tool.name 必须以 {{prefix}} 开头（防跨扩展冒名）', { prefix }) };
  }
  const short = name.slice(prefix.length);
  if (!EXTENSION_TOOL_NAME_RE.test(short)) {
    return { ok: false, error: t('tool.name 短名不合法（小写字母开头，字母数字连字符 ≤48）: {{v}}', { v: short }) };
  }
  const description = typeof tRaw.description === 'string' ? tRaw.description.trim() : '';
  if (!description || description.length > 500) {
    return { ok: false, error: t('tool.description 必须为 1-500 字符') };
  }
  const paramsRaw = tRaw.parameters;
  if (!paramsRaw || typeof paramsRaw !== 'object' || Array.isArray(paramsRaw)) {
    return { ok: false, error: t('tool.parameters 不是对象') };
  }
  const p = paramsRaw as Record<string, unknown>;
  if (p.type !== 'object') {
    return { ok: false, error: t('tool.parameters.type 必须为 "object"') };
  }
  const props = (p.properties ?? {}) as Record<string, unknown>;
  if (typeof props !== 'object' || Array.isArray(props)) {
    return { ok: false, error: t('tool.parameters.properties 缺失或不是对象') };
  }
  const keys = Object.keys(props);
  if (keys.length > EXTENSION_TOOL_PROPS_MAX) {
    return { ok: false, error: t('tool.parameters.properties 键数超上限（≤{{n}}）', { n: EXTENSION_TOOL_PROPS_MAX }) };
  }
  for (const k of keys) {
    if (!(props[k] != null && typeof props[k] === 'object' && !Array.isArray(props[k]))) {
      return { ok: false, error: t('parameters.properties.{{k}} 不是对象', { k }) };
    }
  }
  let required: string[] | undefined;
  if (p.required != null) {
    if (!Array.isArray(p.required) || p.required.some((x) => typeof x !== 'string')) {
      return { ok: false, error: t('tool.parameters.required 必须是字符串数组') };
    }
    required = [...new Set(p.required as string[])];
    const missing = required.filter((r) => !keys.includes(r));
    if (missing.length) {
      return { ok: false, error: t('required 引用了未声明的属性: {{list}}', { list: missing.join('、') }) };
    }
  }
  // 额外 schema 校验面统一收口：禁未声明键（防模型编造参数直通脚本）
  const properties = props as Record<string, unknown>;
  const cleanedParameters = {
    type: 'object' as const,
    properties,
    ...(required?.length ? { required } : {}),
    additionalProperties: false
  } as ExtensionToolDef['parameters'];
  let dangerous: boolean | undefined;
  if (tRaw.dangerous != null) {
    if (typeof tRaw.dangerous !== 'boolean') return { ok: false, error: t('tool.dangerous 必须是 boolean') };
    dangerous = tRaw.dangerous;
  }
  const script = typeof tRaw.script === 'string' ? tRaw.script.trim() : '';
  if (!isCodeRelPath(script) || !script.toLowerCase().endsWith('.mjs')) {
    return { ok: false, error: t('tool.script 必须是目录内 .mjs 相对路径: {{v}}', { v: script || t('缺失') }) };
  }
  let timeoutSec: number | undefined;
  if (tRaw.timeoutSec != null) {
    if (
      typeof tRaw.timeoutSec !== 'number' ||
      !Number.isInteger(tRaw.timeoutSec) ||
      tRaw.timeoutSec < EXTENSION_TOOL_MIN_TIMEOUT_SEC ||
      tRaw.timeoutSec > EXTENSION_TOOL_MAX_TIMEOUT_SEC
    ) {
      return {
        ok: false,
        error: t('tool.timeoutSec 必须是 {{min}}-{{max}} 的整数', {
          min: EXTENSION_TOOL_MIN_TIMEOUT_SEC,
          max: EXTENSION_TOOL_MAX_TIMEOUT_SEC
        })
      };
    }
    timeoutSec = tRaw.timeoutSec;
  }
  return {
    ok: true,
    tool: {
      name,
      description,
      ...(dangerous ? { dangerous } : {}),
      parameters: cleanedParameters,
      script,
      ...(timeoutSec ? { timeoutSec } : {})
    }
  };
}
