/**
 * run 入口装配点（tool-exposure-resident-run-skill-plan §3 R2/R3）：
 * 用 R1 runFactory（本目录 runFactory.ts）从域内 ToolDef 生成 `X.run` 入口定义
 * 并入 catalog 聚合（registry.ts 展开 RUN_TOOL_DEFS）。
 *
 * R2 上线 browser.run；R3b 补齐其余七域（workflow / runtimes / automations / themes /
 * dispatch（runs.* 改名）/ llm / extensions）。八域的原工具保留为内部
 * 执行真源（catalog handler 不动）；browser 旧名已从 preset 投影移除（shared/hostTools
 * meta presets 置空），其余八域是调度侧工具（不在 meta preset 里），经 catalog 聚合对
 * 调度可达（R4 收拢常驻面；R5 退役 tools.call 后 run 入口在 executor 内展开真实目标）。
 * 执行路由在 capabilities/runRouter.ts（GUI/Shell API 入口）+ capabilities/executor.ts（调度面），
 * 权限按真实目标展开过决策表（agentSession/tools/policy.ts）。
 *
 * extensions.run 命名冲突（入口名与域内动词 run 的原工具同名）：聚合里只保留 run 入口
 * 信封（registry.ts 剥同名原 def，模型面不重复暴露）；原 def 由域动作表携带为内部真源，
 * executor 执行解析出的同名目标时经 internalizedRunToolDefOf 取回原 def——dangerous
 * 参数和权限分类因此不丢；extension 包审核发生在发布时。
 */
import type { ToolDef } from './types';
import { SESSIONS_CORE_TOOL_DEFS } from './sessionsCore';
import { SESSIONS_OPS_TOOL_DEFS } from './sessionsOps';
import { CONFIRM_NOTE_PARAM_PROPS } from '../../../shared/confirmDialog';
import { BROWSER_TOOL_DEFS } from './browser';
import { WORKFLOW_TOOL_DEFS } from './workflow';
import { RUNTIMES_TERMINAL_CHAT_TOOL_DEFS } from './runtimesTerminalChat';
import { SERVICES_TOOL_DEFS } from './services';
import { THEMES_TOOL_DEFS } from './themes';
import { CLI_RUN_TOOL_DEFS } from './cliRuns';
import { LLM_GIT_WEB_TOOL_DEFS } from './llmGitWeb';
import { UI_APP_EXTENSIONS_TOOL_DEFS } from './uiAppExtensions';
import { DESKTOP_TOOL_DEFS } from './desktop';
import { HOST_PANEL_DEFS } from './hostPanel';
import { GITHUB_TOOL_DEFS } from './github';
import {
  buildRunToolDomain,
  RUN_TOOL_DOMAIN_SPECS,
  type RunToolDomain,
  type RunToolDomainSpec
} from './runFactory';

function specOf(prefix: string): RunToolDomainSpec {
  const spec = RUN_TOOL_DOMAIN_SPECS.find((item) => item.prefix === prefix);
  if (!spec) throw new Error(`[runTools] no run domain spec for prefix ${prefix}`);
  return spec;
}

/** browser 域按动作使用 read 或 browser 权限档。 */
export const BROWSER_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('browser.'), BROWSER_TOOL_DEFS);

/** R3b 七域：调度侧 run 入口（原工具退为内部真源，handler 不动） */
export const WORKFLOW_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('workflow.'), WORKFLOW_TOOL_DEFS);
export const RUNTIMES_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('runtimes.'), RUNTIMES_TERMINAL_CHAT_TOOL_DEFS);
export const AUTOMATIONS_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('automations.'), SERVICES_TOOL_DEFS);
export const THEMES_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('themes.'), THEMES_TOOL_DEFS);
export const LLM_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('llm.'), LLM_GIT_WEB_TOOL_DEFS);
export const DISPATCH_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('runs.'), CLI_RUN_TOOL_DEFS);
export const EXTENSIONS_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('extensions.'), UI_APP_EXTENSIONS_TOOL_DEFS);
/** panel/desktop：低频域收成域壳，参数细节在对应 SKILL.md（schema 不再常驻）。 */
export const DESKTOP_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('desktop.'), DESKTOP_TOOL_DEFS);
// HOST_PANEL_DEFS 以公开名 host.panel.* 声明（registry 入册时同样剥前缀），run 域按 catalog 内部名装配。
export const PANEL_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(
  specOf('panel.'),
  HOST_PANEL_DEFS.map(def => ({ ...def, name: def.name.slice('host.'.length) }))
);
export const GITHUB_RUN_DOMAIN: RunToolDomain = buildRunToolDomain(specOf('github.'), GITHUB_TOOL_DEFS);

/** Scheduler session management: full discriminated schema stays resident, no skill lookup. */
export const SESSIONS_RUN_DOMAIN: RunToolDomain = buildRunToolDomain({
  prefix: 'sessions.',
  purpose: 'Manage session selection, recovery and configuration.',
  skillPath: '',
  include: ['select', 'recoverInterrupted', 'restartConversation', 'setModel', 'setThinking', 'setOrchestrated', 'setPinned']
}, [...SESSIONS_CORE_TOOL_DEFS, ...SESSIONS_OPS_TOOL_DEFS]);
SESSIONS_RUN_DOMAIN.def.description = 'Manage session selection, recovery and configuration. restartConversation requires safety review; refusal or cancellation makes no change.';
SESSIONS_RUN_DOMAIN.def.parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: SESSIONS_RUN_DOMAIN.actions.map(entry => entry.action) },
    params: {
      type: 'object',
      properties: { sessionId: SESSIONS_RUN_DOMAIN.actions[0].def.parameters.properties.sessionId },
      required: ['sessionId']
    }
  },
  required: ['action', 'params'],
  oneOf: SESSIONS_RUN_DOMAIN.actions.map(({ action, def }) => {
    const { required, ...parameters } = def.parameters;
    return {
      description: def.description,
      properties: {
        action: { enum: [action] },
        params: {
          ...parameters,
          properties: {
            ...Object.fromEntries(Object.entries(def.parameters.properties).filter(([key]) => key !== 'sessionId')),
            ...(def.dangerous ? CONFIRM_NOTE_PARAM_PROPS : {})
          },
          ...((required ?? []).some(key => key !== 'sessionId')
            ? { required: required!.filter(key => key !== 'sessionId') } : {})
        }
      }
    };
  })
};

/** 已装配的 run 域（R2 browser + R3b 七域，八域齐） */
export const RUN_TOOL_DOMAINS: readonly RunToolDomain[] = [
  BROWSER_RUN_DOMAIN,
  WORKFLOW_RUN_DOMAIN,
  RUNTIMES_RUN_DOMAIN,
  AUTOMATIONS_RUN_DOMAIN,
  THEMES_RUN_DOMAIN,
  LLM_RUN_DOMAIN,
  DISPATCH_RUN_DOMAIN,
  EXTENSIONS_RUN_DOMAIN,
  DESKTOP_RUN_DOMAIN,
  PANEL_RUN_DOMAIN,
  GITHUB_RUN_DOMAIN,
  SESSIONS_RUN_DOMAIN
];

/** 生成出的 run 入口 ToolDef；registry 并入 catalog 聚合（原工具仍为内部真源） */
export const RUN_TOOL_DEFS: readonly ToolDef[] = RUN_TOOL_DOMAINS.map((domain) => domain.def);

const DOMAIN_BY_RUN_NAME = new Map(RUN_TOOL_DOMAINS.map((domain) => [domain.runName, domain]));

/**
 * 按入口名查 run 域。接受三种引擎侧形态（点号/下划线/引擎前缀名，policy.ts 同口径）：
 * 点号名 'browser.run'、下划线名 'browser_run'、引擎前缀名 'mcp__muster__browser_run'。
 */
export function runToolDomainOf(name: string): RunToolDomain | undefined {
  const bare = name.includes('__') ? (name.split('__').pop() ?? name) : name;
  return DOMAIN_BY_RUN_NAME.get(bare.replace(/_/g, '.'));
}

export function isRunToolName(name: string): boolean {
  return runToolDomainOf(name) !== undefined;
}

// ---------- extensions.run 同名冲突解法（R3b） ----------

/**
 * 入口名同时是本域动作目标（extensions 域：入口 extensions.run 的 action "run" 解析出的
 * 目标也叫 extensions.run）时，返回该动作携带的原 def。executor 执行解析后的目标按名查
 * getToolDef 会拿到入口信封（dangerous:false、{action,params} schema），丢失权限分类与
 * 真实参数形态——这里按域动作表把原 def 引用交还执行路径。
 */
const INTERNALIZED_RUN_NAME_DEFS: ReadonlyMap<string, ToolDef> = new Map(
  RUN_TOOL_DOMAINS
    .map((domain) => {
      const self = domain.actions.find((action) => action.targetTool === domain.runName);
      return self ? ([domain.runName, self.def] as const) : undefined;
    })
    .filter((entry): entry is readonly [string, ToolDef] => entry !== undefined)
);

/** 与 run 入口同名的内化原 def；无冲突名字返回 undefined */
export function internalizedRunToolDefOf(name: string): ToolDef | undefined {
  return INTERNALIZED_RUN_NAME_DEFS.get(name);
}
