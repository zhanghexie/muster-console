/**
 * 权限判定（主进程侧）：shared 纯决策表 + 会话模式 + 路径在工作区内外的实际判定（含 symlink 逃逸）。
 * 决策三值：auto 放行 / prompt 弹审批卡 / deny 直接拒绝并给模型理由（只读门控）。
 * 用户规则（`.muster/tool-rules.json`）叠在三档表之前：deny/ask/allow 短路；rewrite 改写入参后再走三档表。
 * C2 计划门：计划类工具强制 prompt（handlePlanApproval 挂批准回灌/预授权）；
 * 计划批准后的 allowedPrompts 预授权在此消费（严格命中 → shell prompt 转 auto）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceExecutionContext } from '../../../shared/workspaceExecutionContext';
import { pathInExecutionDirectories, pathWritableInContext } from '../../workspaceExecutionContext';
import type { GuiWorkerMode } from '../../../shared/types';
import { META_AGENT_DIR, META_AGENT_TOOL_RULES } from '../../../shared/metaAgent';
import { isPlanToolName } from '../../../shared/planExtract';
import { matchAllowedPrompt } from '../../../shared/planApproval';
import { hostToolPermissionClass } from '../../../shared/hostTools';
import { runToolDomainOf } from '../../capabilities/catalog/runTools';
import { desktopTurnGrants } from '../../desktop/turnGrant';
import { resolveRunToolCall } from '../../capabilities/catalog/runFactory';
import {
  decideToolPermission,
  decideWithUserToolRules,
  looksReadOnlyMcpTool,
  parseGuiUserToolRulesJson,
  type GuiPermissionDecision,
  type GuiToolPermissionClass,
  type GuiUserToolRule
} from '../../../shared/guiWorkerPolicy';

/** 常见路径参数名（Pi 原生用 path；Claude 风格用 file_path 等） */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'file', 'dir'] as const;
const EXTRA_PATH_KEYS = ['movePath', 'targetPath', 'new_path', 'old_path', 'notebook_path'] as const;

/** 引擎原生文件/壳工具名 → permissionClass（小写键；Pi 驼峰 / Claude PascalCase 都走 toLowerCase 查找） */
const NATIVE_CLASS: Record<string, GuiToolPermissionClass> = {
  read: 'read',
  read_image: 'read',
  edit: 'edit',
  write: 'edit',
  execute: 'shell',
  bash: 'shell',
  pwsh: 'shell',
  // 无 Git Bash 时 pi driver 把 bash 替换成自带 powershell（M-2）：策略分类必须认它，
  // 否则落「未知工具 → prompt」，硬守卫语义退化
  powershell: 'shell',
  grep: 'read',
  find: 'read',
  ls: 'read',
  glob: 'read',
  shell: 'shell',
  websearch: 'read',
  webfetch: 'read',
  semsearch: 'read',
  task: 'read',
  delete: 'edit',
  readlints: 'read',
  updatetodos: 'status',
  readtodos: 'read',
  askquestion: 'status',
  generateimage: 'edit',
  // Claude Code 原生（PascalCase 经 toLowerCase）
  multiedit: 'edit',
  notebookedit: 'edit',
  applypatch: 'edit',
  apply_patch: 'edit',
  bashoutput: 'read',
  killbash: 'shell',
  todowrite: 'status',
  exitplanmode: 'status',
  skill: 'read',
  slashcommand: 'read',
  taskoutput: 'read',
  taskstop: 'status',
  // Codex JSONL item.type（T5.1）
  command_execution: 'shell',
  file_change: 'edit',
  mcp_tool_call: 'mcp',
  web_search: 'read',
  todo_list: 'status'
};

function nativeClassOf(engineName: string): GuiToolPermissionClass | undefined {
  return NATIVE_CLASS[engineName] ?? NATIVE_CLASS[engineName.toLowerCase()];
}

/** 引擎侧工具名（可能下划线化）→ Host 工具点号名；未知返回 null */
function hostToolDotName(
  engineName: string,
  hostToolIds: readonly string[]
): string | null {
  for (const id of hostToolIds) {
    if (id === engineName || id.replace(/\./g, '_') === engineName) return id;
  }
  return null;
}

/** 动态扩展工具识别：ext.<id>.<name>（引擎侧点号可能被下划线化；短名不含下划线） */
function isDynamicEngineName(engineName: string): boolean {
  return engineName.replace(/_/g, '.').startsWith('ext.');
}

export function classifyToolName(
  engineName: string,
  hostToolIds: readonly string[],
  hostClassOf: (dotName: string) => GuiToolPermissionClass
): GuiToolPermissionClass | null {
  const hostId = hostToolDotName(engineName, hostToolIds);
  if (hostId) return hostClassOf(hostId);
  if (engineName.startsWith('mcp__')) return 'mcp';
  const native = nativeClassOf(engineName);
  if (native) return native;
  // 未注册进会话工具集的 ext.* 调用按动态类 fail-closed（审批），绝不裸放行
  if (isDynamicEngineName(engineName)) return 'dynamic';
  return null;
}

/** 从工具入参提取路径参数（无则 null） */
export function extractToolPath(input: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** All supplied file targets, including move destinations and multi-file patches. */
export function extractToolPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const collect = (row: Record<string, unknown>): void => {
    for (const key of [...PATH_KEYS, ...EXTRA_PATH_KEYS]) {
      const value = row[key];
      if (typeof value === 'string' && value.trim()) paths.push(value.trim());
    }
  };
  collect(input);
  for (const key of ['files', 'edits', 'changes', 'paths']) {
    const rows = input[key];
    if (Array.isArray(rows)) for (const row of rows) {
      if (typeof row === 'string' && row.trim()) paths.push(row.trim());
      else if (row && typeof row === 'object') collect(row as Record<string, unknown>);
    }
  }
  // Codex-style textual patches must preflight every file and Move-to destination.
  const patch = input.patch ?? input.patchText;
  if (typeof patch === 'string') for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1].trim());
  return [...new Set(paths)];
}

/**
 * 路径是否落在工作区根内（strict：realpath 防 symlink 逃逸版）。
 * 绝对/相对都相对 root 解析；对存在的最近祖先做 realpath，
 * 目标不存在的新文件取最近存在父目录判定。
 * 与 git/scan 的纯前缀版 isPathInsideWorkspace 同名不同义，故带 Strict 后缀防 import 混淆。
 */
export function isPathInsideWorkspaceStrict(candidate: string, root: string): boolean {
  try {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realProbe = fs.realpathSync(probe);
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    const rel = path.relative(realRoot, realProbe);
    if (!rel) return true;
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

export interface ToolCallPolicyInput {
  mode: GuiWorkerMode;
  planExecuting: boolean;
  engineToolName: string;
  input: Record<string, unknown>;
  cwd: string;
  /** 调用方会话 id：仅用于读取桌面回合授权（turnGrant），不参与其他判定。 */
  sessionId?: string;
  workspaceContext?: WorkspaceExecutionContext;
  /** Engine-specific expansion (Pi ~/file:, @ paths); no mutation of native arguments. */
  resolveFilePath?: (candidate: string) => string;
  /** Read-only exception for a Pi skill package admitted by the current resource loader. */
  allowSkillRead?: (candidate: string) => boolean;
  hostToolIds: readonly string[];
  hostClassOf: (dotName: string) => GuiToolPermissionClass;
  /**
   * 显式传入的用户规则（测试注入）；省略时从固定管理根热读，旧未归属会话取 cwd。
   * 传 `[]` = 明确无规则（跳过读盘）。
   */
  userRules?: readonly GuiUserToolRule[];
  /**
   * C2 计划批准后的会话级预授权清单（entry.planAllowedPrompts）。
   * shell 类 prompt 决策严格命中（等值/纯空白前缀、含元字符不命中）时转 auto；
   * 不越过 ask/plan 只读门的 deny。
   */
  allowedPrompts?: readonly string[];
}

export interface ToolCallPermissionResult {
  decision: GuiPermissionDecision;
  /** 经 rewrite 后的入参；无改写时与原 input 同引用或浅拷贝等价 */
  updatedInput: Record<string, unknown>;
  /** 命中用户规则时的理由（deny 文案优先用它） */
  ruleReason?: string;
  ruleId?: string;
}

/** 读工作区用户工具规则；缺文件/坏 JSON → []（fail-open） */
export function loadGuiUserToolRules(cwd: string): GuiUserToolRule[] {
  try {
    const file = path.join(cwd, META_AGENT_DIR, META_AGENT_TOOL_RULES);
    if (!fs.existsSync(file)) return [];
    return parseGuiUserToolRulesJson(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

type HostToolBoundaryInput = Omit<ToolCallPolicyInput, 'mode' | 'planExecuting' | 'allowedPrompts'>;
type ToolPolicyInput = ToolCallPolicyInput | (HostToolBoundaryInput & { native: true; checkDirectories: boolean });

/** 桌面写动作：与 `desktop/turnGrant` 覆盖的动作集合保持一致。 */
const DESKTOP_WRITE_TOOLS = new Set(['desktop.act', 'desktop.focus', 'desktop.launch']);

function resolveUserRules(input: HostToolBoundaryInput): readonly GuiUserToolRule[] {
  if (input.userRules !== undefined) return input.userRules;
  return loadGuiUserToolRules(input.workspaceContext?.controlRoot ?? input.cwd);
}

/** 一次工具调用的完整判定：未知工具 fail closed（prompt）；用户规则优先于三档表 */
export function decideToolCallPermission(input: ToolCallPolicyInput): ToolCallPermissionResult {
  return decideToolCallPermissionInner(input, false);
}

/** Applies only host-owned resource and explicit tool rules to external sessions. */
export function evaluateNativeToolBoundary(input: HostToolBoundaryInput, checkDirectories: boolean): ToolCallPermissionResult {
  return decideToolCallPermissionInner({ ...input, native: true, checkDirectories }, false);
}

function decideToolCallPermissionInner(input: ToolPolicyInput, alreadyExpanded: boolean): ToolCallPermissionResult {
  // R2 run 入口（browser.run…）：先展开后决策——权限档与用户规则都按真实目标
  // （browser.click…）判定，读类 action 在只读门（ask/plan）下仍 auto。
  // 展开失败（未知 action/参数错误）deny 并把可纠正的英文错误透传给模型。
  // （R5 退役 tools.call 后这是唯一的代理面展开路径。）
  const runDomain = alreadyExpanded ? undefined : runToolDomainOf(input.engineToolName);
  if (runDomain) {
    try {
      const resolved = resolveRunToolCall(runDomain, input.input);
      const permissionClass = hostToolPermissionClass(resolved.targetTool);
      if (!permissionClass) return { decision: 'deny', updatedInput: input.input, ruleReason: 'Unknown or non-proxyable target tool.' };
      const result = decideToolCallPermissionInner({ ...input, engineToolName: resolved.targetTool, input: resolved.args,
        hostToolIds: [...input.hostToolIds, resolved.targetTool], hostClassOf: name => name === resolved.targetTool ? permissionClass : input.hostClassOf(name) }, resolved.targetTool === runDomain.runName);
      return { ...result, updatedInput: { ...input.input, params: result.updatedInput } };
    } catch (error) {
      return { decision: 'deny', updatedInput: input.input, ruleReason: (error as Error).message };
    }
  }
  const pathAllowed = (candidate: string, writable: boolean): boolean => {
    try {
      const resolved = input.resolveFilePath?.(candidate) ?? candidate;
      const inScope = input.workspaceContext ? (writable ? pathWritableInContext(resolved, input.workspaceContext)
        : pathInExecutionDirectories(resolved, input.cwd, input.workspaceContext.readableDirectories))
        : isPathInsideWorkspaceStrict(resolved, input.cwd);
      return inScope || (!writable && input.engineToolName.toLowerCase() === 'read' && !!input.allowSkillRead?.(resolved));
    } catch { return false; }
  };
  const rules = resolveUserRules(input);
  const cls = classifyToolName(input.engineToolName, input.hostToolIds, input.hostClassOf);

  const baseDecide = (toolInput: Record<string, unknown>): GuiPermissionDecision => {
    if ('native' in input) return 'auto';
    if (!cls) return 'prompt';
    // C2 计划门：计划类工具（exit_plan_mode / createPlan 等）必须走审批卡
    //（handlePlanApproval 在批准时挂回灌与预授权）——不得按 status/read 类 auto 放行
    if (isPlanToolName(input.engineToolName)) return 'prompt';
    let pathInsideRoot: boolean | null = null;
    if (cls === 'edit' || cls === 'read') {
      const paths = extractToolPaths(toolInput);
      if (paths.length) pathInsideRoot = paths.every(p => pathAllowed(p, cls === 'edit'));
    }
    let mcpReadOnly = false;
    if (cls === 'mcp') {
      const action = String(toolInput.action ?? 'call');
      if (action !== 'call') mcpReadOnly = true;
      else {
        mcpReadOnly = looksReadOnlyMcpTool(
          String(toolInput.tool || input.engineToolName),
          String(toolInput.server ?? '')
        );
      }
    }
    const decision = decideToolPermission({
      mode: input.mode,
      planExecuting: input.planExecuting,
      permissionClass: cls,
      pathInsideRoot,
      mcpReadOnly,
      ...(cls === 'shell' ? { shellCommand: String(toolInput.command ?? '') } : {})
    });
    // 桌面写动作：桌面回合授权（turnGrant）绑回合代数 + 30 分钟，是本域更强的一道门。
    // 它有效时不再叠加工具审批卡；只把 prompt 降为 auto，不动 deny（plan/ask 仍拒绝）。
    if (decision === 'prompt' && cls === 'edit' && DESKTOP_WRITE_TOOLS.has(input.engineToolName) &&
        input.sessionId && desktopTurnGrants.current(input.sessionId)) return 'auto';
    // C2 预授权消费：shell 落到 prompt 且严格命中已批准清单 → auto
    //（只降 prompt 不动 deny；只读门控下的 deny 不被预授权越过）
    if (
      decision === 'prompt' &&
      cls === 'shell' &&
      // The new explicit approval modes always ask for commands; a plan's
      // earlier pre-authorization cannot silently weaken them after switching.
      input.mode !== 'standard' && input.mode !== 'accept-edits' && input.mode !== 'auto-review' &&
      input.allowedPrompts?.length &&
      matchAllowedPrompt(input.allowedPrompts, String(toolInput.command ?? ''))
    ) {
      return 'auto';
    }
    return decision;
  };

  const result = decideWithUserToolRules({
    rules,
    engineToolName: input.engineToolName,
    toolInput: input.input,
    baseDecide
  });
  // Apply after rewrite/allow too: user tool rules cannot grant a directory absent from the snapshot.
  if (('native' in input ? input.checkDirectories : !!input.workspaceContext) && (cls === 'edit' || cls === 'read')) {
    if (extractToolPaths(result.updatedInput).some(p => !pathAllowed(p, cls === 'edit'))) {
      return { ...result, decision: 'deny', ruleReason: 'The target path is outside this session\'s directory scope, or the directory is stale; create the session under the matching source root or repair the workspace directories.' };
    }
  }
  return result;
}
