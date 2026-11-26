/**
 * R1 run 路由基建（docs/plans/tool-exposure-resident-run-skill-plan.md §3 R1）：
 * 从域内工具元数据自动生成 `X.run` 入口定义的纯函数工厂。
 *
 * 本模块零接线：只产出 ToolDef 与路由函数，不注册进任何工具面/投影/常驻清单；
 * R2/R3 的注册面按需消费。权限与身份的对齐方式：
 * - 权限类默认查 shared/hostTools meta（hostToolPermissionClass），逐 action 保留读/操作分档
 *   （如 browser 读类 read、操作类 browser）；调度面注册时可注入自己的 classOf。
 * - 身份绑定默认按 meta 的 actor/self 机械应用（与 workerBinding.bindWorkerToolArgs 同语义，
 *   不含其 ctx.sessions 补全）；接线时建议直接注入 bindWorkerToolArgs。
 * - 权限决策表（agentSession/tools/policy.ts decideToolCallPermission）不在纯工厂里复刻，
 *   通过 checkPermission 注入点由接线方接入（先展开后决策：policy.ts 的 run 分支同路径）。
 *
 * 文本全英文（R0 规约）；description 指向技能文档路径，路径是入参，工厂不落盘。
 */
import type { ToolDef } from './types';
import { ACTOR_SESSION_ID_ARG } from '../hosts/actors';
import { assertToolArguments } from '../schemaValidation';
import { hostToolBinding, hostToolPermissionClass } from '../../../shared/hostTools';
import type { HostToolBinding } from '../../../shared/hostTools';
import type { GuiToolPermissionClass } from '../../../shared/guiWorkerPolicy';
import { WORKFLOW_SKILL_PATH } from '../../../shared/workflowCommand';

/** 单个 action 的投影：动词 → 真实 catalog 工具 + 权限/绑定元数据 */
export interface RunToolAction {
  /** 动词（原工具名去掉域前缀），进入 run 入口的 action 枚举 */
  action: string;
  /** 真实 catalog 工具 id，如 'browser.click' / 'runs.delegate' */
  targetTool: string;
  def: ToolDef;
  /** 权限档（默认查 shared/hostTools meta；调度面工具不在 meta 中时为 undefined，由接线方注入） */
  permissionClass?: GuiToolPermissionClass;
  /** actor/self 身份绑定（默认查 shared/hostTools meta） */
  binding?: HostToolBinding;
}

/** 一个 run 域的完整产物：入口定义 + action 表 */
export interface RunToolDomain {
  /** run 入口名，如 'browser.run' / 'dispatch.run' */
  runName: string;
  /** catalog 域前缀（含点），如 'browser.' / 'runs.' */
  prefix: string;
  /** 技能文档路径；完整 schema 常驻的入口为空，不生成技能依赖。 */
  skillPath: string;
  /** 按 catalog 定义序排列的 action 投影 */
  actions: readonly RunToolAction[];
  /** 生成的 `X.run` ToolDef（本批次不注册到任何面） */
  def: ToolDef;
}

export interface RunToolDomainSpec {
  /** catalog 域前缀（含点），如 'browser.'、'runs.' */
  prefix: string;
  /** run 入口名；缺省 `${prefix}run`；改名场景如 runs.* → 'dispatch.run' */
  runName?: string;
  /** 英文一句话职责（嵌入生成的 description/summary） */
  purpose: string;
  /** 技能文档绝对路径提示（如 '~/.muster/skills/browser/SKILL.md'）；工厂不落盘 */
  skillPath: string;
  /** 显式动词白名单（与 exclude 互斥使用；列出的动词必须都存在，防拼写漂移） */
  include?: readonly string[];
  /** 排除的动词（留常驻直调的工具，如 llm.quota） */
  exclude?: readonly string[];
  /** 权限档来源；缺省 shared/hostTools 的 hostToolPermissionClass */
  classOf?: (targetTool: string) => GuiToolPermissionClass | undefined;
  /** 绑定来源；缺省 shared/hostTools 的 hostToolBinding */
  bindingOf?: (targetTool: string) => HostToolBinding | undefined;
}

/**
 * 从域内 ToolDef 列表构建 run 域。include/exclude 引用不存在的动词时报错（fail-fast，
 * 防规格与 catalog 漂移后静默产出错误枚举——枚举完整性由 test/run-factory.mjs 对账）。
 */
export function buildRunToolDomain(spec: RunToolDomainSpec, defs: readonly ToolDef[]): RunToolDomain {
  const prefix = spec.prefix.endsWith('.') ? spec.prefix : `${spec.prefix}.`;
  const runName = spec.runName ?? `${prefix}run`;
  const classOf = spec.classOf ?? hostToolPermissionClass;
  const bindingOf = spec.bindingOf ?? hostToolBinding;

  const byVerb = new Map<string, ToolDef>();
  for (const def of defs) {
    if (!def.name.startsWith(prefix)) continue;
    const verb = def.name.slice(prefix.length);
    if (!verb || verb.includes('.')) continue;
    if (byVerb.has(verb)) throw new Error(`[runFactory] duplicate tool verb '${def.name}' under prefix '${prefix}'`);
    byVerb.set(verb, def);
  }

  let verbs: string[];
  if (spec.include) {
    if (spec.exclude) throw new Error(`[runFactory] include and exclude are mutually exclusive for ${runName}`);
    const missing = spec.include.filter(verb => !byVerb.has(verb));
    if (missing.length) throw new Error(`[runFactory] ${runName} include lists unknown action(s): ${missing.join(', ')}`);
    // include 声明序即枚举序（便于按速查卡习惯排序），去重
    verbs = [...new Set(spec.include)];
  } else {
    const excluded = new Set(spec.exclude ?? []);
    const unknown = [...excluded].filter(verb => !byVerb.has(verb));
    if (unknown.length) throw new Error(`[runFactory] ${runName} exclude lists unknown action(s): ${unknown.join(', ')}`);
    verbs = [...byVerb.keys()].filter(verb => !excluded.has(verb));
  }

  const actions: RunToolAction[] = verbs.map(verb => {
    const targetTool = `${prefix}${verb}`;
    return { action: verb, targetTool, def: byVerb.get(verb)!, permissionClass: classOf(targetTool), binding: bindingOf(targetTool) };
  });

  const def: ToolDef = {
    name: runName,
    summary: spec.purpose,
    description:
      runName === 'browser.run'
        ? `${spec.purpose} Action parameters: read ${spec.skillPath}.`
        : `${spec.purpose} Parameters: ${spec.skillPath}.`,
    // 危险操作的确认门在真实目标 executor 上逐 action 生效（def.dangerous + ui.confirm），
    // run 入口本身只做路由，不重复标危险。
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...verbs]
        },
        params: {
          type: 'object',
          description: '{} if empty.'
        }
      },
      required: ['action', 'params']
    }
  };

  return { runName, prefix, skillPath: spec.skillPath, actions, def };
}

// ---------- run 调用解析：action 展开 + params 预检 ----------

export interface ResolvedRunToolCall {
  action: string;
  /** 展开出的真实 catalog 工具 id */
  targetTool: string;
  /** 校验通过后的参数（浅拷贝，不改动调用方对象） */
  args: Record<string, unknown>;
}

/**
 * 解析一次 run 调用：展开真实目标工具 + params 预检。
 * 失败一律抛可纠正的英文错误（未知 action 列全合法枚举；参数错误指出路径与期望）。
 */
export function resolveRunToolCall(domain: RunToolDomain, rawArgs: Record<string, unknown>): ResolvedRunToolCall {
  const validActions = domain.actions.map(entry => entry.action).join(', ');
  const action = rawArgs.action;
  if (typeof action !== 'string' || !action.trim()) {
    throw new Error(`${domain.runName} requires a string "action". Valid actions: ${validActions}.`);
  }
  const entry = domain.actions.find(item => item.action === action.trim());
  if (!entry) {
    throw new Error(`Unknown action "${action.trim()}" for ${domain.runName}. Valid actions: ${validActions}.`);
  }
  const params = rawArgs.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`${domain.runName} action "${entry.action}" requires "params" to be an object; pass {} when it takes no arguments.`);
  }
  const args = { ...(params as Record<string, unknown>) };
  assertToolArguments(entry.def.parameters as Record<string, unknown>, args, `${domain.runName} action "${entry.action}"`);
  return { action: entry.action, targetTool: entry.targetTool, args };
}

// ---------- 可注入 executor 的执行包装（本批次不接线） ----------

export interface RunToolPermissionDecision {
  allowed: boolean;
  /** denied 时的英文理由（透传给模型） */
  reason?: string;
}

export interface RunToolExecutorDeps<TContext = unknown> {
  /** 已认证的调用方会话 id；默认 actor/self 绑定应用需要它（缺失时 fail-closed） */
  sessionId?: string;
  /**
   * 身份绑定：默认按 action 元数据机械应用 actor/self（与 workerBinding.bindWorkerToolArgs
   * 同语义，另剥模型伪造的 __actorSessionId/__browserOwner）；接线时注入 bindWorkerToolArgs
   * 以获得 browser owner / ui.notify 的 ctx.sessions 补全。
   */
  bindArgs?: (targetTool: string, args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * 权限门（对齐 policy.ts decideToolCallPermission 的先展开后决策）：接线方注入；
   * 工厂默认放行，绝不在此内置三档表。
   */
  checkPermission?: (targetTool: string, args: Record<string, unknown>) => RunToolPermissionDecision;
  /** 执行展开出的真实 catalog 工具（唯一必填依赖） */
  execute: (targetTool: string, args: Record<string, unknown>, context: TContext) => unknown;
}

function applyIdentityBinding(
  domain: RunToolDomain,
  entry: RunToolAction,
  args: Record<string, unknown>,
  sessionId: string | undefined
): Record<string, unknown> {
  const out = { ...args };
  // 与 bindWorkerToolArgs 一致：先剥模型自报的身份字段
  delete out[ACTOR_SESSION_ID_ARG];
  delete out.__browserOwner;
  if (!entry.binding) return out;
  if (!sessionId) {
    throw new Error(`${entry.targetTool} via ${domain.runName} requires an authenticated caller identity (${entry.binding} binding); refusing unauthenticated call.`);
  }
  if (entry.binding === 'actor') {
    out[ACTOR_SESSION_ID_ARG] = sessionId;
  } else {
    out.sessionId = sessionId;
    delete out.externalSessionId;
  }
  return out;
}

/**
 * 执行一次 run 调用：resolve → 身份绑定 → 权限门 → 真实目标 executor。
 * 纯编排：权限/绑定/执行全部可注入，本模块不接线任何注册面。
 */
export async function executeRunToolCall<TContext = unknown>(
  domain: RunToolDomain,
  rawArgs: Record<string, unknown>,
  context: TContext,
  deps: RunToolExecutorDeps<TContext>
): Promise<unknown> {
  const resolved = resolveRunToolCall(domain, rawArgs);
  const entry = domain.actions.find(item => item.action === resolved.action)!;
  const bound = deps.bindArgs
    ? deps.bindArgs(resolved.targetTool, resolved.args)
    : applyIdentityBinding(domain, entry, resolved.args, deps.sessionId);
  if (deps.checkPermission) {
    const decision = deps.checkPermission(resolved.targetTool, bound);
    if (!decision.allowed) {
      throw new Error(`${domain.runName} → ${resolved.targetTool} denied: ${decision.reason ?? 'not permitted in the current session'}.`);
    }
  }
  return deps.execute(resolved.targetTool, bound, context);
}

// ---------- §2.3 run 化八域规格（数据；skill 路径按定案根目录 ~/.muster/skills/） ----------

/**
 * 九域技能的单一真源根（2026-10-22 定案：宿主自有目录，不进用户全局技能环境）。
 * 字面量带 `~/`；需要落盘的宿主模块（metaAgent/hostDomainSkills.ts）导入本常量并
 * resolveHostSkillRootDir() 换算绝对路径，禁止在别处抄第二份路径。
 */
export const SKILL_ROOT = '~/.muster/skills';

/**
 * 计划 §2.3 的八域规格。exclude 的动词留常驻直调（如 llm.quota）；
 * runs.* 域改名 dispatch.run。Runtime 注册仅接收声明式 Manifest。
 * 枚举完整性由 test/run-factory.mjs 与 catalog 真实定义对账。
 */
export const RUN_TOOL_DOMAIN_SPECS: readonly RunToolDomainSpec[] = [
  {
    prefix: 'browser.',
    purpose: 'Operate browser tabs and pages.',
    skillPath: `${SKILL_ROOT}/browser/SKILL.md`
  },
  {
    prefix: 'workflow.',
    purpose: 'Inspect and control scripted workflows.',
    skillPath: WORKFLOW_SKILL_PATH
  },
  {
    prefix: 'runtimes.',
    purpose: 'Manage agent CLI runtimes.',
    skillPath: `${SKILL_ROOT}/runtimes/SKILL.md`
  },
  {
    prefix: 'automations.',
    purpose: 'Manage scheduled prompt tasks.',
    skillPath: `${SKILL_ROOT}/automations/SKILL.md`
  },
  {
    prefix: 'themes.',
    purpose: 'Manage color themes.',
    skillPath: `${SKILL_ROOT}/themes/SKILL.md`
  },
  {
    prefix: 'runs.',
    runName: 'dispatch.run',
    purpose: 'Handle external CLI task runs.',
    skillPath: `${SKILL_ROOT}/dispatch/SKILL.md`
  },
  {
    prefix: 'llm.',
    purpose: 'Manage model providers and defaults.',
    skillPath: `${SKILL_ROOT}/llm/SKILL.md`,
    exclude: ['quota']
  },
  {
    prefix: 'extensions.',
    purpose: 'Inspect and author extensions bound to the caller workspace and project.',
    skillPath: `${SKILL_ROOT}/extensions/SKILL.md`
  },
  {
    // 低频且跨平台能力不确定：常驻整域 schema 不划算（5 个动作 ~4.6k 字符），
    // 收成域壳后由 desktop/SKILL.md 承载参数细节。
    prefix: 'desktop.',
    purpose: 'Read displays and windows and control the desktop where the current platform supports it.',
    skillPath: `${SKILL_ROOT}/desktop/SKILL.md`
  },
  {
    // 同 desktop：open 的 9 个 kind 分支常驻占 ~2.7k 字符，收成域壳。
    prefix: 'panel.',
    purpose: 'Read and arrange workspace panels, tabs and splits.',
    skillPath: `${SKILL_ROOT}/panel/SKILL.md`
  },
  {
    prefix: 'github.',
    purpose: 'Inspect GitHub pull requests, checks and diffs in your workspace, or open a PR and post a review with user confirmation.',
    skillPath: `${SKILL_ROOT}/github/SKILL.md`
  }
];

/** 便捷入口：按规格批量构建八域（或其子集） */
export function buildRunToolDomains(specs: readonly RunToolDomainSpec[], defs: readonly ToolDef[]): RunToolDomain[] {
  return specs.map(spec => buildRunToolDomain(spec, defs));
}
