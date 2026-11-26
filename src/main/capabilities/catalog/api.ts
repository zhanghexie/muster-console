import { browserToolHelp } from '../../browser/browserHelp';
import { searchToolDirectory, residentHostToolIds, isSchedulerRegisterableTool, type DiscoverableTool } from '../../../shared/toolDiscovery';
/**
 * 目录查询/组元数据/注册面纯函数/白名单（catalog 拆分自原 catalog.ts 2383-2591 行，
 * 实现体原样搬移）：toApiName/fromApiName/getToolDef/getCatalogInfo、
 * catalogSnippetFor/hasNamedParameters、
 * catalogAppendixText/resolveToolCallArgs、WORKER/EXT 白名单。
 */
import type { CapabilityCatalogInfo, CatalogToolInfo } from '../../../shared/types';
import { errorMessage } from '../../../shared/errors';
import { isToolDefHidden, type TurnHiddenTools } from '../../../shared/turnVisibility';
import { PTY_HOST_TOOL_ALLOWLIST, listHostToolIds } from '../../../shared/hostTools';
import { EXTENSION_HOST_TOOLS } from '../../../shared/extension';
import { CONFIRM_NOTE_PARAM_PROPS } from '../../../shared/confirmDialog';
import type { ToolDef } from './types';
import { CATALOG_VERSION, dynamicDefs, dynamicToolEntries } from './types';
import { TOOL_DEFS } from './registry';
import { RUN_TOOL_DOMAINS } from './runTools';
import { APP_SKILL_PATH } from './agentApps';
import { projectHostToolRoster } from '../../../shared/hostToolProjection';
import { schedulerProjectedCatalog, workerPresetProjectedCatalog } from './projectedCatalog';

function exposureFor(def: ToolDef): NonNullable<CatalogToolInfo['exposure']> {
  const domain = RUN_TOOL_DOMAINS.find(item => item.runName === def.name);
  const owner = !domain ? RUN_TOOL_DOMAINS.find(item => item.actions.some(action => action.targetTool === def.name)) : undefined;
  const action = owner?.actions.find(item => item.targetTool === def.name);
  const entry = owner?.runName ?? def.name;
  const scheduler = isSchedulerRegisterableTool(entry) && !(owner?.def.schedulerHidden ?? def.schedulerHidden);
  const workerPresets = (['gui-full', 'acp-subset', 'pty-allowlist'] as const)
    .filter(preset => residentHostToolIds('worker').includes(entry) && listHostToolIds(preset).includes(entry));
  const direct = scheduler || workerPresets.length > 0;
  const appActions = def.name === 'apps.run' ? (def.parameters.properties.action as { enum?: string[] }).enum : undefined;
  return {
    kind: domain || appActions ? 'domain' : owner ? 'action' : direct ? 'direct' : 'internal', scheduler, workerPresets,
    ...(owner ? { entry, action: action!.action, skillPath: owner.skillPath || undefined } : {}),
    ...(domain ? { entry: domain.runName, skillPath: domain.skillPath || undefined, actions: domain.actions.map(item => ({ action: item.action, target: item.targetTool })) } : {}),
    ...(appActions ? { entry: def.name, skillPath: APP_SKILL_PATH, actions: appActions.map(action => ({ action, target: def.name })) } : {})
  };
}

/** Catalog 点名 → OpenAI function 名（不允许含点） */
export function toApiName(dotName: string): string {
  return dotName.replace(/\./g, '_');
}

/** OpenAI function 名 → Catalog 点名 */
export function fromApiName(apiName: string): string {
  const def =
    TOOL_DEFS.find((t) => toApiName(t.name) === apiName) ??
    dynamicDefs().find((t) => toApiName(t.name) === apiName);
  return def ? def.name : apiName;
}

function withDangerousConfirmParams(def: ToolDef): ToolDef {
  if (!def.dangerous) return def;
  return {
    ...def,
    parameters: {
      ...def.parameters,
      properties: { ...def.parameters.properties, ...CONFIRM_NOTE_PARAM_PROPS }
    }
  };
}

export function getToolDef(dotName: string): ToolDef | undefined {
  const raw =
    TOOL_DEFS.find((t) => t.name === dotName) ??
    dynamicDefs().find((t) => t.name === dotName);
  return raw ? withDangerousConfirmParams(raw) : undefined;
}

/** 不注册进调度工具面的静态工具（ToolDef.schedulerHidden）；handler 仍可经 executor 按名调用 */
export const SCHEDULER_HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_DEFS.filter((t) => t.schedulerHidden).map((t) => t.name)
);

export function getCatalogInfo(): CapabilityCatalogInfo {
  const scheduler = schedulerProjectedCatalog();
  const presets = ['gui-full', 'acp-subset', 'pty-allowlist'] as const;
  const worker = presets.map(preset => ({ preset, entries: workerPresetProjectedCatalog(preset, true) }));
  const all = new Map(scheduler.map(entry => [entry.name, entry] as const));
  for (const { entries } of worker) for (const entry of entries) if (!all.has(entry.name)) all.set(entry.name, entry);
  const staticTools: CatalogToolInfo[] = [...all.values()].map(entry => {
    const d = withDangerousConfirmParams(entry.def);
    const schedulerVisible = scheduler.some(item => item.name === entry.name);
    const workerPresets = worker.filter(item => item.entries.some(candidate => candidate.name === entry.name)).map(item => item.preset);
    const domain = RUN_TOOL_DOMAINS.find(item => entry.sources.includes(item.runName));
    const appActions = entry.name === 'host.apps.run' ? (d.parameters.properties.action as { enum?: string[] }).enum : undefined;
    const exposure: NonNullable<CatalogToolInfo['exposure']> = { kind: domain || appActions ? 'domain' : 'direct', scheduler: schedulerVisible, workerPresets,
      ...(domain ? { entry: entry.name, skillPath: domain.skillPath || undefined,
        actions: domain.actions.map(action => ({ action: action.action, target: entry.name })) } : {}),
      ...(appActions ? { entry: entry.name, skillPath: APP_SKILL_PATH,
        actions: appActions.map(action => ({ action, target: entry.name })) } : {}) };
    return { name: entry.name, description: d.description, dangerous: d.dangerous, parameters: d.parameters,
      summary: catalogSnippetFor(d), schedulerVisible, workerVisible: workerPresets.length > 0, exposure,
      extensionVisible: EXTENSION_HOST_TOOLS.includes(entry.name) };
  });
  const dynamic: CatalogToolInfo[] = dynamicToolEntries().map((e) => {
    const d = withDangerousConfirmParams(e.def);
    return {
      name: d.name,
      description: d.description,
      dangerous: d.dangerous,
      parameters: d.parameters,
      source: 'dynamic' as const,
      schedulerVisible: !d.schedulerHidden,
      exposure: exposureFor(d),
      trusted: e.trusted
    };
  });
  return { version: CATALOG_VERSION, tools: [...staticTools, ...dynamic] };
}

/** Available tools 行内动作摘要长度帽（字符），避免重复完整 description。 */
const SNIPPET_PURPOSE_MAX_CHARS = 40;

/**
 * 工具在 pi「Available tools」清单行内的标注：优先 summary，缺省取 description 首句。
 * pi 只在调用方提供 snippet 时才把该工具列进 Available tools（system-prompt.js：
 * 「A tool appears in Available tools only when the caller provides a one-line
 * snippet」），此前传的是 `def.name`（名字:名字纯噪音）。
 */
export function catalogSnippetFor(def: ToolDef): string {
  const raw = def.summary?.trim() || def.description.split(/[。\n]/, 1)[0] || def.name;
  const purpose =
    raw.length > SNIPPET_PURPOSE_MAX_CHARS
      ? `${raw.slice(0, SNIPPET_PURPOSE_MAX_CHARS)}…`
      : raw;
  return purpose;
}

/**
 * A7 注册形态判定：properties 至少 1 项的工具以真实命名参数 schema 注册进 pi
 * （catalog 的 parameters 本就是完整 JSON Schema，pi 校验层显式支持裸 JSON Schema）；
 * 无 properties 的工具（纯无参 list/status 类）保持 arguments_json 泛型兜底。
 */
export function hasNamedParameters(def: ToolDef): boolean {
  return Object.keys(def.parameters?.properties ?? {}).length > 0;
}

/**
 * Catalog appendix for the policy layer: the resident-surface flow sentence plus the
 * current role/turn family index. R5 end state — the resident list is the whole surface:
 * every registered tool is called directly with its schema, nine domains are single run
 * entries, and per-action parameters live in the matching skill; there is no discovery
 * layer to consult.
 */
export function catalogAppendixText(hidden?: TurnHiddenTools): string {
  const visible = residentHostToolIds('scheduler').filter(id => {
    const def = getToolDef(id);
    return !!def && !def.schedulerHidden && (!hidden || !isToolDefHidden(def, hidden));
  });
  const families = projectHostToolRoster(visible).map(entry => entry.name.startsWith('host.') ? entry.name.split('.').slice(0, 2).join('.') : entry.name.split('.')[0]);
  return 'All host tools are resident and registered natively — call them directly by name. Complex and low-frequency domains use host.*.run entries: the run schema enumerates its actions, and per-action parameters plus recipes live in the matching skill under ~/.muster/skills/ (read it before the first call to that domain). Third-party MCP servers are reachable through host.mcp.search / host.mcp.call. Never guess tool names, parameters, or resource identifiers. Available families: ' +
    [...new Set(families)].join(', ') + '. Tools not allowed for the current identity/turn are never registered.';
}

/**
 * A7 工具参数双形态判定（注册面 execute 回调的纯函数）：
 * - 命名参数形态（真实 schema 注册后模型直传字段）：除 arguments_json 外任一键存在
 *   即视为它，此时忽略 arguments_json——pi 校验会放行未知键，防两形态混传时串味；
 * - arguments_json 字符串形态永久兼容（老会话历史/旧习惯不破）；
 * - 两者皆空 → 空参数对象。
 * 返回 discriminated union：arguments_json 非法 JSON 时 ok:false（注册面直接回
 * 错误内容，不走 executor）。args 允许非对象值（如裸数字/数组），executor 侧本就
 * 以 {value: …} 包装承接。
 */
export function resolveToolCallArgs(
  params: Record<string, unknown>
): { ok: true; args: unknown } | { ok: false; error: string } {
  const named: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'arguments_json') named[key] = value;
  }
  if (Object.keys(named).length > 0) return { ok: true, args: named };
  const raw = params.arguments_json;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return { ok: true, args: JSON.parse(raw) };
    } catch (e) {
      return { ok: false, error: `Invalid arguments JSON: ${errorMessage(e)}` };
    }
  }
  return { ok: true, args: {} };
}

/**
 * Worker 经 Shell API `POST /v1/tool` 允许调用的 Catalog 白名单。
 * 投影自 `shared/hostTools` preset `pty-allowlist`（编排类仅调度进程内）。
 * browser.* 对 Worker 开放，无审批门（用户决策 2026-09-07）。
 */
export const WORKER_TOOL_ALLOWLIST: readonly string[] = PTY_HOST_TOOL_ALLOWLIST;

export function isWorkerAllowedTool(dotName: string): boolean {
  const name = dotName.replace(/_/g, '.');
  return WORKER_TOOL_ALLOWLIST.includes(name);
}

/** Internal catalog directory query (R5: diagnostic/test utility — no longer exposed as a tool). */
export function searchHostToolDirectory(tools: readonly DiscoverableTool[], args: Record<string, unknown>) {
  const result = searchToolDirectory(tools, args);
  const name = typeof args.name === 'string' ? args.name.replace(/_/g,'.') : '';
  const help = name.startsWith('browser.') ? browserToolHelp(name) : undefined;
  return help ? { ...(result as Record<string, unknown>), help } : result;
}
