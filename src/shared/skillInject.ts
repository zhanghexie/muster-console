/**
 * A2 skill 渐进披露加固（zcode-adopt-batch-a S2.2）纯函数层：
 * 点名检测（精确名/别名）、单回合正文预算、加载审计记录与超预算警告文案。
 * 主进程接线见 src/main/agent/skillInject.ts；不改 Skill 工具按需读主路径语义。
 */
import { formatSkillExpansion } from './composerSkills';

/** 单回合 skill 正文总注入上限（字符）；超限拒绝后续自动注入 */
export const SKILL_INJECT_TURN_BUDGET_CHARS = 20_000;

export type SkillInjectTrigger = 'user-mention' | 'skill-tool' | 'auto' | 'brief-pointer';

/**
 * frontmatter `x-muster-automention`：
 * - `always` 短名也允许 bare 点名自动注入（自担误伤风险）；
 * - `never` 完全关掉自动注入（只认 `/skill:name`）。
 * 缺省按 isDistinctiveSkillToken 判定。
 */
export type SkillAutoMention = 'always' | 'never';

/** 每次正文注入的审计记录（本地 debug/journal 通道，不进 UI 主文案） */
export interface SkillInjectAudit {
  skillId: string;
  chars: number;
  trigger: SkillInjectTrigger;
  at: number;
  sessionId: string;
}

/** 点名检测候选（清单条目；aliases / autoMention 来自 SKILL.md frontmatter，可空） */
export interface SkillMentionCandidate {
  name: string;
  /** Physical identity can differ from the visible/mentioned name. */
  displayName?: string;
  mentionName?: string;
  aliases?: readonly string[];
  autoMention?: SkillAutoMention;
}

/**
 * 从 SKILL.md frontmatter 抽 name / aliases / autoMention（YAML 子集：`key: value` 行）。
 * aliases 支持逗号分隔或 `[a, b]` 数组字面量。无 frontmatter 时返回空对象。
 */
export function parseSkillFrontmatterMeta(content: string): {
  name?: string;
  aliases?: string[];
  autoMention?: SkillAutoMention;
} {
  const normalized = (content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return {};
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return {};
  const fm = normalized.slice(3, endIndex);
  let name: string | undefined;
  let aliases: string[] | undefined;
  let autoMention: SkillAutoMention | undefined;
  for (const line of fm.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    const raw = m[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'name' && raw) name = raw;
    if (key === 'x-muster-automention') {
      const v = raw.toLowerCase();
      if (v === 'always' || v === 'never') autoMention = v;
    }
    if (key === 'aliases' && raw) {
      const inner = raw.replace(/^\[/, '').replace(/\]$/, '');
      aliases = inner
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
  }
  return {
    ...(name ? { name } : {}),
    ...(aliases?.length ? { aliases } : {}),
    ...(autoMention ? { autoMention } : {})
  };
}

/**
 * 该 token 是否「够辨识」，可以用裸词做自动点名。
 *
 * 单个 ASCII 常用词当触发词误伤率太高：各 CLI 自带的 skill 名大量是 review /
 * loop / goal / shell / share 这类日常词，用户随口一句「帮我 review 一下」就会
 * 把整篇 SKILL.md 塞进上下文。故裸词只认多词连写（含 `-`/`_`）或含非 ASCII
 * （中文别名）的名字；短名要么 frontmatter 写 `x-muster-automention: always`
 * 明示自担风险，要么改用 `/skill:name` 显式加载。
 */
export function isDistinctiveSkillToken(token: string): boolean {
  const t = (token ?? '').trim();
  if (!t) return false;
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007F]/.test(t)) return true;
  if (/^root:[^/]+\/[^/]+$/.test(t)) return true;
  return /[-_]/.test(t);
}

/** 该 skill 允许裸词自动点名的 token（名 + 别名，按 autoMention 与辨识度过滤） */
export function mentionTokensOf(skill: SkillMentionCandidate): string[] {
  if (skill.autoMention === 'never') return [];
  const all = [skill.mentionName ?? skill.name, ...(skill.aliases ?? [])]
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter(Boolean);
  if (skill.autoMention === 'always') return all;
  return all.filter(isDistinctiveSkillToken);
}

/**
 * 显式点名检测：skill 精确名或别名以独立词形式出现在文本中。
 * 词边界用 [A-Za-z0-9_-] 两侧否定断言（连字符是名字一部分，如 perf-trace）。
 * 只有 mentionTokensOf 放行的 token 参与匹配（避免常用词误伤）。
 * 返回命中的 skill 名（按候选表顺序，去重）。
 */
export function detectNamedSkills(
  text: string,
  skills: readonly SkillMentionCandidate[]
): string[] {
  const source = text ?? '';
  if (!source.trim() || !skills.length) return [];
  const out: string[] = [];
  for (const s of skills) {
    const hit = mentionTokensOf(s).some((n) => {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![A-Za-z0-9_/:-])${esc}(?![A-Za-z0-9_/-])`, 'i');
      return re.test(source);
    });
    if (hit) out.push(s.name);
  }
  return out;
}

/**
 * 单回合 skill 正文预算账本（会话内一回合一枚）。
 * 自动注入 canFit→consume；显式加载 note（可超限，用于警告）。
 */
export class SkillTurnBudget {
  readonly limit: number;
  private usedChars = 0;

  constructor(limit: number = SKILL_INJECT_TURN_BUDGET_CHARS) {
    this.limit = Math.max(0, limit);
  }

  get used(): number {
    return this.usedChars;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.usedChars);
  }

  canFit(chars: number): boolean {
    return this.usedChars + Math.max(0, chars) <= this.limit;
  }

  /** 自动注入消费；超限拒绝且不占用（返回 false） */
  consume(chars: number): boolean {
    const n = Math.max(0, chars);
    if (this.usedChars + n > this.limit) return false;
    this.usedChars += n;
    return true;
  }

  /** 显式加载记账：总是放行并计入占用（可超限）；返回是否已超限 */
  note(chars: number): boolean {
    this.usedChars += Math.max(0, chars);
    return this.usedChars > this.limit;
  }
}

export function skillInjectAudit(input: {
  skillId: string;
  chars: number;
  trigger: SkillInjectTrigger;
  sessionId: string;
  at?: number;
}): SkillInjectAudit {
  return {
    skillId: input.skillId,
    chars: Math.max(0, Math.floor(input.chars)),
    trigger: input.trigger,
    at: input.at ?? Date.now(),
    sessionId: input.sessionId
  };
}

/** 超预算警告（显式 Skill 加载仍放行时附带；自动注入被拒时也用它留痕） */
export function skillBudgetWarning(used: number, limit: number): string {
  return `【skill 预算】本回合 skill 正文注入已达 ${used}/${limit} 字符预算；后续自动注入被拒。显式 Skill 加载仍可用，但请注意上下文占用。`;
}

/** 点名自动注入块（等价 Skill 工具的 <skill> 形态；无 args） */
export function formatNamedSkillBlock(skill: {
  name: string;
  displayName?: string;
  filePath: string;
  baseDir: string;
  body: string;
}): string {
  return formatSkillExpansion({ ...skill, name: skill.displayName ?? skill.name }, skill.body, '');
}

/**
 * 派活简报的点名技能「指路块」（A5 披露分级：给路径不给全文）。
 * Worker 自己就能发现/读取 SKILL.md（`.agents/skills` 已链到各 CLI 目录），
 * 把正文整段抄进简报只是重复烧 token；GUI Worker 的回合装配仍会按需注入正文。
 */
export function formatSkillPointerBlock(
  skills: ReadonlyArray<{ name: string; filePath: string }>
): string {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}：${s.filePath}`);
  return `【点名技能】本任务点名了以下技能，按需自行读取 SKILL.md（勿整段复制进上下文）：\n${lines.join('\n')}`;
}

export interface NamedSkillInjectPlan {
  /** 注入正文（多个 skill 依次拼接，空=无点名或全部被拒） */
  injection: string;
  /** 本次成功注入的审计 */
  audits: SkillInjectAudit[];
  /** 被预算拒绝的 skill 名（user-mention 自动注入） */
  rejected: string[];
  /** 超预算警告（有拒绝时非空） */
  warning: string | null;
}

/**
 * 点名即加载计划：对文本里显式点名的 skill 逐个装入预算并组装注入块。
 * - 未点名 → injection 空（不整目录注入）；
 * - 超预算 → 自动注入拒绝（记入 rejected），后续点名同样拒绝；
 * - trigger=user-mention（本函数）；skill-tool 路径由 recordExplicitSkillLoad 记账。
 * exclude：已通过 /skill:name 等路径加载过的 skill 名，避免重复注入。
 */
export function planNamedSkillInjection(input: {
  text: string;
  skills: ReadonlyArray<
    SkillMentionCandidate & { filePath?: string; baseDir?: string; body?: string }
  >;
  budget: SkillTurnBudget;
  sessionId: string;
  exclude?: readonly string[];
  at?: number;
}): NamedSkillInjectPlan {
  const excluded = new Set(input.exclude ?? []);
  const named = detectNamedSkills(input.text, input.skills).filter((n) => !excluded.has(n));
  const parts: string[] = [];
  const audits: SkillInjectAudit[] = [];
  const rejected: string[] = [];
  for (const name of named) {
    const s = input.skills.find((x) => x.name === name);
    if (!s?.filePath || !s.baseDir || s.body == null) continue;
    const block = formatNamedSkillBlock({
      name: s.name,
      displayName: s.displayName,
      filePath: s.filePath,
      baseDir: s.baseDir,
      body: s.body
    });
    const chars = block.length;
    if (!input.budget.canFit(chars)) {
      rejected.push(s.name);
      continue;
    }
    input.budget.consume(chars);
    parts.push(block);
    audits.push(
      skillInjectAudit({
        skillId: s.name,
        chars,
        trigger: 'user-mention',
        sessionId: input.sessionId,
        at: input.at
      })
    );
  }
  const warning = rejected.length > 0 ? skillBudgetWarning(input.budget.used, input.budget.limit) : null;
  return {
    injection: parts.join('\n\n'),
    audits,
    rejected,
    warning
  };
}

/**
 * 显式 Skill 加载（/skill:name 或 Skill 工具）预算检查：仍放行正文，
 * 但超预算时附带警告（与自动注入「拒绝」策略区分）。
 */
export function recordExplicitSkillLoad(input: {
  skillId: string;
  chars: number;
  trigger?: SkillInjectTrigger;
  budget: SkillTurnBudget;
  sessionId: string;
  at?: number;
}): { audit: SkillInjectAudit; warning: string | null } {
  const trigger = input.trigger ?? 'skill-tool';
  const audit = skillInjectAudit({
    skillId: input.skillId,
    chars: input.chars,
    trigger,
    sessionId: input.sessionId,
    at: input.at
  });
  const over = input.budget.note(input.chars);
  return {
    audit,
    warning: over ? skillBudgetWarning(input.budget.used, input.budget.limit) : null
  };
}
