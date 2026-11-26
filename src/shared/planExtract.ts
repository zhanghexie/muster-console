/**
 * 计划提取与计划类工具识别（纯函数，零运行时依赖）。
 * 服务两条计划捕获路径：
 * - 正文提取（pi 约定）：回复带「Plan:/计划」标题 + 编号步骤 → extractPlan；
 * - 工具提交（cursor createPlan 等计划类工具）：参数里的 markdown 即计划全文 →
 *   isPlanToolName + planMarkdownFromInput + extractPlanStepsLoose。
 * 调度 Agent（modeExtension）与 GUI Worker（host）共用；test/*.mjs 即时转译导入。
 */
import type { PlanStepView } from './types';

/** 计划标题行：「Plan:」「计划」「## 实施计划：xxx」等（行首，可带 # 前缀与冒号） */
const PLAN_TITLE_RE = /^#{0,4}\s*(?:plan|计划|实施计划|实施方案)\s*[::]?/i;

/**
 * 计划块终止：下一个顶级标题（h1/h2）或分隔线。
 * 步骤小节常用 ### 级（如「### 1. 接入层」），不能当块尾。
 */
const BLOCK_END_RE = /^(#{1,2}\s|-{3,}\s*$)/;

/** 编号步骤行：`1. xxx` / `1) xxx` / `### 1. xxx`（序号丢弃，按出现顺序重排） */
const STEP_LINE_RE = /^(?:#{1,6}\s*)?(\d{1,2})[.)]\s+(.{4,})\s*$/;

/** 复选框步骤行：`- [ ] xxx` / `- [x] xxx`（勾选视为已完成） */
const CHECKBOX_LINE_RE = /^[-*]\s+\[([xX ])\]\s+(.{4,})\s*$/;

/** 计划步骤上限（与旧 extractPlanSteps 一致，防超长回复刷卡） */
const MAX_STEPS = 20;

/** 从文本中顺序提取编号/复选框步骤（不要求计划标题行；工具提交的计划全文用） */
export function extractPlanStepsLoose(text: string): PlanStepView[] {
  const steps: PlanStepView[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const cb = CHECKBOX_LINE_RE.exec(line);
    if (cb) {
      steps.push({
        step: steps.length + 1,
        text: cb[2]!.trim(),
        completed: cb[1]!.trim() !== ''
      });
      continue;
    }
    const m = STEP_LINE_RE.exec(line);
    if (m) steps.push({ step: steps.length + 1, text: m[2]!.trim(), completed: false });
  }
  return steps.slice(0, MAX_STEPS);
}

export interface ExtractedPlan {
  /** 计划块原文 markdown（含标题行） */
  markdown: string;
  steps: PlanStepView[];
}

/**
 * 从回复正文提取计划块：标题行（Plan:/计划/实施计划/实施方案）起，
 * 至下一个顶级标题/分隔线/正文结尾，并截掉最后一个步骤行之后的尾随散文
 * （「以上。」这类收尾话不进卡）。无标题行或块内提不出步骤返回 null（不硬凑）。
 * 已知边界（与旧实现持平，有意取舍）：代码围栏内的伪计划同样命中（无 fence 感知）；
 * 全角序号（１.）/全角括号不识别；Setext 标题（===下划线）不终止块。
 */
export function extractPlan(text: string): ExtractedPlan | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PLAN_TITLE_RE.test(lines[i]!.trim())) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (BLOCK_END_RE.test(line)) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  // 步骤行/复选框行的出现顺序即步骤顺序；markdown 截到最后一个步骤行为止，
  // 步骤之间的说明行保留（在最后一个步骤之前），尾随散文丢弃
  let lastStep = -1;
  for (let i = block.length - 1; i >= 0; i--) {
    const line = block[i]!.trim();
    if (!line) continue;
    if (STEP_LINE_RE.test(line) || CHECKBOX_LINE_RE.test(line)) {
      lastStep = i;
      break;
    }
  }
  if (lastStep === -1) return null;
  const markdown = block.slice(0, lastStep + 1).join('\n').trim();
  return { markdown, steps: extractPlanStepsLoose(markdown) };
}

/** 扫描 [DONE:n] 标记，标记完成步骤；返回是否有更新（执行进度追踪共用） */
export function markCompletedSteps(text: string, steps: PlanStepView[]): boolean {
  let changed = false;
  const done = new Set(
    [...text.matchAll(/\[done[:：]\s*(\d{1,2})\]/gi)].map((m) => Number(m[1]))
  );
  if (done.size === 0) return false;
  for (const s of steps) {
    if (!s.completed && done.has(s.step)) {
      s.completed = true;
      changed = true;
    }
  }
  return changed;
}

/** 计划提交类工具名（小写比较；含常见别名与 createPlan 误拼容错；
 * 无下划线形态不可少——isPlanToolName 的归一化会剥 `.`/`-` 但**保留**下划线，
 * Claude 原生名 ExitPlanMode 归一后是 exitplanmode） */
const PLAN_TOOL_NAMES = new Set([
  'createplan',
  'create_plan',
  'creat_plan',
  'creatplan',
  'exitplanmode',
  'exit_plan_mode',
  'submitplan',
  'submit_plan',
  'presentplan',
  'present_plan',
  'writeplan',
  'write_plan',
  'saveplan',
  'save_plan',
  'plan_submit',
  'task_plan'
]);

export function isPlanToolName(name: string): boolean {
  return PLAN_TOOL_NAMES.has(name.trim().toLowerCase().replace(/[^a-z_]/g, ''));
}

/** 工具参数视为计划全文的最小长度（再短的不是计划，是备注） */
const PLAN_MARKDOWN_MIN = 40;

/** 计划类工具参数 → 计划 markdown：plan/markdown/content/text 字段优先，否则首个够长字符串 */
export function planMarkdownFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  for (const key of ['plan', 'markdown', 'content', 'text']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim().length >= PLAN_MARKDOWN_MIN) return v.trim();
  }
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.trim().length >= PLAN_MARKDOWN_MIN) return v.trim();
  }
  return null;
}

/** markdown 首个标题行文本（无标题返回 null）——计划类工具卡的友好标题用 */
export function firstPlanHeading(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1]!;
  }
  return null;
}
