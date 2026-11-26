import { historicalServiceRuntime } from './retiredServiceRuntimes';
/**
 * 内置 GUI（chat surface）runtime 的能力描述符。
 * Renderer 与创建对话框只读这张表；Host / 渲染主干禁止 `if (runtime === 'pi')` 散落，
 * 唯一允许的具体分支在各自 driver 包与「按 transport 选工具卡」表里。
 * 只依赖 renderer-safe 的 JSON 能力合同；纯逻辑测试用 shared-compile 递归转译。
 */

export type ChatRuntimeId = 'pi' | 'pi-external' | 'omp' | 'claude' | 'muse-gui' | 'zcode-gui' | 'codex-gui' | 'acp';

export interface ChatRuntimeCapabilities {
  modelRequests?: boolean;
  /** Static controls for registered adapters; native model catalogs live in their drivers. */
  modelParameters?: import('./modelParameters').ModelParameterDescriptor[];
  enforcement?: { coverage: 'native+mcp' | 'mcp-only' | 'none'; mode: 'pre-force' | 'hooks' | 'voluntary' | 'observe' | 'none' };
  /** Whether this GUI runtime can accept a user interrupt as a true turn-scoped steer. */
  steer: 'turn-scoped' | 'none';
  /** Directory registration is separate from OS sandbox enforcement. */
  directories: { registration: 'host-policy' | 'sdk' | 'cwd-only'; note: string; };
  /** False means this adapter cannot register workbench tools in the engine. */
  hostToolsAvailable?: boolean;
  /** 工具卡路由标签（工具事件按 transport+toolName 选卡；勿在别处重新声明字符串） */
  transport: 'pi-agent' | 'claude-agent' | 'codex-agent' | 'acp-agent' | 'generic-worker';
  /** 引擎能否接收图片附件（渲染层决定输入框是否给图片入口） */
  images: boolean;
  /** fork 能否以引擎原生消息回放种子（false = transcript 前缀降级） */
  forkSeed: boolean;
  /** 是否注册 bgtasks.shell / wait / list / kill（独立 PTY 后台终端与定时唤醒） */
  bgtasks: boolean;
  /**
   * 切档是否必须拆连接（Host setMode：true 时 busy 中拒绝切档，空闲拆旧连接 resume）。
   * 与 driver.modeSwitchReconnects 必须同值。
   */
  modeSwitchReconnects: boolean;
  /**
   * 会话级模型覆盖（P10）。reconnect=连接快照，idle 拆连 / 运行中下回合重建；
   * unsupported=工具面明确拒绝。与 driver.modelOverridePolicy 同值。
   */
  modelOverridePolicy: 'reconnect' | 'unsupported';
  /**
   * 会话级思考档（P10）。hot=每回合热读；unsupported=拒绝（Cursor 走模型参数）。
   * 与 driver.thinkingPolicy 同值。
   */
  thinkingPolicy: 'hot' | 'unsupported';
  /**
   * 手动上下文压缩（/compact）：引擎 SDK 有空闲期手动压缩入口（pi session.compact）。
   * false=渲染层不列 /compact，Host 侧也明确拒绝。
   */
  manualCompact: boolean;
  /**
   * 阈值自动压缩：transcript 占比超 AppConfig.autoCompact.ratio 时走与 /compact
   * 同一条引擎 compact 链路。false=宿主不自动触发（即便配置开着）。
   * 现仅 pi=true；cursor 等走宿主摘要重播降级属后续立项，不在此能力位。
   */
  autoCompact: boolean;
}

const CLAUDE_CAPABILITIES = {
  steer: 'none',
  directories: { registration: 'sdk', note: 'Claude registers extra writable directories. Its settings govern native approvals and shell access.' },
  transport: 'claude-agent',

  images: true, forkSeed: false, bgtasks: true,
  modeSwitchReconnects: false,
  modelOverridePolicy: 'reconnect', thinkingPolicy: 'unsupported', manualCompact: false, autoCompact: false
} as const satisfies ChatRuntimeCapabilities;

export const CHAT_RUNTIME_CAPABILITIES = {
  pi: {
    modelRequests: true,
    directories: { registration: 'host-policy', note: 'Pi file tools enforce this scope. Pi can read published skills from their registered paths. Shell, Node, and external MCP run outside the file-tool check.' },
    steer: 'turn-scoped',
    transport: 'pi-agent',

    images: true,
    forkSeed: true,
    bgtasks: true,
    modeSwitchReconnects: false,
    modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'hot',
    manualCompact: true,
    autoCompact: true
  },
  'pi-external': {
    steer: 'none',
    directories: { registration: 'cwd-only', note: 'External Pi controls its native tools. Workbench policy covers calls routed through the bridge.' },
    transport: 'pi-agent',

    images: true,
    forkSeed: false,
    bgtasks: true,

    modeSwitchReconnects: false,
    modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'unsupported',
    manualCompact: false,
    autoCompact: false
  },
  omp: {
    steer: 'none',
    directories: { registration: 'cwd-only', note: 'Oh My Pi controls its native tools. Workbench policy covers calls routed through the bridge.' },
    transport: 'pi-agent',

    images: true,
    forkSeed: false,
    bgtasks: true,

    modeSwitchReconnects: false,
    modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'unsupported',
    manualCompact: false,
    autoCompact: false
  },
  claude: CLAUDE_CAPABILITIES,
  'muse-gui': {
    steer: 'none',
    directories: { registration: 'cwd-only', note: 'Muse controls its native permissions. The MCP bridge enforces host tool policy.' },
    transport: 'generic-worker',
    images: true, forkSeed: false, bgtasks: true,
    modeSwitchReconnects: true, modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'unsupported', manualCompact: false, autoCompact: false
  },
  'zcode-gui': {
    steer: 'none',
    directories: { registration: 'cwd-only', note: 'ZCode controls native access. Workbench tools use session MCP.' },
    transport: 'generic-worker',
    images: false, forkSeed: false, bgtasks: true,
    modeSwitchReconnects: true, modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'unsupported', manualCompact: false, autoCompact: false
  },
  'codex-gui': {
    steer: 'none',
    directories: { registration: 'sdk', note: 'Codex applies its configured permission profile and reports its effective filesystem and approval policy.' },
    transport: 'codex-agent',

    images: true,
    forkSeed: false,
    /** B1b（T2.3）：宿主工具经 config.mcp_servers stdio shim + 网关注册（含 bgtasks.shell/wait/list/kill）；spawn 仍仅 Pi */
    bgtasks: true,

    modeSwitchReconnects: false,
    modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'unsupported',
    manualCompact: false,
    autoCompact: false
  },
  acp: {
    steer: 'none',
    directories: { registration: 'cwd-only', note: 'ACP registers cwd. Other roots are references. Start a session in the target root for reliable access.' },
    transport: 'acp-agent',

    images: true,
    forkSeed: false,
    bgtasks: true,

    modeSwitchReconnects: true,
    modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'unsupported',
    manualCompact: false,
    autoCompact: false
  }
} as const satisfies Record<ChatRuntimeId, ChatRuntimeCapabilities>;

function isBuiltinChatRuntimeId(value: string): boolean {
  return (
    value === 'pi' ||
    value === 'pi-external' ||
    value === 'omp' ||
    value === 'claude' ||
    value === 'muse-gui' ||
    value === 'zcode-gui' ||
    value === 'codex-gui' ||
    value === 'acp'
  );
}

export function isChatRuntimeId(value: string): value is ChatRuntimeId {
  return isBuiltinChatRuntimeId(value) || !!historicalServiceRuntime(value);
}

/** Removed historical service runtimes remain readable with conservative capabilities. */
export function getChatCapabilities(id: ChatRuntimeId | string): ChatRuntimeCapabilities {
  const builtin = isBuiltinChatRuntimeId(id) ? CHAT_RUNTIME_CAPABILITIES[id as ChatRuntimeId] : undefined;
  if (builtin) return builtin;
  return {
    ...CHAT_RUNTIME_CAPABILITIES.acp,
    steer: 'none',
    images: false,
    forkSeed: false,
    bgtasks: false,
    manualCompact: false,
    autoCompact: false,
    modelOverridePolicy: 'unsupported',
    thinkingPolicy: 'unsupported'
  };
}
