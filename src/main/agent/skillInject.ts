import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/**
 * A2 skill 点名自动加载接线（zcode-adopt-batch-a S2.2）：
 * - 点名即加载：用户消息/派活简报显式点名 skill（精确名/别名）时自动装入 SKILL.md
 *   正文（等价 Skill 工具的 <skill> 块）；未点名不整目录注入正文。
 * - 审计：每次正文注入记 {skillId, chars, trigger, at, sessionId} 到本地 debug
 *   NDJSON（不进 UI 主文案）。
 * - 预算：单回合 skill 正文总注入 ≤20k；超限拒绝自动注入，显式 Skill 加载仍可
 *   但返回超预算警告。
 * 不改 Skill 工具按需读主路径语义；纯函数在 src/shared/skillInject.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SKILL_INJECT_TURN_BUDGET_CHARS,
  SkillTurnBudget,
  detectNamedSkills,
  formatSkillPointerBlock,
  parseSkillFrontmatterMeta,
  planNamedSkillInjection,
  mentionTokensOf,
  recordExplicitSkillLoad,
  skillBudgetWarning,
  skillInjectAudit,
  type SkillInjectAudit,
  type SkillMentionCandidate
} from '../../shared/skillInject';
import { expandSkillCommand, parseSkillCommand, stripSkillFrontmatter } from '../../shared/composerSkills';
import { listAgentSkills } from './skillsList';
import type { AgentSkillInfo } from '../../shared/types';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { assertSkillFileIdentity } from './skillSources';

export const SKILL_INJECT_LOG_NAME = 'skill-inject.ndjson';
const AUDIT_FILE_MAX_BYTES = 256 * 1024;

/** 审计账外送：NDJSON 追加到 userData/logs/skill-inject.ndjson（满 256KB 滚 .old） */
export function makeSkillAuditSink(
  userDataDir: string
): ((ev: SkillInjectAudit) => void) | null {
  const logsDir = userDataStorage(userDataDir).resolve('app', 'logs');
  const file = path.join(logsDir, SKILL_INJECT_LOG_NAME);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    return null;
  }
  return (ev) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > AUDIT_FILE_MAX_BYTES) {
        fs.rmSync(`${file}.old`, { force: true });
        fs.renameSync(file, `${file}.old`);
      }
      fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
    } catch {
      /* 审计失败不阻断主流程 */
    }
  };
}

/** 读 SKILL.md 正文（去 frontmatter）；失败返回 null */
export function readSkillBody(filePath: string): string | null {
  try {
    return stripSkillFrontmatter(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * SKILL.md 原文缓存（mtime+size 键控）：点名检测每条用户消息都要全量候选，
 * 未变文件不重复读盘/解析（复审：30 个 skill ≈ 每回合 100-250KB 同步 IO 属白做）。
 * 缓存键含 stat 指纹，文件改动自动失效；进程级（skill 数量本身有限）。
 */
const rawCache = new Map<string, { mtimeMs: number; size: number; raw: string }>();

function readSkillRawCached(filePath: string): string | null {
  try {
    const st = fs.statSync(filePath);
    const hit = rawCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.raw;
    const raw = fs.readFileSync(filePath, 'utf8');
    rawCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, raw });
    return raw;
  } catch {
    rawCache.delete(filePath);
    return null;
  }
}

/** 从 raw（含 frontmatter）解析 aliases / autoMention 并组装候选 */
function toCandidate(
  info: AgentSkillInfo,
  raw: string,
  body: string
): SkillMentionCandidate & { filePath: string; baseDir: string; body: string } {
  const meta = parseSkillFrontmatterMeta(raw);
  return {
    name: info.id ?? info.name,
    displayName: info.commandName ?? info.name,
    mentionName: info.name,
    ...(meta.aliases?.length ? { aliases: meta.aliases } : {}),
    ...(meta.autoMention ? { autoMention: meta.autoMention } : {}),
    filePath: info.filePath!,
    baseDir: info.baseDir!,
    body
  };
}

/** 载入清单里带 filePath 的 skill 的正文与别名（点名检测候选；未变文件走缓存） */
export function loadSkillCandidates(
  skills: readonly AgentSkillInfo[]
): Array<SkillMentionCandidate & { filePath: string; baseDir: string; body: string }> {
  const out: Array<
    SkillMentionCandidate & { filePath: string; baseDir: string; body: string }
  > = [];
  for (const s of skills) {
    if (!s.filePath || !s.baseDir) continue;
    assertSkillFileIdentity(s);
    const raw = readSkillRawCached(s.filePath);
    if (raw === null) continue;
    const body = stripSkillFrontmatter(raw);
    out.push(toCandidate(s, raw, body));
  }
  return out;
}

export interface SkillInjectHostDeps {
  listSkills: (cwd: string, context?: WorkspaceExecutionContext) => Promise<AgentSkillInfo[]>;
  audit?: (ev: SkillInjectAudit) => void;
  now?: () => number;
}

export interface SkillInjectResult {
  /** 追加进引擎文本的 skill 块（无点名或全被拒则空串） */
  appended: string;
  audits: SkillInjectAudit[];
  rejected: string[];
  warning: string | null;
}

function sourceChoices(skills: readonly AgentSkillInfo[]): string {
  return `【skill 来源】请明确选择技能来源：${skills.map(skill => `/skill:${skill.qualifiedName ?? skill.commandName ?? skill.name}`).join('、')}`;
}

function commandSkills(skills: readonly AgentSkillInfo[], name: string): AgentSkillInfo[] {
  const qualified = skills.filter(skill => skill.qualifiedName === name || skill.commandName === name);
  return qualified.length ? qualified : skills.filter(skill => skill.name === name);
}

/** Bare mentions are source-local; qualified mentions can explicitly choose another registered root. */
function namedCandidates(text: string, skills: readonly AgentSkillInfo[], context?: WorkspaceExecutionContext) {
  const selected = skills.filter(skill => !context || !skill.source?.rootIds?.length ||
    skill.source.rootIds.includes(context.sourceRootId) || !!skill.qualifiedName && text.includes(skill.qualifiedName));
  const candidates = loadSkillCandidates(selected);
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const info = selected.find(skill => (skill.id ?? skill.name) === candidate.name)!;
    const local = !context || !info.source?.rootIds?.length || info.source.rootIds.includes(context.sourceRootId);
    if (!local) { candidate.mentionName = ''; candidate.aliases = []; }
    if (info.qualifiedName) candidate.aliases = [...(candidate.aliases ?? []), info.qualifiedName];
    for (const token of new Set(mentionTokensOf(candidate).map(token => token.toLowerCase()))) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const ambiguous: AgentSkillInfo[] = [];
  for (const candidate of candidates) {
    const tokens = mentionTokensOf(candidate);
    if (tokens.some(token => counts.get(token.toLowerCase())! > 1 && detectNamedSkills(text, [{ name: token, autoMention: 'always' }]).length)) {
      ambiguous.push(selected.find(skill => (skill.id ?? skill.name) === candidate.name)!);
    }
    // The tokens have already passed autoMention/distinctiveness checks.
    candidate.mentionName = ''; candidate.aliases = tokens.filter(token => counts.get(token.toLowerCase()) === 1);
    candidate.autoMention = 'always';
  }
  return { candidates, warning: ambiguous.length ? sourceChoices(ambiguous) : null };
}

/**
 * 点名即加载（user-mention）：检测文本中显式点名的 skill，装预算、读正文、
 * 组装 <skill> 块。未点名返回空 appended（不整目录注入）。
 */
export async function applyNamedSkillInjection(
  text: string,
  opts: {
    cwd: string;
    workspaceContext?: WorkspaceExecutionContext;
    sessionId: string;
    budget: SkillTurnBudget;
    exclude?: readonly string[];
    deps?: SkillInjectHostDeps;
    at?: number;
  }
): Promise<SkillInjectResult> {
  const deps: SkillInjectHostDeps = opts.deps ?? { listSkills: listAgentSkills };
  const now = opts.at ?? deps.now?.() ?? Date.now();
  try {
    const skills = await deps.listSkills(opts.cwd, opts.workspaceContext);
    const { candidates, warning } = namedCandidates(text, skills, opts.workspaceContext);
    const plan = planNamedSkillInjection({
      text,
      skills: candidates,
      budget: opts.budget,
      sessionId: opts.sessionId,
      exclude: opts.exclude,
      at: now
    });
    for (const a of plan.audits) deps.audit?.(a);
    return {
      appended: plan.injection,
      audits: plan.audits,
      rejected: plan.rejected,
      warning: [warning, plan.warning].filter(Boolean).join('\n') || null
    };
  } catch (error) {
    return { appended: '', audits: [], rejected: [], warning: `【skill】${(error as Error).message}` };
  }
}

/**
 * 显式 Skill 加载（/skill:name 展开，等价 Skill 工具）：主路径语义不变——
 * 仍展开正文；追加审计与超预算警告（警告以注释行附在展开结果尾部，只进引擎）。
 */
export async function expandSkillTextWithBudget(
  text: string,
  opts: {
    cwd: string;
    workspaceContext?: WorkspaceExecutionContext;
    sessionId: string;
    budget: SkillTurnBudget;
    deps?: SkillInjectHostDeps;
    at?: number;
  }
): Promise<{ text: string; audit: SkillInjectAudit | null; warning: string | null }> {
  const parsed = parseSkillCommand(text);
  if (!parsed) return { text, audit: null, warning: null };
  const deps: SkillInjectHostDeps = opts.deps ?? { listSkills: listAgentSkills };
  const now = opts.at ?? deps.now?.() ?? Date.now();
  try {
    const skills = await deps.listSkills(opts.cwd, opts.workspaceContext);
    const hits = commandSkills(skills, parsed.name);
    if (hits.length > 1) {
      const warning = sourceChoices(hits);
      return { text: `${warning}\n\n${text}`, audit: null, warning };
    }
    const hit = hits[0];
    if (!hit && /^(root:|user\/|mode\/|project\/)/.test(parsed.name)) {
      const warning = `【skill 来源】技能来源已不可用：${parsed.name}`;
      return { text: `${warning}\n\n${text}`, audit: null, warning };
    }
    if (!hit) {
      // 普通名未命中不再静默当正文透传（skills 审计 F-01）：拼错名时模型与用户
      // 都能看到提示，与限定名未命中的警告对称。
      const warning = `【skill】未找到技能 ${parsed.name}；/skill: 不带来源前缀时仅匹配当前清单内名称`;
      return { text: `${warning}\n\n${text}`, audit: null, warning };
    }
    if (!hit.filePath || !hit.baseDir) return { text, audit: null, warning: null };
    assertSkillFileIdentity(hit);
    const raw = fs.readFileSync(hit.filePath, 'utf8');
    const body = stripSkillFrontmatter(raw);
    const expanded = expandSkillCommand(text, [
      { name: parsed.name, filePath: hit.filePath, baseDir: hit.baseDir, body }
    ]);
    const chars = expanded.length;
    const { audit, warning } = recordExplicitSkillLoad({
      skillId: hit.id ?? hit.name,
      chars,
      trigger: 'skill-tool',
      budget: opts.budget,
      sessionId: opts.sessionId,
      at: now
    });
    deps.audit?.(audit);
    return {
      text: warning ? `${expanded}\n\n${warning}` : expanded,
      audit,
      warning
    };
  } catch (error) {
    const warning = `【skill】${(error as Error).message}`;
    return { text: `${warning}\n\n${text}`, audit: null, warning };
  }
}

/**
 * 会话级回合预算簿：每会话一回合一枚，startTurn 新回合时重置。
 * 显式加载与点名自动注入共用同一预算。
 * 另记会话级「已注入过哪些 skill」——预算按回合重置，但同一 skill 的正文在一个
 * 会话里注入一次就够（引擎上下文已有），每条消息点到都重塞是纯浪费。
 */
export class SkillInjectTurnBook {
  private budgets = new Map<string, SkillTurnBudget>();
  private injected = new Map<string, Set<string>>();

  /** 新回合开始：重置该会话预算并返回 */
  beginTurn(sessionId: string, limit = SKILL_INJECT_TURN_BUDGET_CHARS): SkillTurnBudget {
    const b = new SkillTurnBudget(limit);
    this.budgets.set(sessionId, b);
    return b;
  }

  /** 取本回合预算（无则惰性建；steer/插话继续同一回合预算） */
  current(sessionId: string, limit = SKILL_INJECT_TURN_BUDGET_CHARS): SkillTurnBudget {
    let b = this.budgets.get(sessionId);
    if (!b) {
      b = new SkillTurnBudget(limit);
      this.budgets.set(sessionId, b);
    }
    return b;
  }

  /** 回合收口：丢弃预算（下次 beginTurn 重建）；已注入台账跨回合保留 */
  endTurn(sessionId: string): void {
    this.budgets.delete(sessionId);
  }

  /** 本会话已注入过正文的 skill 名（去重用） */
  injectedOf(sessionId: string): string[] {
    return [...(this.injected.get(sessionId) ?? [])];
  }

  /** 记下本次注入的 skill 名 */
  noteInjected(sessionId: string, skillIds: readonly string[]): void {
    if (!skillIds.length) return;
    let set = this.injected.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.injected.set(sessionId, set);
    }
    for (const id of skillIds) set.add(id);
  }

  /** 会话关闭/清空：丢预算与台账（否则 Map 随会话数无界增长） */
  forgetSession(sessionId: string): void {
    this.budgets.delete(sessionId);
    this.injected.delete(sessionId);
  }

  /** 测试/诊断：当前占用 */
  usedOf(sessionId: string): number {
    return this.budgets.get(sessionId)?.used ?? 0;
  }
}

/**
 * 派活简报点名：任务原文里点名的 skill 以「名 + 路径」指路块附在简报后
 * （A5 披露分级——Worker 自己能读 SKILL.md，简报不搬全文）。
 * 未点名时保持简报原文。
 */
export async function appendNamedSkillsToBrief(
  brief: string,
  task: string,
  opts: {
    cwd: string;
    workspaceContext?: WorkspaceExecutionContext;
    sessionId: string;
    budget: SkillTurnBudget;
    deps?: SkillInjectHostDeps;
    at?: number;
  }
): Promise<SkillInjectResult> {
  const deps = opts.deps ?? defaultDeps();
  const now = opts.at ?? deps.now?.() ?? Date.now();
  try {
    const skills = await deps.listSkills(opts.cwd, opts.workspaceContext);
    const command = parseSkillCommand(task);
    const explicit = command ? commandSkills(skills, command.name) : [];
    if (explicit.length > 1) {
      const warning = sourceChoices(explicit);
      return { appended: `${brief}\n\n${warning}`, audits: [], rejected: [], warning };
    }
    if (command && !explicit.length && /^(root:|user\/|mode\/|project\/)/.test(command.name)) {
      const warning = `【skill 来源】技能来源已不可用：${command.name}`;
      return { appended: `${brief}\n\n${warning}`, audits: [], rejected: [], warning };
    }
    if (command && !explicit.length) {
      // 普通名未命中不再静默（skills 审计 F-01）：与 expandSkillTextWithBudget
      // 的警告口径对称，拼错名时模型与用户都能看到提示。
      const warning = `【skill】未找到技能 ${command.name}；/skill: 不带来源前缀时仅匹配当前清单内名称`;
      return { appended: `${brief}\n\n${warning}`, audits: [], rejected: [], warning };
    }
    const mentionText = command?.args ?? task;
    const { candidates, warning } = namedCandidates(mentionText, skills, opts.workspaceContext);
    const named = detectNamedSkills(mentionText, candidates);
    const hits = named
      .map((n) => candidates.find((c) => c.name === n))
      .filter((c): c is (typeof candidates)[number] => !!c);
    if (explicit.length === 1 && !hits.some(hit => hit.name === (explicit[0].id ?? explicit[0].name))) {
      hits.push(...loadSkillCandidates(explicit));
    }
    const pointer = formatSkillPointerBlock(hits.map(hit => ({ name: hit.displayName ?? hit.name, filePath: hit.filePath })));
    if (!pointer) return { appended: warning ? `${brief}\n\n${warning}` : brief, audits: [], rejected: [], warning };
    const audits: SkillInjectAudit[] = hits.map((h) =>
      skillInjectAudit({
        skillId: h.name,
        chars: h.filePath.length,
        trigger: 'brief-pointer',
        sessionId: opts.sessionId,
        at: now
      })
    );
    for (const a of audits) deps.audit?.(a);
    return { appended: [brief, pointer, warning].filter(Boolean).join('\n\n'), audits, rejected: [], warning };
  } catch (error) {
    const warning = `【skill】${(error as Error).message}`;
    return { appended: `${brief}\n\n${warning}`, audits: [], rejected: [], warning };
  }
}

// ── 模块级默认装配（宿主 boot 时 setSkillAuditSink；测试可注入 deps 绕开） ──

let defaultAuditSink: ((ev: SkillInjectAudit) => void) | null = null;
const defaultBook = new SkillInjectTurnBook();

export function setSkillAuditSink(sink: ((ev: SkillInjectAudit) => void) | null): void {
  defaultAuditSink = sink;
}

export function skillTurnBook(): SkillInjectTurnBook {
  return defaultBook;
}

function defaultDeps(): SkillInjectHostDeps {
  return {
    listSkills: listAgentSkills,
    audit: defaultAuditSink ?? undefined
  };
}

export interface PrepareEngineTextResult {
  /** 发进引擎的最终文本（/skill:name 展开 + 点名 skill 块追加） */
  text: string;
  audits: SkillInjectAudit[];
  warning: string | null;
  /** 本次真正注入了正文的 skill 名（供会话级去重台账记账） */
  injectedIds: string[];
}

/**
 * 回合进引擎前的 skill 正文装配（用户消息 / 派活简报原文共用）：
 * 1) `/skill:name` 显式加载（skill-tool，主路径展开语义不变，仅追加审计/警告）；
 * 2) 其余文本里显式点名的 skill 自动加载（user-mention；未点名零注入）。
 * 两者共用 opts.budget（单回合 20k）；exclude 防 /skill: 与点名重复注入。
 * alreadyInjected（会话级台账）只挡自动点名——显式 /skill: 永远照办。
 */
export async function prepareEngineSkillText(
  text: string,
  opts: {
    cwd: string;
    workspaceContext?: WorkspaceExecutionContext;
    sessionId: string;
    budget: SkillTurnBudget;
    alreadyInjected?: readonly string[];
    target?: import('../../shared/capabilityManagement').CapabilityTargetId;
    deps?: SkillInjectHostDeps;
    at?: number;
  }
): Promise<PrepareEngineTextResult> {
  const deps = opts.deps ?? {
    ...defaultDeps(),
    listSkills: (cwd: string, context?: WorkspaceExecutionContext) => listAgentSkills(cwd, context, opts.target)
  };
  const slash = await expandSkillTextWithBudget(text, { ...opts, deps });
  if (slash.warning && !slash.audit) return { text: slash.text, audits: [], warning: slash.warning, injectedIds: [] };
  const exclude = [
    ...(opts.alreadyInjected ?? []),
    ...(slash.audit ? [slash.audit.skillId] : [])
  ];
  const named = await applyNamedSkillInjection(parseSkillCommand(text)?.args ?? text, {
    ...opts,
    deps,
    exclude
  });
  const parts = [slash.text];
  if (named.appended) parts.push(named.appended);
  // 点名被拒（预算尽）也要让模型知情：用户期望它用某技能，静默丢弃会让它无从解释
  if (named.warning) parts.push(named.warning);
  const audits = [...(slash.audit ? [slash.audit] : []), ...named.audits];
  const warning = slash.warning ?? named.warning;
  return {
    text: parts.filter(Boolean).join('\n\n'),
    audits,
    warning,
    injectedIds: audits.map((a) => a.skillId)
  };
}

export { SKILL_INJECT_TURN_BUDGET_CHARS, skillBudgetWarning };
export { SkillTurnBudget };
export type { SkillInjectAudit };
