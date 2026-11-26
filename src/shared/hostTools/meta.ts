/**
 * 宿主工具唯一真源（元数据）：id / MCP 名 / 权限档 / 组 / preset。
 * schema：catalog 工具由 capabilities/catalog.getToolDef 投影；bgtasks 内联于此。
 * handler 在 main/agentSession/tools（进程内）与 inbound MCP 分发（stdio/HTTP）两侧投影，禁止在别处再列一份 ID 表。
 * R5 终态：常驻清单（shared/toolDiscovery.ts）即模型全部可用面——工具原生注册直调，
 * 复杂能力域收敛为九个 X.run 单入口（usage 见 ~/.muster/skills/ 对应技能文档），
 * 发现层（tools.search/tools.call）已退役。
 */
import type { GuiToolPermissionClass } from '../guiWorkerPolicy';
import { residentHostToolIds } from '../toolDiscovery';

export type HostToolPresetId = 'gui-full' | 'pty-allowlist' | 'acp-subset';

export type HostToolGroup =
  | 'status'
  | 'communication'
  | 'browser'
  | 'bgtasks'
  | 'observe'
  | 'share'
  | 'memory'
  | 'repl'
  | 'widgets'
  | 'extensions'
  | 'feedback'
  | 'mcp';

export type HostToolSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

/**
 * Worker 调用时的身份绑定（CLI /v1/tool 与 GUI 进程内两侧同一张表，见 main/capabilities/workerBinding.ts）：
 * - actor：注入 __actorSessionId=调用方会话（留言/订阅/事件等，handler 按 actor 判权）；
 * - self：强制 sessionId=调用方会话（只能改自己的状态/名字/合入请求），模型传别的会话 id 无效；
 * - 缺省：不绑定（只读观察类、浏览器等）。
 */
export type HostToolBinding = 'actor' | 'self';

export interface HostToolMeta {
  id: string;
  mcpName: string;
  group: HostToolGroup;
  permissionClass: GuiToolPermissionClass;
  presets: readonly HostToolPresetId[];
  argsHint?: string;
  /** catalog 无名目的 GUI 专属工具（bgtasks.*） */
  schema?: HostToolSchema;
  bind?: HostToolBinding;
}

const ALL_PRESETS: readonly HostToolPresetId[] = ['gui-full', 'pty-allowlist', 'acp-subset'];
/** R2 browser 域 run 化：原 25 工具条目保留（权限档/绑定真源），但 presets 置空＝不投影到任何面 */
const NO_PRESETS: readonly HostToolPresetId[] = [];
const GUI_AND_ACP: readonly HostToolPresetId[] = ['gui-full', 'acp-subset'];
const GUI_ONLY: readonly HostToolPresetId[] = ['gui-full'];
/** Tools shared by direct GUI and terminal Workers, outside the ACP preset. */
const GUI_AND_PTY: readonly HostToolPresetId[] = ['gui-full', 'pty-allowlist'];

function def(
  id: string,
  group: HostToolGroup,
  permissionClass: GuiToolPermissionClass,
  presets: readonly HostToolPresetId[],
  extra?: { argsHint?: string; schema?: HostToolSchema; bind?: HostToolBinding; }
): HostToolMeta {
  return {
    id,
    mcpName: id.replace(/\./g, '_'),
    group,
    permissionClass,
    presets,
    ...extra
  };
}

const SELF = { bind: 'self' } as const;
const ACTOR = { bind: 'actor' } as const;

const STATUS: HostToolMeta[] = [
  def('sessions.setStatus', 'status', 'status', ALL_PRESETS, SELF),
  def('sessions.rename', 'status', 'status', ALL_PRESETS, SELF),
  def('sessions.requestIntegrate', 'status', 'status', ALL_PRESETS, SELF),
  def('sessions.isolate', 'status', 'edit', ALL_PRESETS, SELF),
  def('ui.notify', 'status', 'status', ALL_PRESETS, SELF),
  def('ui.reminders', 'status', 'status', ALL_PRESETS, ACTOR),
  def('ui.suggestReplies', 'status', 'status', ALL_PRESETS, ACTOR)
];

const FEEDBACK: HostToolMeta[] = [
  def('feedback.propose', 'feedback', 'status', ALL_PRESETS, ACTOR),
  def('feedback.history', 'feedback', 'read', ALL_PRESETS, ACTOR),
  def('feedback.assess', 'feedback', 'status', ALL_PRESETS, ACTOR)
];

const OBSERVE: HostToolMeta[] = [
  def('workers.options', 'observe', 'read', ALL_PRESETS, ACTOR),
  def('workers.context', 'observe', 'read', ALL_PRESETS, ACTOR),
  def('turnChanges.trackFiles', 'observe', 'read', GUI_AND_ACP),
  // panel/desktop 域壳（tool-schema-disclosure）：两域各收成 X.run 入口常驻；
  // 原五项保留为内部真源（权限档/绑定），presets 置空不再投影，
  // 参数细节在 ~/.muster/skills/{panel,desktop}/SKILL.md，per-action 校验仍在宿主侧。
  def('panel.run', 'observe', 'read', ALL_PRESETS, ACTOR),
  def('github.run', 'observe', 'read', ALL_PRESETS, ACTOR),
  def('github.repository', 'observe', 'read', NO_PRESETS, ACTOR),
  def('github.list', 'observe', 'read', NO_PRESETS, ACTOR),
  def('github.detail', 'observe', 'read', NO_PRESETS, ACTOR),
  def('github.files', 'observe', 'read', NO_PRESETS, ACTOR),
  def('github.threads', 'observe', 'read', NO_PRESETS, ACTOR),
  def('github.create', 'observe', 'edit', NO_PRESETS, ACTOR),
  def('github.publish', 'observe', 'edit', NO_PRESETS, ACTOR),
  def('desktop.run', 'observe', 'read', ALL_PRESETS, ACTOR),
  def('panel.list', 'observe', 'read', NO_PRESETS, ACTOR),
  ...['panel.open', 'panel.split', 'panel.focus', 'panel.close'].map(id => def(id, 'observe', 'edit', NO_PRESETS, ACTOR)),
  // 桌面读类保持 read；输入/前台/启动是写操作，run 展开后按真实目标判档。
  def('desktop.list', 'observe', 'read', NO_PRESETS, ACTOR),
  def('desktop.look', 'observe', 'read', NO_PRESETS, ACTOR),
  ...['desktop.act', 'desktop.focus', 'desktop.launch'].map(id => def(id, 'observe', 'edit', NO_PRESETS, ACTOR)),
  def('sessions.observe', 'observe', 'read', ALL_PRESETS, { argsHint: 'sessionId? workspaceId? includeArchived? limit? offset?' }),
  def('attachments.convert', 'observe', 'read', ALL_PRESETS, ACTOR),
  def('sessions.search', 'observe', 'read', ALL_PRESETS, {
    argsHint: 'path? commit? q? workspaceId? limit?'
  }),
  def('llm.quota', 'observe', 'read', ALL_PRESETS, {
    argsHint: 'providerId?'
  }),
  def('events.subscribe', 'observe', 'status', ALL_PRESETS, {
    argsHint: 'kinds? sessionId? workspaceId? path? q?',
    ...ACTOR
  }),
  def('events.unsubscribe', 'observe', 'status', ALL_PRESETS, {
    argsHint: 'id',
    ...ACTOR
  }),
  def('events.list', 'observe', 'read', ALL_PRESETS, ACTOR),
  def('events.read', 'observe', 'read', ALL_PRESETS, ACTOR),
  def('events.register', 'observe', 'status', ALL_PRESETS, {
    argsHint: 'id, description, why',
    ...ACTOR
  }),
  def('events.emit', 'observe', 'status', ALL_PRESETS, {
    argsHint: 'id, summary?, data?, paths?',
    ...ACTOR
  })
];

const SHARE: HostToolMeta[] = [
  def('share.set', 'share', 'status', ALL_PRESETS, {
    argsHint: 'text (<=500 chars, empty string = clear)',
    ...ACTOR
  })
];

const COMMUNICATION: HostToolMeta[] = [
  // 派活。进 Worker 工具面是子代理通用化的前提——没有它，Worker 无法派子代理，
  // 「任意 worker 可拉起另一 worker」就不成立。actor 绑定让 CLI/GUI 两侧都拿到
  // 调用链身份（模型目录里看不到 __actorSessionId，调用时由宿主强制注入）。
  def('sessions.create', 'communication', 'edit', ALL_PRESETS, ACTOR),
  def('terminal.create', 'communication', 'edit', ALL_PRESETS, ACTOR),
  def('sessions.setArchived', 'communication', 'edit', ALL_PRESETS, ACTOR),
  def('sessions.message', 'communication', 'status', ALL_PRESETS, ACTOR),
  def('waitFor', 'communication', 'status', ALL_PRESETS, ACTOR),
  def('sessions.readMessages', 'communication', 'read', ALL_PRESETS, {
    argsHint: 'limit? unreadOnly? since?',
    ...ACTOR
  }),

];

const BROWSER_READ = [
  'browser.tabs',
  'browser.snapshot',
  'browser.console',
  'browser.network',
  'browser.downloads',
] as const;

const BROWSER_ACTION = [
  'browser.open',
  'browser.close',
  'browser.activate',
  'browser.navigate',
  'browser.click',
  'browser.fill',
  'browser.selectOption',
  'browser.pressKey',
  'browser.hover',
  'browser.movePointer',
  'browser.scroll',
  'browser.waitFor',
  'browser.screenshot',
  'browser.evaluate',
  'browser.upload',
  'browser.drag',
  'browser.setViewport',
  'browser.dialog',
  'browser.recording',
  'browser.cookies',
  'browser.storage'
] as const;

/**
 * R2 browser 域 run 化（tool-exposure-resident-run-skill-plan §3 R2）：
 * - 各个内部动作条目保留（listHostToolMetas 按 presets.includes 过滤，空 presets 即
 *   不投影到任何面），仍是权限档/身份绑定的真源；handler 保留为内部执行真源。
 * - 模型面只有 `browser.run` 单入口（ALL_PRESETS 三面投影）；action 展开路由在
 *   capabilities/runRouter.ts，权限按真实目标过决策表（policy.ts 先展开后决策）。
 */
const BROWSER: HostToolMeta[] = [
  ...BROWSER_READ.map((id) => def(id, 'browser', 'read', NO_PRESETS)),
  ...BROWSER_ACTION.map((id) => def(id, 'browser', 'browser', NO_PRESETS)),
  def('browser.run', 'browser', 'browser', ALL_PRESETS, { argsHint: 'action, params' })
];

// One worker entry; per-action classes and authenticated session binding remain
// internal so project identity is never supplied by model arguments.
const EXTENSIONS: HostToolMeta[] = [
  ...['extensions.inspect', 'extensions.list', 'extensions.tools'].map(id => def(id, 'extensions', 'read', NO_PRESETS, ACTOR)),
  ...['extensions.bindProject', 'extensions.create', 'extensions.write', 'extensions.removeFile', 'extensions.submit', 'extensions.retryReview'].map(id => def(id, 'extensions', 'edit', NO_PRESETS, ACTOR)),
  def('extensions.invokeTool', 'extensions', 'shell', NO_PRESETS, ACTOR),
  def('extensions.run', 'extensions', 'shell', ALL_PRESETS, ACTOR)
];

const BGTASKS: HostToolMeta[] = [
  def('bgtasks.shell', 'bgtasks', 'shell', GUI_AND_ACP, {
    argsHint: 'command, name?, wake?, wakeOn?, timeoutMs?',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        name: { type: 'string', description: 'Short name (display only)' },
        wake: {
          type: 'boolean',
          description: 'Whether to wake this session automatically after a successful finish (default false). Failures stay silent by default; pass wakeOn to follow up on failures'
        },
        wakeOn: {
          type: 'string',
          enum: ['success', 'fail', 'always'],
          description:
            'When to wake: success=only on success (the default when wake=true) / fail=only on failure / always=either way. Pass fail or always explicitly when failures need follow-up'
        },
        timeoutMs: {
          type: 'number',
          description:
            'Milliseconds to wait for the command to finish (blocks only when passed). Finishing before the timeout returns foreground; timing out (except sleep) auto-converts to background and returns backgrounded; a sleep command that times out is a failure'
        }
      },
      required: ['command']
    }
  }),
  def('bgtasks.wait', 'bgtasks', 'status', GUI_AND_ACP, {
    argsHint: 'delaySec? | at? (HH:mm or ISO), reason',
    schema: {
      type: 'object',
      properties: {
        delaySec: { type: 'number', description: 'Seconds until the wake-up' },
        at: { type: 'string', description: 'Wake-up time ("HH:mm" or ISO datetime; mutually exclusive with delaySec)' },
        reason: { type: 'string', description: 'What to continue with at the wake-up (returned to you verbatim)' }
      },
      required: ['reason']
    }
  }),
  def('bgtasks.list', 'bgtasks', 'read', GUI_AND_ACP, {
    schema: { type: 'object', properties: {} }
  }),
  def('bgtasks.kill', 'bgtasks', 'status', GUI_AND_ACP, {
    argsHint: 'taskId, initiator?',
    schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id returned by bgtasks.list' },
        initiator: {
          type: 'string',
          enum: ['model', 'user'],
          description: 'Who initiated the kill (model=model-initiated / user=user action; default model)'
        }
      },
      required: ['taskId']
    }
  })
];

// Typed memory tools: the host binds workspace authority to the authenticated session.
const MEMORY: HostToolMeta[] = [
  def('memory.journal','memory','edit',ALL_PRESETS,{argsHint:'topic, topicId?, status, problem, points, entryId?, revision?',bind:'actor'}),
  def('memory.journalGet','memory','read',ALL_PRESETS,{argsHint:'date, offset?, maxChars?',bind:'actor'}),
  def('memory.search', 'memory', 'read', ALL_PRESETS, {
    argsHint: 'query, mode?, limit?, offset?', bind:'actor'
  }),
  def('memory.list','memory','read',ALL_PRESETS,{argsHint:'limit?, offset?',bind:'actor'}),
  def('memory.get','memory','read',ALL_PRESETS,{argsHint:'id, namespace?, revision?, section?, offset?, maxChars?',bind:'actor'}),
  def('memory.confirm','memory','edit',GUI_AND_ACP,{argsHint:'id, revision',bind:'actor'}),
  def('memory.note','memory','edit',ALL_PRESETS,{argsHint:'text, searchKeys, environmentKeys?',bind:'actor'}),
  def('memory.correct','memory','edit',ALL_PRESETS,{argsHint:'memoryId, revision, problem, evidence, suggestion?',bind:'actor'}),
  def('memory.correctionStatus','memory','read',ALL_PRESETS,{argsHint:'requestId',bind:'actor'}),
  def('memory.remember','memory','edit',GUI_AND_ACP,{argsHint:'text, searchKeys',bind:'actor'})
];

/** Standing intents（前瞻意图，2026-10-23 用户拍板开放 Worker；与记忆族同口径 GUI+PTY，ACP 暂不） */
const INTENTS: HostToolMeta[] = [
  def('intent', 'memory', 'edit', GUI_AND_PTY, {
    argsHint: 'action(create|list|cancel), description?, triggerKeywords? | eventPredicates?',
    bind: 'actor'
  })
];

// node-repl 持久代码执行（zcode-adopt-batch-d S2.2/T2）：每会话一个 NodeReplSession，
// 跨调用 globalThis；generation 防 ABA；超时/取消重建上下文。权限类 shell（完整 Node 权限）。
const REPL: HostToolMeta[] = [
  def('node_repl.js', 'repl', 'shell', GUI_ONLY, {
    argsHint: 'code, timeoutMs?',
    schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript source to execute. Calls within the same session share global state (globalThis / var / function declarations persist).'
        },
        timeoutMs: {
          type: 'number',
          description:
            'Execution timeout in milliseconds (default 60000, cap 120000). A timeout rebuilds the execution context and clears all existing bindings — the result will say "context rebuilt"; re-initialize your state before continuing.',
        }
      },
      required: ['code']
    }
  })
];

/** 智能界面（生成式部件）：GUI Worker + PTY/Shell API；ACP 暂不开放（与 memory 同口径） */
const WIDGETS: readonly HostToolMeta[] = [
  def('ui.render', 'widgets', 'read', GUI_AND_PTY, SELF),
  def('ui.inspect', 'widgets', 'read', GUI_AND_PTY, SELF)
];

/**
 * MCP 中转两工具（capability-delivery B1）：第三方 server 经宿主中转（mcpHub 唯一出口），
 * 不进引擎原生工具清单。mcp.search 只读发现（含 schema 分页）；mcp.call 是外部工具执行，
 * 走 dynamic 档（默认模式过审批卡、ask/plan 只读门 deny——外部工具执行需用户可见）。
 * 两工具均绑 actor（CLI /v1/tool 缺令牌直接 401，不落到宿主特权）。
 * schema/描述在 shared/mcpRelay.ts；执行在 capabilities/hosts/mcp.ts + agent/mcpProxy.ts。
 */
const MCP: readonly HostToolMeta[] = [
  def('mcp.search', 'mcp', 'read', ALL_PRESETS, {
    argsHint: 'query? server? includeSchema? limit? offset?',
    ...ACTOR
  }),
  def('mcp.call', 'mcp', 'dynamic', ALL_PRESETS, {
    argsHint: 'server, tool, args?',
    ...ACTOR
  })
];

export const HOST_TOOL_METAS: readonly HostToolMeta[] = [
  ...FEEDBACK,
  ...STATUS,
  ...COMMUNICATION,
  ...OBSERVE,
  ...SHARE,
  ...BROWSER,
  ...EXTENSIONS,
  ...BGTASKS,
  ...MEMORY,
  ...INTENTS,
  ...REPL,
  ...WIDGETS,
  ...MCP
];

const BY_ID = new Map(HOST_TOOL_METAS.map((m) => [m.id, m]));

export function getHostToolMeta(id: string): HostToolMeta | undefined {
  return BY_ID.get(id);
}

export function listHostToolMetas(preset: HostToolPresetId): HostToolMeta[] {
  return HOST_TOOL_METAS.filter((m) => m.presets.includes(preset));
}

export function listResidentWorkerToolMetas(preset?: HostToolPresetId): HostToolMeta[] {
  const resident = new Set(residentHostToolIds('worker'));
  return HOST_TOOL_METAS.filter(meta => resident.has(meta.id) &&
    (preset ? meta.presets.includes(preset) : meta.presets.length > 0));
}

export function listHostToolIds(preset: HostToolPresetId): readonly string[] {
  return listHostToolMetas(preset).map((m) => m.id);
}

export function hostToolPermissionClass(id: string): GuiToolPermissionClass | undefined {
  return BY_ID.get(id)?.permissionClass;
}

export function hostToolBinding(id: string): HostToolBinding | undefined {
  return BY_ID.get(id)?.bind;
}

/** 需 actor 身份绑定的工具（CLI 缺令牌直接 401，不落到 host 特权） */
export const HOST_ACTOR_BOUND_TOOL_IDS: readonly string[] = HOST_TOOL_METAS.filter(
  (m) => m.bind === 'actor'
).map((m) => m.id);

export function hostToolMcpName(id: string): string {
  return BY_ID.get(id)?.mcpName ?? id.replace(/\./g, '_');
}

export const HOST_STATUS_TOOL_IDS = STATUS.map((m) => m.id);
export const HOST_COMMUNICATION_TOOL_IDS = COMMUNICATION.map((m) => m.id);
export const HOST_OBSERVE_TOOL_IDS = OBSERVE.map((m) => m.id);
export const HOST_SHARE_TOOL_IDS = SHARE.map((m) => m.id);
export const HOST_BROWSER_READ_TOOLS = [...BROWSER_READ];
export const HOST_BROWSER_ACTION_TOOLS = [...BROWSER_ACTION];
export const BG_TOOL_IDS = BGTASKS.map((m) => m.id);
export const HOST_MEMORY_TOOL_IDS = MEMORY.map((m) => m.id);
export const HOST_REPL_TOOL_IDS = REPL.map((m) => m.id);
export const HOST_WIDGET_TOOL_IDS = WIDGETS.map((m) => m.id);
export const HOST_MCP_TOOL_IDS = MCP.map((m) => m.id);

/** CLI Worker / Shell API 白名单 = pty-allowlist 投影 */
export const PTY_HOST_TOOL_ALLOWLIST = listHostToolIds('pty-allowlist');
