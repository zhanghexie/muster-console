/**
 * C2 计划门（S2.2）：计划 = 结构化工具输入/契约文件 → 现有确认卡（ui.confirm）。
 * 批准 → 回灌「Approved Plan」+ 可选 allowedPrompts 预授权清单；空答案=拒绝；计划卡可回看。
 * 不引入 plan/build/edit 模式枚举（产品裁决），决策复用 B2 permission option 四态。
 * 纯契约 + 纯函数，主进程/渲染层共用；test/*.mjs 即时转译导入。
 */
import type { PlanStepView } from './types';
import type {
  PermissionDecision,
  PermissionGateOptions,
  PermissionPreview
} from './permissionOption';
import { extractPlanStepsLoose, firstPlanHeading, planMarkdownFromInput } from './planExtract';

/** 计划正文最小长度（再短的不是计划，拒绝） */
export const PLAN_MIN_LENGTH = 40;
/** allowedPrompts 清单上限（防预授权面失控） */
export const ALLOWED_PROMPTS_MAX = 20;
/** 单条预授权条目长度上限 */
export const ALLOWED_PROMPT_MAX = 200;

/** 计划来源：结构化工具输入（createPlan 等）或契约文件 */
export type PlanSourceKind = 'tool' | 'contractFile';

export interface PlanSubmission {
  source: PlanSourceKind;
  /** 工具名或契约文件路径 */
  origin: string;
  /** 计划全文 markdown（含标题行） */
  markdown: string;
  /** 提取的步骤（≤20，与 planExtract 一致） */
  steps: PlanStepView[];
  /** 可选预授权清单（批准后生效） */
  allowedPrompts: string[];
}

export type PlanRejectReason =
  | 'empty-plan'
  | 'empty-answer'
  | 'denied'
  | 'custom';

export interface PlanApprovalOutcome {
  approved: boolean;
  /** 批准时回灌给模型的「Approved Plan」文本 */
  feedback?: string;
  /** 批准后生效的预授权清单 */
  allowedPrompts?: string[];
  /** 拒绝原因（空答案 / 显式否决 / 自定义纠偏） */
  reason?: PlanRejectReason;
  /** kind=custom 时的纠偏文本（≤4096，随应答回灌调用方） */
  freeText?: string;
}

// ---------------------------------------------------------------------------
// 解析：结构化工具输入 / 契约文件
// ---------------------------------------------------------------------------

/** allowedPrompts 规范化：字符串数组，去空白、去重、截长、限量 */
export function normalizeAllowedPrompts(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, ALLOWED_PROMPT_MAX);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= ALLOWED_PROMPTS_MAX) break;
  }
  return out;
}

/**
 * 计划类工具输入 → PlanSubmission。
 * 计划正文：plan/markdown/content/text 字段优先（planMarkdownFromInput 同源）；
 * allowedPrompts 取同名字段。正文不足 PLAN_MIN_LENGTH → null（空计划=拒绝）。
 */
export function parsePlanSubmission(
  toolName: string,
  input: unknown
): PlanSubmission | null {
  const markdown = planMarkdownFromInput(input);
  if (!markdown || markdown.length < PLAN_MIN_LENGTH) return null;
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    source: 'tool',
    origin: toolName.trim() || 'plan-tool',
    markdown,
    steps: extractPlanStepsLoose(markdown),
    allowedPrompts: normalizeAllowedPrompts(rec.allowedPrompts ?? rec.allowed_prompts)
  };
}

/**
 * 契约文件内容 → PlanSubmission。文件全文即计划 markdown；
 * 可选 frontmatter/末尾「allowedPrompts:」清单行（`- item` / `* item`）。
 */
export function parsePlanContract(origin: string, text: string): PlanSubmission | null {
  const markdown = (text ?? '').trim();
  if (markdown.length < PLAN_MIN_LENGTH) return null;
  return {
    source: 'contractFile',
    origin: origin.trim() || 'plan-contract',
    markdown,
    steps: extractPlanStepsLoose(markdown),
    allowedPrompts: extractAllowedPromptsFromText(markdown)
  };
}

/** 从文本中抽 allowedPrompts 清单：`allowedPrompts:` 标题后的 `- item` / `* item` 行 */
export function extractAllowedPromptsFromText(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^allowedPrompts\s*[:：]/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (!line) {
      if (out.length) break;
      continue;
    }
    const m = /^[-*]\s+(.{1,200})$/.exec(line);
    if (m) {
      out.push(m[1]!.trim());
      if (out.length >= ALLOWED_PROMPTS_MAX) break;
      continue;
    }
    // 清单区结束（遇到非条目行）
    if (out.length) break;
  }
  return normalizeAllowedPrompts(out);
}

// ---------------------------------------------------------------------------
// 批准回灌：Approved Plan 文本
// ---------------------------------------------------------------------------

/**
 * 批准 → 回灌文本。含「Approved Plan」标记 + 计划全文；
 * 有预授权清单时附「Pre-authorized prompts」段（模型可见，后续 Bash 命中免再审）。
 */
export function buildApprovedPlanFeedback(sub: PlanSubmission): string {
  const parts = [`[Approved Plan]\n${sub.markdown.trim()}`];
  if (sub.allowedPrompts.length) {
    const list = sub.allowedPrompts.map((p) => `- ${p}`).join('\n');
    parts.push(`[Pre-authorized prompts]\n${list}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// 预授权匹配：allowedPrompts 命中 / 未命中
// ---------------------------------------------------------------------------

/** 命令规范化：trim + 折叠空白 + 小写（匹配不区分大小写） */
function normalizePrompt(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 命令/条目含 shell 元字符（分隔符/重定向/命令替换）→ 永不命中：预授权不得链式放大 */
const PROMPT_META_RE = /[;&|<>`$\r\n]/;

/**
 * 预授权命中判定：命令与清单条目等值，或命令以条目为**纯空白词边界**前缀
 * （`npm test` 命中 `npm test --watch`）。
 * 安全纪律（2026-09-27 复审收紧）：
 * - 命令或清单条目本身含 `; & | < > \` $ 换行` 等元字符 → 不命中
 *   （`npm test; rm -rf ~` 不得因前段命中而整链放行）；
 * - 边界只认空白：`npm test&&x`、`npm test; x`、`npm test|x` 一律不命中。
 * 返回命中的原始条目；未命中返回 undefined。
 */
export function matchAllowedPrompt(
  allowed: readonly string[],
  command: string
): string | undefined {
  if (!command || PROMPT_META_RE.test(command)) return undefined;
  const cmd = normalizePrompt(command);
  if (!cmd) return undefined;
  for (const raw of allowed) {
    if (!raw || PROMPT_META_RE.test(raw)) continue;
    const pat = normalizePrompt(raw);
    if (!pat) continue;
    if (cmd === pat) return raw;
    if (cmd.startsWith(pat) && /^\s/.test(cmd.slice(pat.length))) return raw;
  }
  return undefined;
}

/** 批量判定：返回所有命中的原始条目（去重保序） */
export function matchAllowedPrompts(
  allowed: readonly string[],
  commands: readonly string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    const hit = matchAllowedPrompt(allowed, c);
    if (hit && !seen.has(hit)) {
      seen.add(hit);
      out.push(hit);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 确认卡接线：计划 → ConfirmDialog 字段 / 应答 → 结果
// ---------------------------------------------------------------------------

/** 计划卡预览（复用 B2 permission option 的 generic 预览） */
export function buildPlanPreview(sub: PlanSubmission): PermissionPreview {
  const heading = firstPlanHeading(sub.markdown);
  const n = sub.steps.length;
  const label = heading
    ? n
      ? `${heading}（${n} 步）`
      : heading
    : n
      ? `计划（${n} 步）`
      : '计划';
  return { scope: 'generic', label };
}

/**
 * 计划审批卡字段（进现有 ui.confirm / ConfirmDialog）：
 * summary=计划全文（可回看）；permission 复用四态门（allowOnce/deny/custom），
 * 预授权清单在 confirmNote 列出。
 */
export function buildPlanApprovalGate(sub: PlanSubmission): {
  summary: string;
  confirmNote?: string;
  permission: PermissionGateOptions;
} {
  const preview = buildPlanPreview(sub);
  const note = sub.allowedPrompts.length
    ? `批准后预授权：${sub.allowedPrompts.join('、')}`
    : undefined;
  return {
    summary: sub.markdown,
    ...(note ? { confirmNote: note } : {}),
    permission: {
      preview,
      // 计划批准只走一次性放行 + 拒绝 + 自定义纠偏；不做 always（计划是一次性产物）
      kinds: ['allowOnce', 'deny', 'custom']
    }
  };
}

/**
 * 确认应答 → 计划审批结果。
 * - 计划为空 / 不足最小长度 → reject('empty-plan')（不进卡）
 * - 未确认（取消/Esc/超时/deny）→ reject('denied')
 * - kind=custom：freeText 为空 → reject('empty-answer')；否则带纠偏文本 reject('custom')
 * - kind=allowOnce/allowAlways → approved，回灌 Approved Plan + 预授权清单
 */
export function resolvePlanApproval(
  sub: PlanSubmission | null | undefined,
  decision: PermissionDecision | { confirmed: boolean; freeText?: string } | undefined
): PlanApprovalOutcome {
  if (!sub || !sub.markdown || sub.markdown.length < PLAN_MIN_LENGTH) {
    return { approved: false, reason: 'empty-plan' };
  }
  const d = normalizeDecision(decision);
  if (!d || !d.confirmed) {
    const freeText = d?.freeText?.trim();
    if (d?.kind === 'custom' && !freeText) return { approved: false, reason: 'empty-answer' };
    return {
      approved: false,
      reason: d?.kind === 'custom' ? 'custom' : 'denied',
      ...(freeText ? { freeText } : {})
    };
  }
  return {
    approved: true,
    feedback: buildApprovedPlanFeedback(sub),
    allowedPrompts: [...sub.allowedPrompts]
  };
}

function normalizeDecision(
  decision: PermissionDecision | { confirmed: boolean; freeText?: string } | undefined
): { confirmed: boolean; kind?: string; freeText?: string } | null {
  if (!decision || typeof decision !== 'object') return null;
  const o = decision as { confirmed?: unknown; kind?: unknown; freeText?: unknown };
  const kind = typeof o.kind === 'string' ? o.kind : undefined;
  const confirmed =
    o.confirmed === true || kind === 'allowOnce' || kind === 'allowAlways';
  const freeText = typeof o.freeText === 'string' && o.freeText ? o.freeText : undefined;
  return { confirmed, ...(kind ? { kind } : {}), ...(freeText ? { freeText } : {}) };
}
