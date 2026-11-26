/** 静态工具定义按家族聚合；模型通过统一目录按需发现。 */
import type { ToolDef } from './types';
import { SESSIONS_CORE_TOOL_DEFS } from './sessionsCore';
import { SESSIONS_OPS_TOOL_DEFS } from './sessionsOps';
import { RUNTIMES_TERMINAL_CHAT_TOOL_DEFS } from './runtimesTerminalChat';
import { FACTS_SHARE_EVENTS_TOOL_DEFS } from './factsShareEvents';
import { SERVICES_TOOL_DEFS } from './services';
import { UI_APP_EXTENSIONS_TOOL_DEFS } from './uiAppExtensions';
import { THEMES_TOOL_DEFS } from './themes';
import { BROWSER_TOOL_DEFS } from './browser';
import { RUN_TOOL_DEFS } from './runTools';
import { CLI_RUN_TOOL_DEFS } from './cliRuns';
import { TOOLS_MEMORY_INTENT_TOOL_DEFS } from './toolsMemoryIntent';
import { LLM_GIT_WEB_TOOL_DEFS } from './llmGitWeb';
import { WORKFLOW_TOOL_DEFS } from './workflow';
import { ATTACHMENT_TOOL_DEFS } from './attachments';
import { MCP_TOOL_DEFS } from './mcp';
import { AGENT_APP_TOOL_DEFS } from './agentApps';
import { FEEDBACK_TOOL_DEFS } from './feedback';
import { SESSION_REMINDER_TOOL_DEFS } from './sessionReminders';
import { WORKER_OPTIONS_TOOL_DEFS } from './workerOptions';
import { DESKTOP_TOOL_DEFS } from './desktop';
import { HOST_PANEL_DEFS } from './hostPanel';
import { TURN_CHANGES_TOOL_DEFS } from './turnChanges';
import { GITHUB_TOOL_DEFS } from './github';

/**
 * R3b extensions.run 同名冲突：入口名与域内原工具同名时，聚合里同名原 def 让位给 run
 * 入口信封（模型面只见一个名字、一个 schema）；原 def 由域动作表携带为内部真源，
 * 执行/确认门经 runTools.internalizedRunToolDefOf 取回。其余八域入口名与原工具无碰撞，
 * 过滤为 no-op。按引用判定（RUN_TOOL_DEFS 成员放行，同名外来源 def 剥离）。
 */
const RUN_ENTRY_DEFS = new Set<ToolDef>(RUN_TOOL_DEFS);
const RUN_ENTRY_NAMES = new Set(RUN_TOOL_DEFS.map((def) => def.name));
const withoutInternalizedRunCollisions = (defs: ToolDef[]): ToolDef[] =>
  defs.filter((def) => RUN_ENTRY_DEFS.has(def) || !RUN_ENTRY_NAMES.has(def.name));

export const TOOL_DEFS: ToolDef[] = withoutInternalizedRunCollisions([
  ...TURN_CHANGES_TOOL_DEFS,
  ...HOST_PANEL_DEFS.map(def => ({ ...def, name: def.name.slice('host.'.length) })),
  ...DESKTOP_TOOL_DEFS,
  ...SESSION_REMINDER_TOOL_DEFS,
  ...WORKER_OPTIONS_TOOL_DEFS,
  ...FEEDBACK_TOOL_DEFS,
  ...AGENT_APP_TOOL_DEFS,
  ...MCP_TOOL_DEFS,
  ...SESSIONS_CORE_TOOL_DEFS,
  ...SESSIONS_OPS_TOOL_DEFS,
  ...RUNTIMES_TERMINAL_CHAT_TOOL_DEFS,
  ...FACTS_SHARE_EVENTS_TOOL_DEFS.filter(def => def.name.startsWith('events.')),
  ...FACTS_SHARE_EVENTS_TOOL_DEFS.filter(def => !def.name.startsWith('events.')),
  ...SERVICES_TOOL_DEFS,
  ...UI_APP_EXTENSIONS_TOOL_DEFS,
  ...THEMES_TOOL_DEFS,
  ...BROWSER_TOOL_DEFS,
  ...GITHUB_TOOL_DEFS,
  ...RUN_TOOL_DEFS,
  ...CLI_RUN_TOOL_DEFS,
  ...TOOLS_MEMORY_INTENT_TOOL_DEFS,
  ...WORKFLOW_TOOL_DEFS,
  ...LLM_GIT_WEB_TOOL_DEFS,
  ...ATTACHMENT_TOOL_DEFS,
]);
