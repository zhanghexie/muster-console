import { defaultWorkspaceRoot } from './defaultWorkspaceRoot';
// 推荐根常量与纯路径计算独立在 defaultWorkspaceRoot.ts；此处保留再导出，
// 让既有启动链与配置回归测试继续从 config.ts 取同一份真源。
export { DEFAULT_WORKSPACE_FOLDER, RECOMMENDED_WORKSPACE_NAME } from './defaultWorkspaceRoot';
export { defaultWorkspaceRoot };
import { userDataStorage } from './runtimeKernel/storageRootResolver';
import { app } from 'electron';
import { normalizeAttachmentPolicy, normalizeAttachmentTools, normalizeAttachmentProcessing } from '../shared/attachmentPolicy';
import { t } from '../shared/i18n';
import { parseModelParameterProfiles } from '../shared/modelParameters';
import { PI_PUBLIC_BASE_URLS, piProviderPresetId } from '../shared/piCatalog';
import fs from 'node:fs';
import path from 'node:path';
import { defaultWorktreeStorageRoot } from './git/workspaceResolve';
import { randomUUID } from 'node:crypto';
import {
  isAgentRuntimeKey,
  LLM_THINKING_FORMATS,
  type AgentRuntimeKey,
  type AppConfig,
  type BgShellMode,
  type ClaudeConfig,
  type CursorConfig,
  GUI_THINKING_LEVELS,
  type GuiThinkingLevel,
  type LlmConfig,
  type LlmModality,
  type LlmModelConfig,
  type LlmProviderConfig,
  type LlmThinkingFormat,
  type McpConfig,
  type McpServerConfig,
  type OpenAIConfig,
  type RuntimeOverride,
  type TextToolsConfig,
  type WorkspaceInfo
} from '../shared/types';
import { normalizeKeybindingOverrides } from '../shared/keybindings';
import { normalizeSystemShortcuts } from '../shared/systemShortcuts';
import { normalizeAgentRules } from '../shared/agentConduct';
import { DEFAULT_TRANSLATE_FUNCTION, normalizeTextTools } from '../shared/textTools';
import { normalizeNotifyPrefs } from '../shared/notifyDecision';
import { writeJsonAtomicSync } from './atomicJson';
import { syncPiConfigFromApp, getConfiguredModelSyncDefaults } from './agent/piConfigSync';
import { localOllamaUrl } from './agent/coreReasoningCatalog';
import { resolveEffectiveMcp } from '../shared/mcpConfig';
import { migrateRuntimeOverridesToHost } from './migrateRuntimeOverrides';
import { normalizeDisabledAcpAgents } from '../shared/acpAgentSettings';
import { pathKey } from './pathKey';
import {
  normalizePipelineStallMs,
  normalizePipelineSlowTurnMs,
  normalizePipelineStallScanMs
} from '../shared/pipelineStatus';
import { normalizeTurnGateConfig, ORCH_TURN_GATE_DEFAULTS } from '../shared/turnGate';

import { normalizeQuotaWindowMs } from '../shared/llmQuota';
import { normalizeUserAvatar, serializeUserAvatar } from '../shared/userAvatar';
import {
  DEFAULT_FRAME_BACKDROP,
  normalizeFrameBackdrop,
  normalizeFrameBackdropByWorkspace
} from '../shared/frameBackdrop';
import { DEFAULT_UI_FONT, DEFAULT_UI_FONT_SCALE, parseUiFontId, parseUiFontScale } from '../shared/appearanceFonts';
import { hydrateUserAvatar, persistUserAvatarPatch } from './userAvatarFile';
import { setManualGitBashPath } from './shell/profiles';
import { normalizeAutoCompactWithMicro } from '../shared/microcompactPolicy';
import { normalizeMemoryFlushConfig } from '../shared/memoryFlush';
import { normalizeMemoryConsolidationConfig } from '../shared/memoryConsolidation';
import { normalizeGuiTurnRetryConfig } from './agent/turnRetry';
import { normalizeWorkspaceAccentDefault, parseWorkspaceAccentFields } from '../shared/workspaceAccent';
import { normalizeWorkspaceRoots, sourcePathKey } from './workspacePaths';
import { registeredControlRootFor } from '../shared/workspaceRoots';

export { migrateRuntimeOverridesToHost };

const DEFAULT_MCP: McpConfig = {
  enabled: true,
  servers: []
};

const DEFAULT_TEXT_TOOLS: TextToolsConfig = {
  functions: [structuredClone(DEFAULT_TRANSLATE_FUNCTION)]
};

/** Cursor 终端默认参数，不用于 ACP 聊天。 */
export const DEFAULT_CURSOR_EXTRA_ARGS = [
  '--model',
  'auto',
  '-f',
  '--sandbox',
  'disabled',
  '--trust',
  '--approve-mcps'
] as const;

function makeWorkspace(
  root: string,
  id?: string,
  openedAt?: number,
  name?: string,
  avatar?: string
): WorkspaceInfo {
  const resolved = path.resolve(root);
  const base = path.basename(resolved.replace(/[\\/]+$/, ''));
  const ws: WorkspaceInfo = {
    id: id ?? randomUUID(),
    path: resolved,
    name: (name && name.trim()) || base || resolved,
    openedAt: openedAt ?? Date.now()
  };
  if (avatar && avatar.trim()) ws.avatar = avatar.trim();
  return normalizeWorkspaceRoots(ws);
}

/**
 * 仅在已有工作区登记确实引用默认根时创建它：首启是零工作区（config.workspace 只是
 * cwd 投影），不能因为它等于推荐根就凭空建目录；老配置不引用该根时不迁移、也不会多出
 * 空目录。创建失败（同名文件占用、无写权限）直接抛错由启动链明确提示，不静默回退。
 * 已存在目录只校验不清空内容。
 */
export function ensureDefaultWorkspaceRoot(
  config: Pick<AppConfig, 'workspaces'>,
  homeDir?: string
): string {
  const root = defaultWorkspaceRoot(homeDir);
  const used = config.workspaces.some(ws =>
    ws.path === root || ws.controlRoot === root || ws.roots?.some(r => r.path === root));
  if (!used) return root;
  fs.mkdirSync(root, { recursive: true });
  if (!fs.statSync(root).isDirectory()) throw new Error(`default workspace root is not a directory: ${root}`);
  return root;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      // 模型对齐 pi 目录当前 id（不落显式能力：价格/窗口/思考档由目录继承）
      models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'deepseek-flash', name: 'DeepSeek Flash' }
      ],
      enabled: true
    }
  ],
  activeProviderId: 'deepseek',
  activeModelId: 'deepseek-v4-pro'
};

const DEFAULT_CONFIG: AppConfig = {
  openai: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-v4-pro'
  },
  llm: structuredClone(DEFAULT_LLM_CONFIG),
  // 首启不自动创建工作区。桌面用空工作区快照进入首次设置或建区页。
  // workspace 只是默认 cwd 投影（推荐路径），不代表已登记工作区。
  workspace: defaultWorkspaceRoot(),
  workspaces: [],
  activeWorkspaceId: '',
  defaultRuntime: 'pi',
  runtimeOverrides: {
    'cursor-cli': { extraArgs: [...DEFAULT_CURSOR_EXTRA_ARGS] }
  },
  mcp: structuredClone(DEFAULT_MCP),
  mcpByWorkspace: {},
  notify: {},
  dispatcherAppendPrompt: '',
  agentRules: normalizeAgentRules(undefined),
  textTools: structuredClone(DEFAULT_TEXT_TOOLS),
  themeId: 'dark',
  themeByWorkspace: {},
  locale: 'system',
  globalPanelGlow: true,
  frameEffects: true,
  frameBackdrop: { ...DEFAULT_FRAME_BACKDROP },
  frameBackdropByWorkspace: {},
  userAvatar: { kind: 'emoji', value: '🙂' },
  uiFont: DEFAULT_UI_FONT,
  uiFontScale: DEFAULT_UI_FONT_SCALE,
  tasksKeepAwake: true,
  pipeline: {
    stallMs: 15 * 60 * 1000,
    quotaWindowMs: 15 * 60 * 1000,
    slowTurnMs: 10 * 60 * 1000,
    stallScanMs: 2 * 60 * 1000
  },
  turnGate: { ...ORCH_TURN_GATE_DEFAULTS },
  autoCompact: { enabled: true, ratio: 0.8 }
};

function normalizeWorkspaceRegistrations(registrations: WorkspaceInfo[] | undefined): WorkspaceInfo[] {
  const workspaces: WorkspaceInfo[] = [];
  if (Array.isArray(registrations)) {
    for (const raw of registrations) {
      if (!raw || typeof raw !== 'object') continue;
      const p = typeof raw.path === 'string' && raw.path.trim()
        ? raw.path.trim()
        : typeof raw.controlRoot === 'string' && path.isAbsolute(raw.controlRoot) ? raw.controlRoot : '';
      if (!p) continue;
      const id = typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
      const openedAt = typeof raw.openedAt === 'number' ? raw.openedAt : Date.now();
      const name = typeof raw.name === 'string' ? raw.name : undefined;
      const avatar = typeof raw.avatar === 'string' ? raw.avatar : undefined;
      let ws = makeWorkspace(p, id, openedAt, name, avatar);
      // 保留原始登记：离线根不丢；结构损坏也不使整个 config 回退首启默认值。
      const withRoots: WorkspaceInfo = {
        ...ws,
        // makeWorkspace's provisional legacy root must not leak into rooted input.
        ...(raw.roots !== undefined ? { roots: raw.roots } : {}),
        defaultRootId: raw.roots !== undefined ? raw.defaultRootId : ws.defaultRootId,
        controlRoot: raw.roots !== undefined ? raw.controlRoot : ws.controlRoot,
        ...(raw.rootsRevision !== undefined ? { rootsRevision: raw.rootsRevision } : {})
      };
      try { ws = normalizeWorkspaceRoots(withRoots); }
      catch (err) {
        console.error('[config] invalid workspace roots, preserving registration:', id, (err as Error).message);
        ws = { ...withRoots, rootsError: (err as Error).message };
      }
      Object.assign(ws, parseWorkspaceAccentFields(raw as unknown as Record<string, unknown>));
      workspaces.push(ws);
    }
  }
  return workspaces;
}

/** 从旧单 workspace 字段迁移 / 校正 workspaces 与 active */
function normalizeWorkspaces(
  parsed: Partial<AppConfig>,
  fallbackPath: string
): Pick<AppConfig, 'workspace' | 'workspaces' | 'closedWorkspaces' | 'activeWorkspaceId'> {
  const rootHint = typeof parsed.workspace === 'string' && parsed.workspace.trim()
    ? path.resolve(parsed.workspace.trim()) : path.resolve(fallbackPath);
  // 老配置可能只有单 workspace 字段、没有 workspaces 登记数组；显式空数组（含用户把
  // 工作区删空）必须保持为空——新建引导面板靠它判断是否常驻。
  const hadRegistrations = Array.isArray(parsed.workspaces);
  let workspaces = normalizeWorkspaceRegistrations(parsed.workspaces);

  // 管理根不能共享；普通源根可以被不同逻辑工作区引用。
  const seen = new Set<string>();
  workspaces = workspaces.map((w) => {
    const k = sourcePathKey(w.rootsError ? w.path : registeredControlRootFor(w));
    if (seen.has(k)) {
      console.error('[config] duplicate workspace management folder, preserving registration:', w.id);
      return { ...w, rootsError: w.rootsError ?? 'workspace management folder is already used by another workspace' };
    }
    seen.add(k);
    return w;
  });

  if (!hadRegistrations && workspaces.length === 0) {
    workspaces = [makeWorkspace(rootHint)];
  }

  // 有明确逻辑身份时，旧 workspace 投影过期不能产生新的工作区。零工作区时跳过：
  // 否则仅凭 cwd 投影就会重新造出一个默认工作区，引导面板永远出不来。
  if (workspaces.length) {
    const hasActive = workspaces.some((w) => w.id === parsed.activeWorkspaceId);
    if (!hasActive && !workspaces.some((w) => pathKey(w.path) === pathKey(rootHint))) {
      workspaces = [makeWorkspace(rootHint), ...workspaces];
    }
  }

  let activeWorkspaceId =
    typeof parsed.activeWorkspaceId === 'string' ? parsed.activeWorkspaceId : '';
  if (!workspaces.length) {
    activeWorkspaceId = '';
  } else if (!workspaces.some((w) => w.id === activeWorkspaceId)) {
    const byPath = workspaces.find((w) => pathKey(w.path) === pathKey(rootHint));
    activeWorkspaceId = byPath?.id ?? workspaces[0].id;
  }

  const active = workspaces.find((w) => w.id === activeWorkspaceId);
  return {
    workspaces,
    closedWorkspaces: normalizeWorkspaceRegistrations(parsed.closedWorkspaces).filter(closed => !workspaces.some(open => open.id === closed.id)),
    activeWorkspaceId: active?.id ?? '',
    workspace: active?.path ?? rootHint
  };
}

function pickOverrides(
  raw: unknown
): Partial<Record<AgentRuntimeKey, RuntimeOverride>> {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, RuntimeOverride>;
  const out: Partial<Record<AgentRuntimeKey, RuntimeOverride>> = {};
  for (const key of Object.keys(src)) {
    if (!key.trim()) continue;
    const entry = src[key];
    if (!entry || typeof entry !== 'object') continue;
    const extraArgs = Array.isArray(entry.extraArgs)
      ? entry.extraArgs.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : undefined;
    if (extraArgs?.length) out[key] = { extraArgs };
  }
  return out;
}

function normalizeServer(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const name = typeof s.name === 'string' ? s.name.trim() : '';
  if (!name) return null;
  const transport = s.transport === 'http' ? 'http' : 'stdio';
  const env =
    s.env && typeof s.env === 'object' && !Array.isArray(s.env)
      ? Object.fromEntries(
          Object.entries(s.env as Record<string, unknown>).filter(
            (kv): kv is [string, string] => typeof kv[1] === 'string'
          )
        )
      : undefined;
  const headers =
    s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)
      ? Object.fromEntries(
          Object.entries(s.headers as Record<string, unknown>).filter(
            (kv): kv is [string, string] => typeof kv[1] === 'string'
          )
        )
      : undefined;
  const args = Array.isArray(s.args)
    ? s.args.filter((a): a is string => typeof a === 'string')
    : undefined;
  return {
    name,
    enabled: s.enabled !== false,
    transport,
    command: typeof s.command === 'string' ? s.command : undefined,
    args,
    env,
    cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
    url: typeof s.url === 'string' ? s.url : undefined,
    headers,
    ...(Array.isArray(s.targetIds) ? { targetIds: [...new Set(s.targetIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()))] } : {})
  };
}

function normalizeMcp(raw: unknown): McpConfig {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_MCP);
  const m = raw as Record<string, unknown>;
  const servers = Array.isArray(m.servers)
    ? m.servers.map(normalizeServer).filter((s): s is McpServerConfig => !!s)
    : [];
  return {
    enabled: m.enabled !== false,
    servers
  };
}

function normalizeMcpByWorkspace(raw: unknown): Record<string, McpServerConfig[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, McpServerConfig[]> = {};
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!id.trim() || !Array.isArray(list)) continue;
    const servers = list.map(normalizeServer).filter((s): s is McpServerConfig => !!s);
    if (servers.length) out[id] = servers;
  }
  return out;
}

/** 工作区独立主题（workspaceId → themeId）：键值皆非空才保留，主题 id 归一小写 */
function normalizeThemeByWorkspace(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [wsId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!wsId.trim() || typeof v !== 'string' || !v.trim()) continue;
    out[wsId] = v.trim().toLowerCase();
  }
  return out;
}

function redactMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
  return servers.map((s) => ({
    ...s,
    env: maskSecrets(s.env),
    headers: maskSecrets(s.headers)
  }));
}

function maskSecrets(map?: Record<string, string>): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = v ? '***' : '';
  }
  return out;
}

function normalizeModel(raw: unknown): LlmModelConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  if (!id) return null;
  const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : id;
  const contextWindow =
    typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : undefined;
  const maxTokens = typeof m.maxTokens === 'number' && m.maxTokens > 0 ? m.maxTokens : undefined;
  const reasoning = typeof m.reasoning === 'boolean' ? m.reasoning : undefined;
  const multimodal = typeof m.multimodal === 'boolean' ? m.multimodal : undefined;
  const modalities = Array.isArray(m.modalities) ? [...new Set(m.modalities.filter(value => ['text', 'image', 'video', 'asr', 'tts'].includes(String(value))) as LlmModality[])] : undefined;
  return { id, name, contextWindow, maxTokens, reasoning, multimodal,
    ...(multimodal !== undefined && m.multimodalExplicit === true ? { multimodalExplicit: true } : {}),
    ...(modalities?.length ? { modalities } : {}), attachments: normalizeAttachmentPolicy(m.attachments) };
}

function normalizeMediaPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\\') || value.includes('\0')) return undefined;
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) return undefined;
  return path;
}

function normalizeProviderMedia(raw: unknown): LlmProviderConfig['media'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const imagePath = normalizeMediaPath(value.imagePath);
  const ttsPath = normalizeMediaPath(value.ttsPath);
  const asrPath = normalizeMediaPath(value.asrPath);
  let video: { submitPath: string; pollPath: string; resultPath?: string; statusPath?: string } | undefined;
  const rawVideo = value.video;
  if (rawVideo && typeof rawVideo === 'object' && !Array.isArray(rawVideo)) {
    const v = rawVideo as Record<string, unknown>;
    const submitPath = normalizeMediaPath(v.submitPath), pollPath = normalizeMediaPath(v.pollPath), resultPath = normalizeMediaPath(v.resultPath), statusPath = normalizeMediaPath(v.statusPath);
    if (submitPath && pollPath) video = { submitPath, pollPath, ...(resultPath ? { resultPath } : {}), ...(statusPath ? { statusPath } : {}) };
  }
  if (!imagePath && !ttsPath && !asrPath && !video) return undefined;
  return { ...(imagePath ? { imagePath } : {}), ...(ttsPath ? { ttsPath } : {}), ...(asrPath ? { asrPath } : {}), ...(video ? { video } : {}) };
}

/** 思考配置白名单重建：全空（无映射/未勾选/未选方言）时返回 undefined 收掉整个字段 */
function normalizeThinking(raw: unknown): LlmProviderConfig['thinking'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  let levels: Partial<Record<GuiThinkingLevel, string>> | undefined;
  if (t.levels && typeof t.levels === 'object') {
    const src = t.levels as Record<string, unknown>;
    const out: Partial<Record<GuiThinkingLevel, string>> = {};
    let any = false;
    for (const key of GUI_THINKING_LEVELS) {
      const v = src[key];
      if (typeof v === 'string' && v.trim()) {
        out[key] = v.trim();
        any = true;
      }
    }
    if (any) levels = out;
  }
  // false 与未设置等价（UI 勾选才发 effort），归一化掉让「全空收口」判断保持单一口径
  const reasoningEffortField = t.reasoningEffortField === true ? true : undefined;
  const thinkingFormat =
    typeof t.thinkingFormat === 'string' &&
    (LLM_THINKING_FORMATS as readonly string[]).includes(t.thinkingFormat)
      ? (t.thinkingFormat as LlmThinkingFormat)
      : undefined;
  const disableAtOff = t.disableAtOff === true ? true : undefined;
  if (!levels && reasoningEffortField === undefined && !thinkingFormat && !disableAtOff) {
    return undefined;
  }
  return {
    ...(levels ? { levels } : {}),
    ...(reasoningEffortField !== undefined ? { reasoningEffortField } : {}),
    ...(thinkingFormat ? { thinkingFormat } : {}),
    ...(disableAtOff ? { disableAtOff } : {})
  };
}

function normalizeProvider(raw: unknown): LlmProviderConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  if (!id) return null;
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : id;
  const presetId = piProviderPresetId(id);
  const baseUrl = (typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '') ||
    (Object.hasOwn(PI_PUBLIC_BASE_URLS, presetId) ? PI_PUBLIC_BASE_URLS[presetId] : '');
  const apiKey = (typeof p.apiKey === 'string' ? p.apiKey.trim() : '') ||
    (presetId === 'ollama' && (!p.api || p.api === 'openai-completions') && localOllamaUrl(baseUrl) ? 'ollama' : '');
  const enabled = p.enabled !== false;
  const api =
    typeof p.api === 'string' &&
    [
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai',
      'mistral-conversations',
      'azure-openai-responses'
    ].includes(p.api)
      ? (p.api as import('../shared/types').LlmApiProtocol)
      : undefined;
  let models: LlmModelConfig[] = [];
  if (Array.isArray(p.models)) {
    models = p.models.map(normalizeModel).filter((m): m is LlmModelConfig => !!m);
  }
  // An explicitly empty list is meaningful in settings: a newly created provider
  // must wait for the user to choose models from its catalog. Runtime resolution
  // still has a synthetic `default` fallback when a caller tries to use it.
  const thinking = normalizeThinking(p.thinking);
  const rawCompat = p.compat && typeof p.compat === 'object' && !Array.isArray(p.compat)
    ? p.compat as Record<string, unknown> : undefined;
  const compat = typeof rawCompat?.supportsDeveloperRole === 'boolean'
    ? { supportsDeveloperRole: rawCompat.supportsDeveloperRole } : undefined;
  const modalities = Array.isArray(p.modalities) ? [...new Set(p.modalities.filter(value => ['text', 'image', 'video', 'asr', 'tts'].includes(String(value))) as LlmModality[])] : undefined;
  const media = normalizeProviderMedia(p.media);
  return { id, name, baseUrl, apiKey, api, models, enabled, ...(modalities?.length ? { modalities } : {}), ...(media ? { media } : {}), ...(thinking ? { thinking } : {}), ...(compat ? { compat } : {}) };
}

function normalizeLlm(
  parsedLlm: unknown,
  parsedOpenai?: Partial<OpenAIConfig>,
  fallbackLlm?: LlmConfig
): LlmConfig {
  let providers: LlmProviderConfig[] = [];
  let activeProviderId = '';
  let activeModelId = '';

  if (parsedLlm && typeof parsedLlm === 'object') {
    const raw = parsedLlm as Record<string, unknown>;
    if (Array.isArray(raw.providers)) {
      providers = raw.providers.map(normalizeProvider).filter((p): p is LlmProviderConfig => !!p);
    }
    if (typeof raw.activeProviderId === 'string') {
      activeProviderId = raw.activeProviderId.trim();
    }
    if (typeof raw.activeModelId === 'string') {
      activeModelId = raw.activeModelId.trim();
    }
  }

  // 若无有效的 providers，尝试从 fallbackLlm 或 parsedOpenai 迁移
  if (providers.length === 0) {
    if (fallbackLlm?.providers?.length) {
      providers = structuredClone(fallbackLlm.providers);
      activeProviderId = fallbackLlm.activeProviderId;
      activeModelId = fallbackLlm.activeModelId;
    } else {
      const baseUrl = parsedOpenai?.baseUrl?.trim() || DEFAULT_CONFIG.openai.baseUrl;
      const apiKey = parsedOpenai?.apiKey?.trim() || '';
      const model = parsedOpenai?.model?.trim() || DEFAULT_CONFIG.openai.model;
      const isDeepSeek = /deepseek/i.test(baseUrl);
      const isAi = /openai\.com/i.test(baseUrl);
      const provId = isDeepSeek ? 'deepseek' : isAi ? 'openai' : 'custom';
      const provName = isDeepSeek ? 'DeepSeek' : isAi ? 'OpenAI' : '自定义服务商';
      providers = [
        {
          id: provId,
          name: provName,
          baseUrl,
          apiKey,
          models: [{ id: model, name: model }],
          enabled: true
        }
      ];
      activeProviderId = provId;
      activeModelId = model;
    }
  }

  let activeProvider = providers.find((p) => p.id === activeProviderId);
  if (!activeProvider) {
    activeProvider = providers.find((p) => p.enabled) || providers[0];
    activeProviderId = activeProvider.id;
  }

  if (!activeProvider.models.some((m) => m.id === activeModelId)) {
    activeModelId = activeProvider.models[0]?.id || 'default';
  }

  return {
    providers,
    activeProviderId,
    activeModelId
  };
}

/**
 * 解析当前生效 LLM 配置；Key 缺失先从磁盘重载一次（外部直接改 config.json、
 * 内存副本尚是空 Key 的窗口），仍缺则抛统一错误。调度 / GUI pi / 代码索引配置多路共用。
 */
export function resolveLlmConfigWithReload(
  config: { get(): AppConfig; reloadFromDisk(): AppConfig },
  target?: { providerId?: string; modelId?: string }
): { fullConfig: AppConfig; resolved: ReturnType<typeof resolveLlmConfig> } {
  let fullConfig = config.get();
  let resolved = resolveLlmConfig(fullConfig, target);
  if (!resolved.provider.apiKey?.trim()) {
    fullConfig = config.reloadFromDisk();
    resolved = resolveLlmConfig(fullConfig, target);
  }
  if (!resolved.provider.apiKey?.trim()) {
    throw new Error(
      t('服务商「{{name}}」尚未配置 API Key：请在设置 → 大模型设置中填写', { name: resolved.provider.name })
    );
  }
  return { fullConfig, resolved };
}

export function resolveLlmConfig(
  config: AppConfig,
  target?: { providerId?: string; modelId?: string }
): { provider: LlmProviderConfig; model: LlmModelConfig; openai: OpenAIConfig;
  catalogInput?: Pick<LlmModelConfig, 'contextWindow' | 'multimodal'> } {
  const llm = config.llm || DEFAULT_LLM_CONFIG;
  const targetProviderId = target?.providerId?.trim() || llm.activeProviderId;
  let provider = llm.providers.find((p) => p.id === targetProviderId);
  if (!provider) {
    provider = llm.providers.find((p) => p.id === llm.activeProviderId) || llm.providers[0];
  }
  const targetModelId =
    target?.modelId?.trim() ||
    (provider.id === llm.activeProviderId ? llm.activeModelId : provider.models[0]?.id || 'default');
  let model = provider.models.find((m) => m.id === targetModelId);
  if (!model) {
    model = provider.models[0] || { id: targetModelId, name: targetModelId };
  }
  const inferred = getConfiguredModelSyncDefaults(provider, model);
  const resolvedModel: LlmModelConfig = {
    ...model,
    contextWindow: inferred.contextWindow,
    maxTokens: inferred.maxTokens,
    reasoning: inferred.reasoning,
    multimodal: inferred.input.includes('image')
  };
  return {
    provider,
    model: resolvedModel,
    ...(inferred.catalogInput ? { catalogInput: inferred.catalogInput } : {}),
    openai: {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: model.id
    }
  };
}

function normalizeCursor(raw: unknown): CursorConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const apiKey = typeof r.apiKey === 'string' ? r.apiKey : '';
  const def = r.defaultModel;
  let defaultModel: CursorConfig['defaultModel'];
  if (def && typeof def === 'object' && !Array.isArray(def)) {
    const d = def as Record<string, unknown>;
    const id = typeof d.id === 'string' ? d.id.trim() : '';
    if (id) {
      const params = Array.isArray(d.params)
        ? d.params
            .map((p) => {
              if (!p || typeof p !== 'object') return null;
              const row = p as Record<string, unknown>;
              const pid = typeof row.id === 'string' ? row.id : '';
              const value = typeof row.value === 'string' ? row.value : '';
              return pid && value ? { id: pid, value } : null;
            })
            .filter((x): x is { id: string; value: string } => x !== null)
        : undefined;
      defaultModel = params?.length ? { id, params } : { id };
    }
  }
  return {
    apiKey,
    ...(defaultModel ? { defaultModel } : {}),
    ...(r.sandbox === true ? { sandbox: true } : {}),
    ...(r.autoReview === true ? { autoReview: true } : {})
  };
}

function normalizeClaude(raw: unknown): ClaudeConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.isolateConfig !== true) return undefined;
  return { isolateConfig: true };
}

function normalizeConfig(parsed: Partial<AppConfig>, fallbackLlm?: LlmConfig): AppConfig {
  const defaultRuntime = isAgentRuntimeKey(parsed.defaultRuntime)
    ? parsed.defaultRuntime
    : DEFAULT_CONFIG.defaultRuntime;
  const picked = pickOverrides(parsed.runtimeOverrides);
  // 磁盘上显式 `{}` 表示已迁入 registry，勿再合并 DEFAULT 默认 extraArgs
  const runtimeOverrides =
    parsed.runtimeOverrides !== undefined
      ? picked
      : { ...DEFAULT_CONFIG.runtimeOverrides, ...picked };
  const ws = normalizeWorkspaces(parsed, DEFAULT_CONFIG.workspace);
  // 已移除的旧飞书桥及「手动导入外部仓」字段不再读入，
  // 加载时丢弃，避免 update 循环把残留值写回磁盘
  const { gitExtraRepos: _dropLegacy, gitExtraReposByWorkspace: _dropExtras, feishu: _retiredFeishu, ...parsedRest } =
    parsed as Partial<AppConfig> & { gitExtraRepos?: unknown; gitExtraReposByWorkspace?: unknown; feishu?: unknown };

  const llm = normalizeLlm(parsed.llm, parsed.openai, fallbackLlm);
  // Read migration values before model normalization removes machine-local settings.
  const rawProviders = Array.isArray(parsed.llm?.providers) ? parsed.llm.providers : [];
  const rawActive = rawProviders.find(p => p?.id === llm.activeProviderId);
  const legacyAttachments = [
    rawActive?.models?.find(m => m?.id === llm.activeModelId)?.attachments,
    ...rawProviders.flatMap(p => Array.isArray(p?.models) ? p.models.map(m => m?.attachments) : [])
  ];
  let modelParameterProfiles: AppConfig['modelParameterProfiles'];
  try { modelParameterProfiles = parseModelParameterProfiles(parsed.modelParameterProfiles); }
  catch (error) { console.error('[config] invalid model parameter profiles', error); modelParameterProfiles = []; }
  const activeProv = llm.providers.find((p) => p.id === llm.activeProviderId) || llm.providers[0];
  const activeModel =
    activeProv.models.find((m) => m.id === llm.activeModelId) || activeProv.models[0];
  const openai: OpenAIConfig = {
    baseUrl: activeProv.baseUrl,
    apiKey: activeProv.apiKey,
    // Empty provider model lists are valid while the user is choosing candidates;
    // keep the legacy mirror safe with the same fallback used by DEFAULT_CONFIG.
    model: activeModel?.id || 'deepseek-v4-pro'
  };

  return {
    ...DEFAULT_CONFIG,
    ...parsedRest,
    llm,
    openai,
    modelParameterProfiles,
    workerRoutingDefault: parsed.workerRoutingDefault,
    workerRoutingByWorkspace: parsed.workerRoutingByWorkspace,
    workerRoutingWorkspaceRevisions: parsed.workerRoutingWorkspaceRevisions,
    attachmentTools: normalizeAttachmentTools(parsed.attachmentTools, legacyAttachments),
    attachmentProcessing: normalizeAttachmentProcessing(parsed.attachmentProcessing, legacyAttachments),
    defaultRuntime,
    disabledAcpAgents: normalizeDisabledAcpAgents(parsed.disabledAcpAgents),
    runtimeOverrides,
    worktreeStorageRoot: typeof parsed.worktreeStorageRoot === 'string' && path.isAbsolute(parsed.worktreeStorageRoot.trim()) ? path.resolve(parsed.worktreeStorageRoot.trim()) : undefined,
    mcp: normalizeMcp(parsed.mcp),
    mcpByWorkspace: normalizeMcpByWorkspace(parsed.mcpByWorkspace),
    dispatcherAppendPrompt:
      typeof parsed.dispatcherAppendPrompt === 'string' ? parsed.dispatcherAppendPrompt : '',
    agentRules: normalizeAgentRules(parsed.agentRules),
    notify: normalizeNotifyPrefs(parsed.notify),
    journalExitSummaryEnabled: parsed.journalExitSummaryEnabled === true,
    liveThinkingOnly: parsed.liveThinkingOnly !== false,
    showWaitingTips: parsed.showWaitingTips !== false,
    memoryFlush: normalizeMemoryFlushConfig(parsed.memoryFlush),
    memoryConsolidation: normalizeMemoryConsolidationConfig(parsed.memoryConsolidation),
    autoCompact: normalizeAutoCompactWithMicro(parsed.autoCompact),
    guiTurnRetry: normalizeGuiTurnRetryConfig(parsed.guiTurnRetry),
    textTools: normalizeTextTools(parsed.textTools, DEFAULT_TEXT_TOOLS),
    shell: normalizeShell(parsed.shell),
    extensionTrust: normalizeExtensionTrust(parsed.extensionTrust),
    inboundMcpTrust: normalizeInboundMcpTrust(parsed.inboundMcpTrust),
    disabledExtensions: normalizeDisabledExtensions(parsed.disabledExtensions),
    themeId:
      typeof parsed.themeId === 'string' && parsed.themeId.trim()
        ? parsed.themeId.trim().toLowerCase()
        : DEFAULT_CONFIG.themeId,
    themeByWorkspace: normalizeThemeByWorkspace(parsed.themeByWorkspace),
    workspaceAccentDefault: normalizeWorkspaceAccentDefault(parsed.workspaceAccentDefault),
    keybindings: normalizeKeybindingOverrides(parsed.keybindings),
    systemShortcuts: normalizeSystemShortcuts(parsed.systemShortcuts),
    locale:
      parsed.locale === 'zh-CN' || parsed.locale === 'en' || parsed.locale === 'system'
        ? parsed.locale
        : DEFAULT_CONFIG.locale,
    globalPanelGlow: parsed.globalPanelGlow !== false,
    frameEffects: parsed.frameEffects !== false,
    frameBackdrop: normalizeFrameBackdrop(parsed.frameBackdrop),
    frameBackdropByWorkspace: normalizeFrameBackdropByWorkspace(parsed.frameBackdropByWorkspace),
    userAvatar: normalizeUserAvatar(parsed.userAvatar),
    uiFont: parseUiFontId(parsed.uiFont),
    uiFontScale: parseUiFontScale(parsed.uiFontScale),
    tasksKeepAwake: parsed.tasksKeepAwake !== false,
    pipeline: {
      stallMs: normalizePipelineStallMs(parsed.pipeline?.stallMs),
      quotaWindowMs: normalizeQuotaWindowMs(parsed.pipeline?.quotaWindowMs),
      slowTurnMs: normalizePipelineSlowTurnMs(parsed.pipeline?.slowTurnMs),
      stallScanMs: normalizePipelineStallScanMs(parsed.pipeline?.stallScanMs)
    },
    turnGate: normalizeTurnGateConfig(parsed.turnGate),
    cursor: normalizeCursor(parsed.cursor),
    claude: normalizeClaude(parsed.claude),
    ...ws
  };
}

function normalizeInboundMcpTrust(
  raw: unknown
): { fingerprint: string; confirmedAt: number } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as { fingerprint?: unknown; confirmedAt?: unknown };
  if (typeof o.fingerprint !== 'string' || !o.fingerprint.trim()) return undefined;
  const at = typeof o.confirmedAt === 'number' ? o.confirmedAt : 0;
  return { fingerprint: o.fingerprint.trim(), confirmedAt: at };
}

/** 扩展 TOFU 信任哈希：只保留 string→string 两层映射 */
function normalizeExtensionTrust(
  raw: unknown
): Record<string, Record<string, string>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [wsId, byExt] of Object.entries(raw as Record<string, unknown>)) {
    if (!byExt || typeof byExt !== 'object' || Array.isArray(byExt)) continue;
    const inner: Record<string, string> = {};
    for (const [extId, hash] of Object.entries(byExt as Record<string, unknown>)) {
      if (typeof hash === 'string' && hash.trim()) inner[extId] = hash.trim();
    }
    if (Object.keys(inner).length) out[wsId] = inner;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 已禁用扩展：只保留 string→string[] */
function normalizeDisabledExtensions(
  raw: unknown
): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [wsId, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    const list = ids.filter((x): x is string => typeof x === 'string' && !!x.trim());
    if (list.length) out[wsId] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Shell 环境：手工 Git Bash 路径（空串=清除，走自动探测）+ 后台命令 Shell 档位（'auto' 缺省不入盘） */
function normalizeShell(
  raw: unknown
): { manualGitBashPath?: string; bgShellMode?: BgShellMode } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const p = typeof r.manualGitBashPath === 'string' ? r.manualGitBashPath.trim() : '';
  const mode = r.bgShellMode === 'powershell' ? 'powershell' : undefined;
  const out: { manualGitBashPath?: string; bgShellMode?: BgShellMode } = {};
  if (p) out.manualGitBashPath = p;
  if (mode) out.bgShellMode = mode;
  return Object.keys(out).length ? out : undefined;
}

/** 划词文本工具配置归一见 shared/textTools.ts（normalizeTextTools） */

type WorkerRoutingConfigPatch = Pick<AppConfig, 'workerRoutingDefault' | 'workerRoutingByWorkspace' | 'workerRoutingWorkspaceRevisions'>;

export class ConfigManager {
  private configPath: string;
  private config: AppConfig;
  private readonly changeListeners = new Set<() => void>();

  onChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) {
      try { listener(); } catch (error) { console.error('[config] change listener failed', error); }
    }
  }

  constructor() {
    this.configPath = userDataStorage(app.getPath('userData')).file('config');
    this.config = this.load();
    this.applyShellEnv();
  }

  private load(): AppConfig {
    try {
      // PowerShell Set-Content 等可能写入 UTF-8 BOM，导致 JSON.parse 失败并回退空 Key
      const raw = fs.readFileSync(this.configPath, 'utf-8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return this.withHydratedAvatar(normalizeConfig(parsed));
    } catch (e) {
      const err = e as Error & { code?: string };
      // 真实损坏（非首启缺文件）必须保留现场：.bad 副本 + 显式诊断。否则后续 save() 会把
      // 默认空 Key 全量落盘固化，机密永久丢失且无从恢复（审计 X3-F01）。
      if (err.code !== 'ENOENT') {
        try {
          const backup = `${this.configPath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bad`;
          fs.copyFileSync(this.configPath, backup);
          console.error(`[config] 配置文件损坏，已保留现场副本 ${backup}；找回 API Key 请先从该副本人工恢复再改设置。原始错误：${err.message}`);
        } catch (copyErr) {
          console.error('[config] 配置文件损坏且现场副本保留失败，请立即停止修改设置并检查磁盘。原始错误：', err.message, copyErr);
        }
      }
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  /** 从磁盘重新加载（修复外部改 config 或启动时 BOM 回退后的空 Key） */
  reloadFromDisk(): AppConfig {
    this.config = this.load();
    this.applyShellEnv();
    this.notifyChanged();
    return this.config;
  }

  get(): AppConfig {
    return { ...this.config, worktreeStorageRoot: this.config.worktreeStorageRoot || defaultWorktreeStorageRoot() };
  }

  /** 给 Agent 工具用：隐去 apiKey / MCP 密钥 */
  getRedacted(): AppConfig {
    const c = structuredClone(this.config);
    // The model-facing choice tool projects only the calling workspace's effective routing.
    delete c.workerRoutingDefault;
    delete c.workerRoutingByWorkspace;
    delete c.workerRoutingWorkspaceRevisions;
    c.openai.apiKey = c.openai.apiKey ? '***configured***' : '';
    if (c.llm) {
      c.llm.providers = c.llm.providers.map((p) => ({
        ...p,
        apiKey: p.apiKey ? '***configured***' : ''
      }));
    }
    c.mcp = {
      enabled: c.mcp.enabled,
      servers: redactMcpServers(c.mcp.servers)
    };
    const wsMcp: Record<string, McpServerConfig[]> = {};
    for (const [id, list] of Object.entries(c.mcpByWorkspace ?? {})) {
      wsMcp[id] = redactMcpServers(list);
    }
    c.mcpByWorkspace = wsMcp;
    if (c.cursor?.apiKey) c.cursor = { ...c.cursor, apiKey: '***configured***' };
    return c;
  }

  /** 用户级 + 指定工作区级合并后的 MCP（同名工作区覆盖） */
  effectiveMcp(workspaceId?: string, targetId?: string): McpConfig {
    const id = workspaceId?.trim() || this.config.activeWorkspaceId;
    const effective = resolveEffectiveMcp(this.config.mcp, this.config.mcpByWorkspace?.[id]);
    return targetId ? { ...effective, servers: effective.servers.filter(server =>
      server.targetIds === undefined || server.targetIds.includes(targetId)) } : effective;
  }

  update(patch: Partial<AppConfig>): AppConfig {
    if (patch.modelParameterProfiles !== undefined) parseModelParameterProfiles(patch.modelParameterProfiles);
    if (patch.worktreeStorageRoot?.trim() && !path.isAbsolute(patch.worktreeStorageRoot.trim())) {
      throw new Error(t('worktree 存储目录必须是绝对路径'));
    }
    if (patch.userAvatar !== undefined) {
      patch = {
        ...patch,
        userAvatar: persistUserAvatarPatch(path.dirname(this.configPath), patch.userAvatar)
      };
    }
    const prevOpenai = JSON.stringify(this.config.openai);
    const prevLlm = JSON.stringify(this.config.llm);
    const mergedOverrides =
      patch.runtimeOverrides !== undefined
        ? Object.keys(patch.runtimeOverrides).length === 0
          ? {}
          : { ...this.config.runtimeOverrides, ...patch.runtimeOverrides }
        : this.config.runtimeOverrides;

    let patchLlm = patch.llm;
    if (!patchLlm && patch.openai) {
      const curLlm = structuredClone(this.config.llm ?? DEFAULT_LLM_CONFIG);
      const activeP = curLlm.providers.find((p) => p.id === curLlm.activeProviderId);
      if (activeP) {
        if (patch.openai.baseUrl !== undefined) activeP.baseUrl = patch.openai.baseUrl;
        if (patch.openai.apiKey !== undefined) activeP.apiKey = patch.openai.apiKey;
        if (patch.openai.model !== undefined && patch.openai.model.trim()) {
          const mId = patch.openai.model.trim();
          curLlm.activeModelId = mId;
          if (!activeP.models.some((m) => m.id === mId)) {
            activeP.models.push({ id: mId, name: mId });
          }
        }
      }
      patchLlm = curLlm;
    }

    const normalized = normalizeConfig(
      {
        ...this.config,
        ...patch,
        llm: patchLlm !== undefined ? patchLlm : this.config.llm,
        runtimeOverrides: mergedOverrides,
        mcp: patch.mcp !== undefined ? patch.mcp : this.config.mcp,
        mcpByWorkspace:
          patch.mcpByWorkspace !== undefined ? patch.mcpByWorkspace : this.config.mcpByWorkspace
      },
      this.config.llm
    );
    // 版本由宿主递增；旧请求不能通过回传一个任意 revision 伪装成当前快照。
    normalized.workspaces = normalized.workspaces.map((next) => {
      const prev = this.config.workspaces.find((w) => w.id === next.id) ?? this.config.closedWorkspaces?.find(w => w.id === next.id);
      if (!prev) return { ...next, rootsRevision: 0 };
      const signature = (w: WorkspaceInfo): string => JSON.stringify([w.roots, w.defaultRootId, w.controlRoot, w.rootsError]);
      const revision = prev.rootsRevision ?? 0;
      return { ...next, rootsRevision: revision + (signature(prev) === signature(next) ? 0 : 1) };
    });
    this.config = normalized;
    this.save();
    this.applyShellEnv();
    const openaiChanged = prevOpenai !== JSON.stringify(this.config.openai);
    const llmChanged = prevLlm !== JSON.stringify(this.config.llm);
    if (openaiChanged || llmChanged) {
      try {
        if (this.config.openai.apiKey || this.config.llm?.providers.some((p) => p.apiKey)) {
          syncPiConfigFromApp(this.config, userDataStorage(app.getPath('userData')).resolve('app', 'muster-core'));
        }
      } catch (e) {
        console.error('[config] sync Pi failed', e);
      }
    }
    this.notifyChanged();
    return this.config;
  }

  /** Publish routing only after the same config snapshot has been written successfully. */
  updateWorkerRouting(patch: WorkerRoutingConfigPatch): void {
    const next = { ...this.config, ...patch };
    this.save(next);
    this.config = next;
    this.notifyChanged();
  }

  private save(routing: WorkerRoutingConfigPatch = this.config): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const payload: AppConfig = {
      attachmentTools: this.config.attachmentTools,
      attachmentProcessing: this.config.attachmentProcessing,
      workerRoutingDefault: routing.workerRoutingDefault,
      workerRoutingByWorkspace: routing.workerRoutingByWorkspace,
      workerRoutingWorkspaceRevisions: routing.workerRoutingWorkspaceRevisions,
      modelParameterProfiles: this.config.modelParameterProfiles,
      openai: this.config.openai,
      llm: this.config.llm,
      workspace: this.config.workspace,
      workspaces: this.config.workspaces,
      closedWorkspaces: this.config.closedWorkspaces,
      activeWorkspaceId: this.config.activeWorkspaceId,
      worktreeStorageRoot: this.config.worktreeStorageRoot,
      defaultRuntime: this.config.defaultRuntime,
      runtimeOverrides: this.config.runtimeOverrides,
      mcp: this.config.mcp,
      mcpByWorkspace: this.config.mcpByWorkspace,
      notify: this.config.notify,
      dispatcherAppendPrompt: this.config.dispatcherAppendPrompt ?? '',
      agentRules: normalizeAgentRules(this.config.agentRules),
      textTools: this.config.textTools,
      extensionTrust: this.config.extensionTrust,
      disabledExtensions: this.config.disabledExtensions,
      themeId: this.config.themeId,
      themeByWorkspace: this.config.themeByWorkspace,
      workspaceAccentDefault: this.config.workspaceAccentDefault,
      keybindings: this.config.keybindings,
      systemShortcuts: this.config.systemShortcuts,
      locale: this.config.locale,
      shell: this.config.shell,
      uiFont: this.config.uiFont,
      uiFontScale: this.config.uiFontScale,
      globalPanelGlow: this.config.globalPanelGlow,
      frameEffects: this.config.frameEffects,
      frameBackdrop: this.config.frameBackdrop,
      frameBackdropByWorkspace: this.config.frameBackdropByWorkspace,
      browser: this.config.browser,
      userAvatar: serializeUserAvatar(this.config.userAvatar),
      cursor: this.config.cursor,
      claude: this.config.claude,
      externalPi: this.config.externalPi,
      externalHarness: this.config.externalHarness,
      disabledAcpAgents: this.config.disabledAcpAgents,
      liveThinkingOnly: this.config.liveThinkingOnly,
      showWaitingTips: this.config.showWaitingTips,
      tasksKeepAwake: this.config.tasksKeepAwake
    };
    writeJsonAtomicSync(this.configPath, payload);
  }

  get filePath(): string {
    return this.configPath;
  }

  /** 手工 Git Bash 路径 → 探测层（变化时作废缓存；空=清除回落自动探测） */
  private applyShellEnv(): void {
    setManualGitBashPath(this.config.shell?.manualGitBashPath ?? null);
  }

  private withHydratedAvatar(cfg: AppConfig): AppConfig {
    return {
      ...cfg,
      userAvatar: hydrateUserAvatar(path.dirname(this.configPath), cfg.userAvatar)
    };
  }
}
