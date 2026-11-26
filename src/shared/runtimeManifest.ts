import { normalizeHarnessIntegration, type HarnessIntegration } from './harnessIntegration';

export interface RuntimeManifestChoice {
  value: string;
  label: string;
  args: string[];
}

export interface RuntimeManifestCapabilities {
  model?: boolean;
  modelHint?: string;
  permissions?: RuntimeManifestChoice[];
  modes?: RuntimeManifestChoice[];
  reasoning?: { flag: string; levels: string[] };
  permissionFlags?: Record<string, boolean>;
  modeFlags?: Record<string, boolean>;
}

export interface AcpMcpPermissionMetadata {
  toolNameKey: string;
  requireApprovalKeys?: string[];
}

export interface RuntimeManifest {
  id: string;
  label: string;
  installUrl?: string;
  terminal?: { command: string; args?: string[] };
  chat?: { transport: 'acp'; command: string; args?: string[]; mcpPermissionMetadata?: AcpMcpPermissionMetadata };
  capabilities?: RuntimeManifestCapabilities;
  integrations?: HarnessIntegration;
}

const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const safeText = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const flag = /^--?[a-zA-Z][\w-]*$/;
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Runtime Manifest contains invalid or unknown fields');
  }
  return value as Record<string, unknown>;
}
function flags(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Runtime Manifest flag map');
  const entries = Object.entries(raw);
  if (entries.length > 32 || entries.some(([key, value]) => !flag.test(key) || typeof value !== 'boolean')) throw new Error('Invalid Runtime Manifest flag map');
  return Object.fromEntries(entries);
}

function args(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || !value.every(item => typeof item === 'string' && item.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(item))) {
    throw new Error('Runtime manifest args 无效');
  }
  return [...value];
}

export function normalizeRuntimeManifest(raw: unknown): RuntimeManifest {
  const value = fields(raw, ['id', 'label', 'installUrl', 'terminal', 'chat', 'capabilities', 'integrations']);
  if (typeof value.id !== 'string' || !idPattern.test(value.id) || !safeText(value.label)) throw new Error('Invalid Runtime Manifest id or label');
  const terminal = value.terminal === undefined ? undefined : fields(value.terminal, ['command', 'args']);
  const chat = value.chat === undefined ? undefined : fields(value.chat, ['transport', 'command', 'args', 'mcpPermissionMetadata']);
  if (!terminal && !chat) throw new Error('Runtime manifest 至少需要 terminal 或 chat');
  if (terminal && !safeText(terminal.command, 1024)) throw new Error('Runtime manifest terminal.command 无效');
  if (chat && (chat.transport !== 'acp' || !safeText(chat.command, 1024))) throw new Error('Runtime manifest chat 配置无效');
  const mcpPermissionMetadata = chat?.mcpPermissionMetadata === undefined ? undefined : normalizeMcpPermissionMetadata(chat.mcpPermissionMetadata);
  const capabilities = value.capabilities === undefined ? undefined : fields(value.capabilities, ['model', 'modelHint', 'permissions', 'modes', 'reasoning', 'permissionFlags', 'modeFlags']);
  if (capabilities && (!terminal || (capabilities.model !== undefined && typeof capabilities.model !== 'boolean') ||
    (capabilities.modelHint !== undefined && !safeText(capabilities.modelHint, 128)))) throw new Error('Invalid terminal capability declaration');
  let installUrl: string | undefined;
  if (value.installUrl !== undefined) {
    if (!safeText(value.installUrl, 2048)) throw new Error('Invalid Runtime Manifest installation URL');
    const url = new URL(value.installUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Runtime Manifest installation URL must be a public HTTPS link without credentials or parameters');
    installUrl = url.href;
  }
  const integrations = normalizeHarnessIntegration(value.integrations);
  if (integrations?.mcp && (!terminal || !['config-file', 'unsupported'].includes(integrations.mcp.strategy) ||
      (integrations.mcp.strategy === 'config-file' && integrations.mcp.dialect))) {
    throw new Error('Runtime Manifest only supports declarative terminal MCP configuration files');
  }
  const normalizedCapabilities = capabilities ? {
    ...(capabilities.model === true ? { model: true } : {}),
    ...(safeText(capabilities.modelHint, 128) ? { modelHint: capabilities.modelHint } : {}),
    ...(capabilities.permissions !== undefined ? { permissions: normalizeChoices(capabilities.permissions) } : {}),
    ...(capabilities.modes !== undefined ? { modes: normalizeChoices(capabilities.modes) } : {}),
    ...(capabilities.reasoning !== undefined ? { reasoning: normalizeReasoning(capabilities.reasoning) } : {}),
    ...(capabilities.permissionFlags !== undefined ? { permissionFlags: flags(capabilities.permissionFlags) } : {}),
    ...(capabilities.modeFlags !== undefined ? { modeFlags: flags(capabilities.modeFlags) } : {})
  } : undefined;
  return {
    id: String(value.id), label: String(value.label).trim(),
    ...(installUrl ? { installUrl } : {}),
    ...(terminal ? { terminal: { command: String(terminal.command), args: args(terminal.args) } } : {}),
    ...(chat ? { chat: { transport: 'acp' as const, command: String(chat.command), args: args(chat.args),
      ...(mcpPermissionMetadata ? { mcpPermissionMetadata } : {}) } } : {}),
    ...(normalizedCapabilities && Object.keys(normalizedCapabilities).length ? { capabilities: normalizedCapabilities } : {}),
    ...(integrations ? { integrations } : {})
  };
}

function normalizeMcpPermissionMetadata(input: unknown): AcpMcpPermissionMetadata {
  const value = fields(input, ['toolNameKey', 'requireApprovalKeys']);
  const isKey = (key: unknown): key is string => typeof key === 'string' && /^[\w.-]+\/[\w.-]+$/.test(key) && key.length <= 128;
  const keys = value.requireApprovalKeys;
  if (!isKey(value.toolNameKey) || (keys !== undefined && (!Array.isArray(keys) || keys.length > 16 ||
    keys.some(key => !isKey(key) || key === value.toolNameKey) || new Set(keys).size !== keys.length))) {
    throw new Error('Invalid ACP MCP permission metadata declaration');
  }
  return { toolNameKey: value.toolNameKey, ...(keys ? { requireApprovalKeys: [...keys] } : {}) };
}

function normalizeChoices(raw: unknown): RuntimeManifestChoice[] {
  if (!Array.isArray(raw) || raw.length > 32) throw new Error('Invalid Runtime Manifest choices');
  const seen = new Set<string>();
  return raw.map(item => {
    const value = fields(item, ['value', 'label', 'args']);
    if (!safeText(value.value, 64) || !/^[\w-]+$/.test(value.value) || !safeText(value.label, 128) || seen.has(value.value)) throw new Error('Invalid Runtime Manifest choice');
    seen.add(value.value);
    return { value: value.value, label: value.label, args: args(value.args) };
  });
}

function normalizeReasoning(input: unknown): RuntimeManifestCapabilities['reasoning'] {
  const raw = fields(input, ['flag', 'levels']);
  if (!safeText(raw.flag, 64) || !flag.test(raw.flag) || !Array.isArray(raw.levels) || !raw.levels.length || raw.levels.length > 32 ||
    raw.levels.some(item => !safeText(item, 64) || !/^[\w-]+$/.test(item)) || new Set(raw.levels).size !== raw.levels.length) {
    throw new Error('Invalid Runtime Manifest reasoning declaration');
  }
  return { flag: raw.flag, levels: raw.levels.map(String) };
}
