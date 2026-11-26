/**
 * GUI Worker 工具审批策略（纯函数）：模式门控（default/ask/plan/auto）× permissionClass。
 * 模式体系与调度同源：ask / plan（非执行态）进入只读——edit/write 与 shell 写命令直接拒、
 * shell 只读白名单放行、MCP 写拒；plan 批准执行后（executing）门控解除。
 * 审批门（default/auto）shell 沿用执行权限自动放行；显式用户 ask/deny 与只读门保持有效。
 * tokenizer（切段/拆词）与命令特定危险检查同源合流在 bashReadonly（单一事实源，防两套分叉）。
 * 路径在工作区内外的判定（含 symlink 逃逸）由主进程侧包装完成，这里只收布尔。
 */
import {
  segmentHasDangerousCommandFlag,
  splitTopLevelSegments,
  unquotedTokens
} from './bashReadonly';
import type { GuiWorkerMode } from './types';

export { splitTopLevelSegments };

export type GuiToolPermissionClass = 'read' | 'edit' | 'shell' | 'status' | 'mcp' | 'dynamic' | 'browser';

/** ask/plan 门控下 shell 命令是否只读放行（唯一白名单，GUI Worker 与调度共用；原调度 SAFE_BASH_PREFIXES 已删）。
 * 规则：quote 感知按顶层操作符（; | && || & 换行）切段、逐段过前缀白名单；
 * 重定向仅放行 /dev/null（含 N>&M fd 复制）——堵「无空格重定向写文件」（grep x f >out.txt）绕过；
 * 命令替换（$( … )、反引号，含双引号内）、进程替换（<(/>)、未闭合引号一律 fail closed；
 * 未加引号的写词（rm/mv/cp/del/rmdir/mkdir/touch）拒；
 * 命令级专项（find/sed/awk/tree/git/rg/sort/date…，含引号包裹 flag 与 env/nice 等
 * wrapper 前缀）统一走 bashReadonly.segmentHasDangerousCommandFlag（单一事实源，
 * 与 default/auto 审批门同款——两门不再分叉）。
 * 已知边界（fail-closed 偏向，文档见 docs/features/gui-worker-session.md）：
 * awk action 内数值比较（$1>100）、here-doc 逐行切段、$((..>..)) 算术内比较也被拒。 */
export function isReadOnlyShellCommand(command: string): boolean {
  const segments = splitTopLevelSegments(command.trim());
  return segments.length > 0 && segments.every(isReadOnlySegment);
}

/** 未加引号的写动作词（段首前缀已限只读命令，这里挡的是参数位置偷带写命令） */
const READONLY_DANGEROUS_WORDS = new Set(['rm', 'mv', 'cp', 'del', 'rmdir', 'mkdir', 'touch']);

/** ask/plan 门控下单段是否只读：通用检查 + 命令级专项（与 default 门同源自 bashReadonly） */
function isReadOnlySegment(rawSegment: string): boolean {
  const seg = rawSegment.trim().toLowerCase();
  if (!seg) return false;
  for (const t of unquotedTokens(rawSegment.trim())) {
    if (READONLY_DANGEROUS_WORDS.has(t)) return false;
  }
  if (segmentHasDangerousCommandFlag(rawSegment)) return false;
  const prefixes = [
    'git status', 'git diff', 'git log', 'git show', 'git branch', 'git remote -v',
    'ls', 'dir', 'cat ', 'head ', 'tail ', 'grep ', 'rg ', 'find ', 'findstr ',
    'wc ', 'pwd', 'echo ', 'type ', 'sed -n ', 'awk ', 'stat ', 'file ', 'du ', 'tree'
  ];
  return prefixes.some((p) => seg.startsWith(p));
}

export type GuiPermissionDecision = 'auto' | 'prompt' | 'deny';

export interface GuiToolPermissionInput {
  /** 会话模式（调度同源 + auto） */
  mode: GuiWorkerMode;
  /** plan 批准执行中（门控解除、权限恢复 acceptEdits） */
  planExecuting?: boolean;
  permissionClass: GuiToolPermissionClass;
  /**
   * edit/write 类工具的路径是否落在会话工作区根（session.cwd，含 worktree）内。
   * null = 该工具无路径参数（或非路径类）。
   */
  pathInsideRoot?: boolean | null;
  /** MCP 工具是否判定为只读（按名称启发式） */
  mcpReadOnly?: boolean;
  /** shell 类工具的命令文本（只读门控下按白名单放行/拒绝） */
  shellCommand?: string;
}

/** 模式 → 派生执行权限（审批表用） */
export function derivePermissionMode(
  mode: GuiWorkerMode,
  planExecuting = false
): 'acceptEdits' | 'ask' | 'auto' {
  if (mode === 'auto') return 'auto';
  if (mode === 'default' || mode === 'accept-edits') return 'acceptEdits';
  if (mode === 'plan' && planExecuting) return 'acceptEdits';
  return 'ask';
}

/** 是否处于只读门控（ask，或 plan 非执行态） */
function readonlyGate(mode: GuiWorkerMode, planExecuting: boolean): boolean {
  return mode === 'ask' || (mode === 'plan' && !planExecuting);
}

/**
 * 决策（模式门控优先于审批表；deny = 直接拒绝并给模型理由，不弹卡）：
 * | 模式(默认/全自动/计划执行中) | 走原审批表：read/status/browser auto；区内 edit 自动；
 *   shell 自动放行（显式用户规则另判）；区外 edit 审批 |
 * | ask / plan(探索) | edit 与 MCP 写与 browser 动作 → deny；shell → 白名单放行否则 deny；read/status/MCP 只读 auto |
 */
export function decideToolPermission(input: GuiToolPermissionInput): GuiPermissionDecision {
  const { mode, permissionClass } = input;
  const planExecuting = !!input.planExecuting;

  if (readonlyGate(mode, planExecuting)) {
    if (permissionClass === 'edit') return 'deny';
    if (permissionClass === 'shell') {
      return isReadOnlyShellCommand(input.shellCommand ?? '') ? 'auto' : 'deny';
    }
    if (permissionClass === 'mcp') return input.mcpReadOnly ? 'auto' : 'deny';
    // 动态扩展工具在只读门控下一律拒绝（内容来自工作区文件，保守处理）
    if (permissionClass === 'dynamic') return 'deny';
    // browser 动作类只读门控下拒绝（「探索时别乱点」）；read 档的 tabs/snapshot 不受影响
    if (permissionClass === 'browser') return 'deny';
    return 'auto'; // read / status
  }

  // New IDs deliberately do not reinterpret existing default/ask/auto sessions.
  // The policy applies only to drivers whose native calls reach this gateway.
  if (mode === 'standard' || mode === 'accept-edits' || mode === 'auto-review') {
    if (permissionClass === 'read' || permissionClass === 'status') return 'auto';
    // MCP tool names are only heuristics, not trustworthy read-only metadata.
    // New modes therefore always ask; the legacy modes keep their old policy.
    if (mode === 'accept-edits' && permissionClass === 'edit' && input.pathInsideRoot === true) return 'auto';
    return 'prompt';
  }

  const perm = derivePermissionMode(mode, planExecuting);
  if (perm === 'auto') return 'auto';
  if (permissionClass === 'status' || permissionClass === 'read') return 'auto';
  // browser 动作类：正常干活不打断（用户决策 2026-09-11，与 09-07「无审批门」同旨；
  // 观察靠浏览器页实时可见 + agentState 状态条）
  if (permissionClass === 'browser') return 'auto';
  if (permissionClass === 'edit') {
    return perm === 'acceptEdits' && input.pathInsideRoot === true ? 'auto' : 'prompt';
  }
  if (permissionClass === 'shell') {
    return 'auto';
  }
  // 动态扩展工具：acceptEdits 模式也走审批（与 shell 同级，比内置 edit 更保守）
  if (permissionClass === 'dynamic') return 'prompt';
  // mcp
  if (perm === 'acceptEdits') return input.mcpReadOnly ? 'auto' : 'prompt';
  return 'prompt';
}

/** MCP 工具只读启发式：名字/描述含读取语义即视为只读（已知边界：无标准元数据） */
export function looksReadOnlyMcpTool(name: string, description?: string): boolean {
  const text = `${name} ${description ?? ''}`.toLowerCase();
  return /(^|[^a-z])(list|get|read|search|fetch|describe|query|view|show|find|stat|check|ping)([^a-z]|$)/.test(
    text
  );
}

// ---------------------------------------------------------------------------
// 用户自定义工具规则（数据面；配置 UI 不做）
// 文件约定：工作区 `.muster/tool-rules.json`
// 形状：工具名/参数模式 → allow | deny | ask | rewrite
// 叠加顺序（挂在三档决策表之前）：
//   1) 用户规则按数组顺序首条命中即生效（enabled=false 跳过）
//   2) deny → 确定性拦截（任何模式含 auto）
//   3) ask  → 强制 prompt
//   4) allow → 强制 auto（可越过 ask/plan 只读门控）
//   5) rewrite → 改写入参后落入下方三档表（不再继续匹配后续用户规则）
//   6) 未命中 → 原 decideToolPermission 三档表
// shell 的 command 参数匹配与 isReadOnlyShellCommand 同构：quote 感知切段 + 未加引号 token
// （grep 'rm -rf' f 不会命中 deny rm -rf）。deny/ask/rewrite 用段内「有序子序列」宽松语义防漏拦；
// action=allow 是提权口，改逐段全称——每个顶层段都须命中模式，链式命令不得借首段命中整链放行。
// ---------------------------------------------------------------------------

export type GuiUserToolRuleAction = 'allow' | 'deny' | 'ask' | 'rewrite';

export interface GuiUserToolRule {
  /** 可选稳定 id（测试/日志） */
  id?: string;
  /** 工具名（大小写不敏感；`*` 或省略=任意工具；点号/下划线等价） */
  tool?: string;
  /**
   * 参数模式：键=入参名，值=模式串。
   * - shell 的 `command` / `shellCommand`：引号感知 token 有序子序列（同构只读白名单切段）；
   *   action=allow 时逐段全称（每个顶层段都须命中，链式命令不整链放行）
   * - 其它参数：大小写不敏感子串；若值形如 `/regex/flags` 则按正则
   */
  params?: Record<string, string>;
  action: GuiUserToolRuleAction;
  /** action=rewrite 时合并进工具入参的字面量字段 */
  rewrite?: Record<string, string>;
  /** deny/ask 等理由（回模型/日志） */
  reason?: string;
  /** 缺省 true；false 跳过 */
  enabled?: boolean;
}

export interface GuiUserToolRulesFile {
  version?: number;
  rules?: unknown;
}

/** 归一化用户规则（非法条目丢弃；空数组=关闭） */
export function normalizeGuiUserToolRules(raw: unknown): GuiUserToolRule[] {
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as GuiUserToolRulesFile).rules)
  ) {
    list = (raw as GuiUserToolRulesFile).rules as unknown[];
  } else {
    return [];
  }
  const out: GuiUserToolRule[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<GuiUserToolRule>;
    const action = r.action;
    if (action !== 'allow' && action !== 'deny' && action !== 'ask' && action !== 'rewrite') continue;
    const params: Record<string, string> = {};
    if (r.params && typeof r.params === 'object' && !Array.isArray(r.params)) {
      for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) params[k] = v.trim();
      }
    }
    const rewrite: Record<string, string> = {};
    if (r.rewrite && typeof r.rewrite === 'object' && !Array.isArray(r.rewrite)) {
      for (const [k, v] of Object.entries(r.rewrite as Record<string, unknown>)) {
        if (typeof v === 'string') rewrite[k] = v;
      }
    }
    if (action === 'rewrite' && !Object.keys(rewrite).length) continue;
    out.push({
      ...(typeof r.id === 'string' && r.id.trim() ? { id: r.id.trim() } : {}),
      ...(typeof r.tool === 'string' && r.tool.trim() ? { tool: r.tool.trim() } : {}),
      ...(Object.keys(params).length ? { params } : {}),
      action,
      ...(Object.keys(rewrite).length ? { rewrite } : {}),
      ...(typeof r.reason === 'string' && r.reason.trim() ? { reason: r.reason.trim() } : {}),
      enabled: r.enabled !== false
    });
  }
  return out;
}

/** 解析 `.muster/tool-rules.json` 文本；坏 JSON → []（fail-open，等同无规则） */
export function parseGuiUserToolRulesJson(text: string): GuiUserToolRule[] {
  try {
    return normalizeGuiUserToolRules(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

const SHELL_PARAM_KEYS = new Set(['command', 'shellcommand']);

/**
 * shell 命令参数是否命中模式（与 isReadOnlyShellCommand 同构的切段/拆词）。
 * 缺省（deny/ask/rewrite 沿用的宽松语义，防漏拦）：模式分词须在某一顶层段的**未加引号**
 * token 中按序出现（可不相邻——便于拦 `git push origin --force`）。
 * opts.requireAllSegments（allow 规则专用）：改为**每一顶层段**都须命中——allow 是提权口，
 * `npm test && rm -rf x` 不得因首段命中而整链放行。
 * 引号未闭合等异常 → 不命中（规则不生效；随后仍走三档表 / fail-closed 只读门）。
 * 模式形如 `/regex/flags` 时对「未加引号 token 空格拼接」做正则（整段拼接，跨段不拼）。
 */
export function shellCommandMatchesParamPattern(
  command: string,
  pattern: string,
  opts?: { requireAllSegments?: boolean }
): boolean {
  const pat = pattern.trim();
  if (!pat) return false;
  const segments = splitTopLevelSegments(command.trim());
  if (!segments.length) return false;
  const asRegex = tryParseRegexLiteral(pat);
  const every = opts?.requireAllSegments === true;
  if (asRegex) {
    const hit = (seg: string): boolean => asRegex.test(unquotedTokens(seg).join(' '));
    return every ? segments.every(hit) : segments.some(hit);
  }
  const want = pat.toLowerCase().split(/\s+/).filter(Boolean);
  if (!want.length) return false;
  const hit = (seg: string): boolean =>
    hasOrderedSubsequence(unquotedTokens(seg).map((t) => t.toLowerCase()), want);
  return every ? segments.every(hit) : segments.some(hit);
}

function tryParseRegexLiteral(pat: string): RegExp | null {
  if (pat.length < 2 || pat[0] !== '/') return null;
  const last = pat.lastIndexOf('/');
  if (last <= 0) return null;
  const body = pat.slice(1, last);
  const flags = pat.slice(last + 1);
  if (!/^[gimsuy]*$/.test(flags)) return null;
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

function hasOrderedSubsequence(tokens: string[], want: string[]): boolean {
  let i = 0;
  for (const t of tokens) {
    if (t === want[i]) {
      i++;
      if (i === want.length) return true;
    }
  }
  return false;
}

function normalizeToolKey(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '.');
}

/** 工具名是否匹配规则（`*` / 省略 = 任意；点号与下划线等价） */
export function toolNameMatchesRule(ruleTool: string | undefined, engineToolName: string): boolean {
  if (!ruleTool || ruleTool === '*') return true;
  return normalizeToolKey(ruleTool) === normalizeToolKey(engineToolName);
}

/** 单条规则是否命中（tool + 全部 params 均需满足；无 params = 只按工具名） */
export function userToolRuleMatches(
  rule: GuiUserToolRule,
  engineToolName: string,
  toolInput: Record<string, unknown>
): boolean {
  if (rule.enabled === false) return false;
  if (!toolNameMatchesRule(rule.tool, engineToolName)) return false;
  const params = rule.params;
  if (!params || !Object.keys(params).length) return true;
  for (const [key, pattern] of Object.entries(params)) {
    const raw = toolInput[key];
    const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
    if (SHELL_PARAM_KEYS.has(key.toLowerCase())) {
      if (
        !shellCommandMatchesParamPattern(text, pattern, {
          requireAllSegments: rule.action === 'allow'
        })
      )
        return false;
      continue;
    }
    const re = tryParseRegexLiteral(pattern);
    if (re) {
      if (!re.test(text)) return false;
      continue;
    }
    if (!text.toLowerCase().includes(pattern.toLowerCase())) return false;
  }
  return true;
}

export type GuiUserToolRuleHit =
  | { action: 'allow'; rule: GuiUserToolRule }
  | { action: 'deny'; rule: GuiUserToolRule }
  | { action: 'ask'; rule: GuiUserToolRule }
  | {
      action: 'rewrite';
      rule: GuiUserToolRule;
      updatedInput: Record<string, unknown>;
    };

/**
 * 用户规则首条命中（数组顺序=优先级）。无命中返回 null。
 * rewrite 产出合并后的 updatedInput，调用方应改用该入参再走三档表。
 */
export function matchUserToolRules(
  rules: readonly GuiUserToolRule[] | undefined | null,
  engineToolName: string,
  toolInput: Record<string, unknown>
): GuiUserToolRuleHit | null {
  if (!rules?.length) return null;
  for (const rule of rules) {
    if (!userToolRuleMatches(rule, engineToolName, toolInput)) continue;
    if (rule.action === 'rewrite') {
      return {
        action: 'rewrite',
        rule,
        updatedInput: { ...toolInput, ...(rule.rewrite ?? {}) }
      };
    }
    return { action: rule.action, rule };
  }
  return null;
}

/**
 * 用户规则 → 决策表叠加：命中 allow/deny/ask 直接映射；rewrite 后对改写入参跑 baseDecide；
 * 未命中则 baseDecide(原入参)。baseDecide 即现有三档表（通常 decideToolPermission）。
 */
export function decideWithUserToolRules(args: {
  rules: readonly GuiUserToolRule[] | undefined | null;
  engineToolName: string;
  toolInput: Record<string, unknown>;
  baseDecide: (toolInput: Record<string, unknown>) => GuiPermissionDecision;
}): {
  decision: GuiPermissionDecision;
  updatedInput: Record<string, unknown>;
  ruleReason?: string;
  ruleId?: string;
} {
  const hit = matchUserToolRules(args.rules, args.engineToolName, args.toolInput);
  if (!hit) {
    return {
      decision: args.baseDecide(args.toolInput),
      updatedInput: args.toolInput
    };
  }
  const meta = {
    ...(hit.rule.reason ? { ruleReason: hit.rule.reason } : {}),
    ...(hit.rule.id ? { ruleId: hit.rule.id } : {})
  };
  if (hit.action === 'deny') {
    return { decision: 'deny', updatedInput: args.toolInput, ...meta };
  }
  if (hit.action === 'ask') {
    return { decision: 'prompt', updatedInput: args.toolInput, ...meta };
  }
  if (hit.action === 'allow') {
    return { decision: 'auto', updatedInput: args.toolInput, ...meta };
  }
  // rewrite → 三档表
  if (hit.action === 'rewrite') {
    return {
      decision: args.baseDecide(hit.updatedInput),
      updatedInput: hit.updatedInput,
      ...meta
    };
  }
  return {
    decision: args.baseDecide(args.toolInput),
    updatedInput: args.toolInput,
    ...meta
  };
}
